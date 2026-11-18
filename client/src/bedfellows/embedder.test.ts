import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../crypto/hash';
import { fetchPinned, PinMismatchError } from '../net/modelFiles';
import { MODEL_FILES, type ModelFileName, type ModelPins, type PinnedFile } from '../net/modelPins';
import { ortWasm } from '../test/ortWasm';
import { TINY_VOCAB, tinyModelOnnx, tinyTokenizerJson, tinyVectorOf } from '../test/tinyModel';
import { BATCH, embedderLoader, meanPooled, modelEmbedder, modelIdOf } from './embedder';
import { cosine } from './pipeline';
import { type Encoder, startEncoder, type TokenStates } from './runtime';

/** `bytes`' SHA-256 in lowercase hex. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The tiny model's three files (`src/test/tinyModel.ts`), by name. */
const TINY: Readonly<Record<ModelFileName, Uint8Array>> = {
  model: tinyModelOnnx(),
  tokenizer: new TextEncoder().encode(tinyTokenizerJson()),
  runtime: ortWasm(),
};

/** Pins for the tiny files, named as the real ones are. */
function pinsFor(files: Readonly<Record<ModelFileName, Uint8Array>>): ModelPins {
  const pin = (name: ModelFileName): PinnedFile => {
    const bytes = files[name];
    const sha = hexOf(bytes);
    return { file: `tiny-${name}-${sha.slice(0, 8)}.bin`, sha256: sha, bytes: bytes.length };
  };
  return { model: pin('model'), tokenizer: pin('tokenizer'), runtime: pin('runtime') };
}

const PINS = pinsFor(TINY);

/** A server holding `files` under the names `PINS` gives them, counting each request. */
function serving(files: Readonly<Record<ModelFileName, Uint8Array>>) {
  const byUrl = new Map(
    (Object.keys(PINS) as ModelFileName[]).map((name) => [
      `/models/${PINS[name].file}`,
      files[name],
    ]),
  );
  const fetchFile = vi.fn((url: string) => {
    const body = byUrl.get(url);
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body.slice()),
    );
  });
  return { fetchFile, fetchPin: (pin: PinnedFile) => fetchPinned(pin, fetchFile) };
}

/** The tiny model's vector for `tokens`: their table rows averaged, then scaled to unit length. */
function expected(tokens: readonly string[]): number[] {
  const rows = tokens.map((token) => tinyVectorOf(TINY_VOCAB.indexOf(token)));
  const mean =
    rows[0]?.map((_, d) => rows.reduce((sum, row) => sum + (row[d] ?? 0), 0) / rows.length) ?? [];
  const length = Math.sqrt(mean.reduce((sum, x) => sum + x * x, 0));
  return mean.map((x) => x / length);
}

describe('meanPooled (#476)', () => {
  const states: TokenStates = {
    // Two sentences of three tokens, two numbers each; the second's last token is padding.
    data: Float32Array.from([3, 0, 0, 4, 3, 4, 1, 1, 3, 3, 100, -100]),
    mask: Uint8Array.from([1, 1, 1, 1, 1, 0]),
    sentences: 2,
    tokens: 3,
    dimensions: 2,
  };

  it('averages each sentence’s real tokens, leaves padding out, and scales to unit length', () => {
    const [first, second] = meanPooled(states);
    expect(first?.[0]).toBeCloseTo(0.6);
    expect(first?.[1]).toBeCloseTo(0.8);
    expect(second?.[0]).toBeCloseTo(Math.SQRT1_2);
    expect(second?.[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('leaves a sentence whose tokens average to nothing as the zero vector', () => {
    const zero: TokenStates = { ...states, data: new Float32Array(12) };
    expect(meanPooled(zero)).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('modelEmbedder (#476)', () => {
  /** An encoder whose every token's state is the sentence's index in its batch, plus one, counting calls. */
  function counting() {
    const batches: number[] = [];
    const encoder: Encoder = {
      encode: (sentences) => {
        batches.push(sentences.length);
        const data = Float32Array.from(sentences.flatMap((_, s) => [s + 1, 1]));
        return Promise.resolve({
          data,
          mask: new Uint8Array(sentences.length).fill(1),
          sentences: sentences.length,
          tokens: 1,
          dimensions: 2,
        });
      },
    };
    return { encoder, batches };
  }

  it('runs the model one sentence at a time, so no sentence’s vector depends on another’s (#477)', async () => {
    const { encoder, batches } = counting();
    const sentences = ['A.', 'Bee.', 'Sea.'];

    const vectors = await modelEmbedder(encoder).embed(sentences);
    const alone = await modelEmbedder(encoder).embed(['Bee.']);

    expect(BATCH).toBe(1);
    expect(batches).toEqual([1, 1, 1, 1]);
    expect(vectors).toHaveLength(sentences.length);
    expect(vectors[1]).toEqual(alone[0]);
  });

  it('names its model, so a kept vector is reused only by the model that made it (#477)', () => {
    const { encoder } = counting();

    expect(modelEmbedder(encoder, 'm1').model).toBe('m1');
    expect(modelEmbedder(encoder)).not.toHaveProperty('model');
    expect(modelIdOf(MODEL_FILES)).toBe(
      `mean-pooled-unit/${MODEL_FILES.model.sha256}/${MODEL_FILES.tokenizer.sha256}`,
    );
  });

  it('asks the model nothing for no sentences', async () => {
    const { encoder, batches } = counting();
    await expect(modelEmbedder(encoder).embed([])).resolves.toEqual([]);
    expect(batches).toEqual([]);
  });
});

describe('embedderLoader (#476)', () => {
  it('fetches nothing until it is called', () => {
    const { fetchFile, fetchPin } = serving(TINY);
    embedderLoader(PINS, fetchPin);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('fetches and checks the three files once, starts the model, and embeds with it', async () => {
    const { fetchFile, fetchPin } = serving(TINY);
    const load = embedderLoader(PINS, fetchPin);

    const embedder = await load();
    const [open, chess] = await embedder.embed(['Keep the reading room open.', 'Our chess boards']);
    const again = await load();

    expect(again).toBe(embedder);
    expect(fetchFile.mock.calls.map(([url]) => url).sort()).toEqual(
      Object.values(PINS)
        .map((pin) => `/models/${pin.file}`)
        .sort(),
    );
    const keep = ['[CLS]', 'keep', 'the', 'reading', 'room', 'open', '.', '[SEP]'];
    expect(cosine(open ?? [], expected(keep))).toBeCloseTo(1, 6);
    expect(
      cosine(chess ?? [], expected(['[CLS]', 'our', 'chess', 'board', '##s', '[SEP]'])),
    ).toBeCloseTo(1, 6);
  });

  it('refuses a file that doesn’t match its pin, and never starts the model', async () => {
    const tampered = TINY.model.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    const { fetchPin } = serving({ ...TINY, model: tampered });
    const start = vi.fn(startEncoder);

    await expect(embedderLoader(PINS, fetchPin, start)()).rejects.toBeInstanceOf(PinMismatchError);

    expect(start).not.toHaveBeenCalled();
  });

  it('tries again on the next call after a load fails', async () => {
    const { fetchFile, fetchPin } = serving(TINY);
    fetchFile.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })));
    const load = embedderLoader(PINS, fetchPin);

    await expect(load()).rejects.toThrow(/couldn’t be fetched/);
    await expect(load()).resolves.toHaveProperty('embed');
  });
});
