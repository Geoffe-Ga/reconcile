import { describe, expect, it } from 'vitest';

import { ortWasm } from '../test/ortWasm';
import {
  TINY_DIMENSIONS,
  TINY_VOCAB,
  tinyModelOnnx,
  tinyTokenizerJson,
  tinyVectorOf,
} from '../test/tinyModel';
import { MAX_TOKENS, type RuntimeFiles, startEncoder } from './runtime';

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
