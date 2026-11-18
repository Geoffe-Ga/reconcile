/**
 * The real sentence embedder behind the `Embedder` port (#476; ADR-0080 §1,
 * §2): all-MiniLM-L6-v2, 8-bit, run by `runtime.ts`, each sentence's token
 * states averaged over its real tokens and scaled to unit length, as
 * sentence-transformers does.
 *
 * {@link loadEmbedder} fetches the model's three files from our own origin
 * the first time it is called, never before, and refuses any that doesn't
 * match its pin (`src/net/modelFiles.ts`); later calls get the same embedder.
 * The worker imports this module only when a run first asks the model for a
 * vector, so neither the runtime's code nor the files load with the app.
 */
import { fetchPinned } from '../net/modelFiles';
import { MODEL_FILES, type ModelPins, type PinnedFile } from '../net/modelPins';
import { type Encoder, type RuntimeFiles, startEncoder, type TokenStates } from './runtime';
import type { Embedder, Vector } from './types';

/**
 * Sentences per run of the model. A batch pads to its longest sentence, and
 * attention's memory grows with the batch, so a long Document never goes in
 * as one.
 */
export const BATCH = 16;

/** Each sentence's vector: the mean of its real tokens' states, scaled to unit length. */
export function meanPooled(states: TokenStates): Vector[] {
  const { data, mask, sentences, tokens, dimensions } = states;
  return Array.from({ length: sentences }, (_, s) => {
    const sum = new Array<number>(dimensions).fill(0);
    for (let t = 0; t < tokens; t += 1) {
      if (mask[s * tokens + t] !== 1) continue;
      const start = (s * tokens + t) * dimensions;
      for (let d = 0; d < dimensions; d += 1) sum[d] = (sum[d] ?? 0) + (data[start + d] ?? 0);
    }
    const length = Math.sqrt(sum.reduce((total, x) => total + x * x, 0));
    return length === 0 ? sum : sum.map((x) => x / length);
  });
}

/** An `Embedder` over a started model, {@link BATCH} sentences at a time. */
export function modelEmbedder(encoder: Encoder): Embedder {
  return {
    embed: async (sentences) => {
      const vectors: Vector[] = [];
      for (let start = 0; start < sentences.length; start += BATCH) {
        const states = await encoder.encode(sentences.slice(start, start + BATCH));
        vectors.push(...meanPooled(states));
      }
      return vectors;
    },
  };
}

/**
 * A loader of the embedder for `pins`: its first call fetches and checks the
 * three files with `fetchPin`, starts the model with `start` and resolves
 * with the embedder; later calls resolve with the same one. A call after a
 * failed load tries again.
 */
export function embedderLoader(
  pins: ModelPins = MODEL_FILES,
  fetchPin: (pin: PinnedFile) => Promise<Uint8Array> = fetchPinned,
  start: (files: RuntimeFiles) => Promise<Encoder> = startEncoder,
): () => Promise<Embedder> {
  let loading: Promise<Embedder> | null = null;
  async function load(): Promise<Embedder> {
    const [model, tokenizer, runtime] = await Promise.all([
      fetchPin(pins.model),
      fetchPin(pins.tokenizer),
      fetchPin(pins.runtime),
    ]);
    return modelEmbedder(await start({ model, tokenizer, runtime }));
  }
  return () => {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}

/** The app's embedder, fetched and checked on its first call (#476). */
export const loadEmbedder = embedderLoader();
