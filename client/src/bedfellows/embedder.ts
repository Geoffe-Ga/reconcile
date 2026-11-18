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
 * Sentences per run of the model: one (#477). The 8-bit model quantizes each
 * run's activations with one scale for the whole batch, so in a batch a
 * sentence's vector shifts with the sentences beside it, and a batch pads
 * every sentence to its longest. One at a time, a claim's vector is the same
 * on every shelf and in every run, so a kept vector is the one a fresh run
 * would make, and the thresholds tuned pair by pair hold in the app; and on
 * one WebAssembly thread it is no slower (#477's measurements).
 */
export const BATCH = 1;

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

/**
 * What a vector of this embedder says it was made by (`Embedder.model`): the
 * pooling, then the model's and the tokenizer's pinned SHA-256s. A change to
 * any of them is a new model, so no vector kept from the old one is reused.
 */
export function modelIdOf(pins: ModelPins): string {
  return `mean-pooled-unit/${pins.model.sha256}/${pins.tokenizer.sha256}`;
}

/** An `Embedder` over a started model, {@link BATCH} sentences at a time, named `model`. */
export function modelEmbedder(encoder: Encoder, model?: string): Embedder {
  return {
    ...(model === undefined ? {} : { model }),
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
    return modelEmbedder(await start({ model, tokenizer, runtime }), modelIdOf(pins));
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
