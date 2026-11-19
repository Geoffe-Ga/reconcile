import { describe, expect, it } from 'vitest';

import { ortWasm } from '../test/ortWasm';
import {
  TINY_DIMENSIONS,
  TINY_TYPE_LOGITS,
  TINY_VOCAB,
  tinyClassifierOnnx,
  tinyLogitsOf,
  tinyModelOnnx,
  tinyTokenizerJson,
  tinyVectorOf,
} from '../test/tinyModel';
import { MAX_TOKENS, type RuntimeFiles, startEncoder, startPairClassifier } from './runtime';

const WASM = ortWasm();

/** The tiny model's files (`src/test/tinyModel.ts`) with the real runtime. */
function tinyFiles(model = tinyModelOnnx()): RuntimeFiles {
  return { model, tokenizer: new TextEncoder().encode(tinyTokenizerJson()), runtime: WASM };
}

/** `token`'s id in the tiny vocabulary. */
function id(token: string): number {
  return TINY_VOCAB.indexOf(token);
}

/** Token `i` of sentence `s`'s state, from `data` laid out as [sentences, tokens, dimensions]. */
function stateAt(data: Float32Array, tokens: number, s: number, i: number): number[] {
  const start = (s * tokens + i) * TINY_DIMENSIONS;
  return Array.from(data.subarray(start, start + TINY_DIMENSIONS));
}

describe('startEncoder (#476)', () => {
  it('tokenizes like BERT and runs the model, padding a batch to its longest sentence', async () => {
    const encoder = await startEncoder(tinyFiles());

    const states = await encoder.encode(['Keep the reading room open.', 'Our chess boards']);

    const first = ['[CLS]', 'keep', 'the', 'reading', 'room', 'open', '.', '[SEP]'];
    const second = ['[CLS]', 'our', 'chess', 'board', '##s', '[SEP]'];
    expect(states).toMatchObject({
      sentences: 2,
      tokens: first.length,
      dimensions: TINY_DIMENSIONS,
    });
    expect(Array.from(states.mask)).toEqual([...first.map(() => 1), ...second.map(() => 1), 0, 0]);
    first.forEach((token, i) => {
      expect(stateAt(states.data, states.tokens, 0, i)).toEqual(tinyVectorOf(id(token)));
    });
    second.forEach((token, i) => {
      expect(stateAt(states.data, states.tokens, 1, i)).toEqual(tinyVectorOf(id(token)));
    });
    // Padding is [PAD], id 0, and the mask leaves it out.
    expect(stateAt(states.data, states.tokens, 1, 6)).toEqual(tinyVectorOf(0));
  });

  it(`cuts a sentence at ${String(MAX_TOKENS)} tokens, keeping its closing [SEP]`, async () => {
    const encoder = await startEncoder(tinyFiles());

    const states = await encoder.encode([Array.from({ length: 400 }, () => 'room').join(' ')]);

    expect(states.tokens).toBe(MAX_TOKENS);
    expect(stateAt(states.data, states.tokens, 0, 0)).toEqual(tinyVectorOf(id('[CLS]')));
    expect(stateAt(states.data, states.tokens, 0, 1)).toEqual(tinyVectorOf(id('room')));
    expect(stateAt(states.data, states.tokens, 0, MAX_TOKENS - 1)).toEqual(
      tinyVectorOf(id('[SEP]')),
    );
  });

  it('feeds only the inputs the model asks for', async () => {
    const encoder = await startEncoder(tinyFiles(tinyModelOnnx(['attention_mask'])));

    const states = await encoder.encode(['open']);

    expect(stateAt(states.data, states.tokens, 0, 1)).toEqual(tinyVectorOf(id('open')));
  });

  it('refuses a model that asks for an input it can’t feed', async () => {
    await expect(startEncoder(tinyFiles(tinyModelOnnx(['pixel_values'])))).rejects.toThrow(
      'The model asks for an input the encoder can’t feed: pixel_values.',
    );
  });
});

/** The tiny classifier's probabilities for tokens of the first sentence's type, then the second's. */
function expectedProbabilities(first: readonly string[], second: readonly string[]): number[] {
  const rows = [
    ...first.map((token) =>
      tinyLogitsOf(id(token)).map((x, i) => x + (TINY_TYPE_LOGITS[0]?.[i] ?? 0)),
    ),
    ...second.map((token) =>
      tinyLogitsOf(id(token)).map((x, i) => x + (TINY_TYPE_LOGITS[1]?.[i] ?? 0)),
    ),
  ];
  const logits = [0, 1, 2].map(
    (i) => rows.reduce((sum, row) => sum + (row[i] ?? 0), 0) / rows.length,
  );
  const top = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - top));
  const total = exps.reduce((sum, x) => sum + x, 0);
  return exps.map((x) => x / total);
}

/** `actual`, each number close to `expected`'s. */
function expectClose(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((x, i) => {
    expect(actual[i]).toBeCloseTo(x, 5);
  });
}

describe('startPairClassifier (#478)', () => {
  /** The tiny classifier's files with the real runtime. */
  function classifierFiles(model = tinyClassifierOnnx()): RuntimeFiles {
    return { ...tinyFiles(model), model };
  }

  it('reads a pair as [CLS] premise [SEP] hypothesis [SEP], the hypothesis as the second type, and answers probabilities', async () => {
    const classifier = await startPairClassifier(classifierFiles());

    const probabilities = await classifier.classify('Keep the library open.', 'We want boards.');

    expectClose(
      probabilities,
      expectedProbabilities(
        ['[CLS]', 'keep', 'the', 'library', 'open', '.', '[SEP]'],
        ['we', 'want', 'board', '##s', '.', '[SEP]'],
      ),
    );
    expect(Array.from(probabilities).reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 6);
  });

  it('answers each way round on its own: the premise and the hypothesis aren’t interchangeable', async () => {
    const classifier = await startPairClassifier(classifierFiles());

    const forward = await classifier.classify('Keep the library open.', 'Our chess club.');
    const backward = await classifier.classify('Our chess club.', 'Keep the library open.');

    expectClose(
      backward,
      expectedProbabilities(
        ['[CLS]', 'our', 'chess', 'club', '.', '[SEP]'],
        ['keep', 'the', 'library', 'open', '.', '[SEP]'],
      ),
    );
    expect(Array.from(backward)).not.toEqual(Array.from(forward));
  });

  it(`keeps at most ${String(MAX_TOKENS - 2)} tokens of each sentence, so a pair fits the model`, async () => {
    const classifier = await startPairClassifier(classifierFiles());
    const long = Array.from({ length: 400 }, () => 'room').join(' ');

    const probabilities = await classifier.classify(long, 'open');

    expectClose(
      probabilities,
      expectedProbabilities(
        ['[CLS]', ...Array.from({ length: MAX_TOKENS - 2 }, () => 'room'), '[SEP]'],
        ['open', '[SEP]'],
      ),
    );
  });

  it('refuses a model that asks for an input it can’t feed', async () => {
    await expect(
      startPairClassifier(classifierFiles(tinyModelOnnx(['pixel_values']))),
    ).rejects.toThrow('The model asks for an input the encoder can’t feed: pixel_values.');
  });
});
