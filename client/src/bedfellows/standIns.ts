/**
 * Stand-in models for the Bedfellows pipeline (#475): each sits behind its
 * port in `types.ts` and keeps the pipeline whole until a later issue in #473
 * replaces it with a real one. None of them is any good, on purpose: they
 * give the harness (#474) a floor to beat.
 *
 * They live here, not in `src/test/`, because the worker runs them in the real
 * build, and nothing outside a test may import `src/test/` (dependency-cruiser's
 * `test-helpers-stay-in-tests`). Each is named a stand-in so no caller mistakes
 * one for a model.
 */
import { contentWords, sentencesOf } from './baseline';
import type { Embedder, Splitter, StanceJudge, Vector } from './types';

/** The stand-in splitter: cuts on `.`, `!` or `?` and at blank lines (#474's `sentencesOf`). `split.ts` replaced it in the pipeline (#477); the harness pages still compare against it. */
export const standInSplitter: Splitter = sentencesOf;

/** The stand-in embedder's vector size. */
const DIMENSIONS = 256;

/** FNV-1a's offset basis and prime, for hashing a word to a slot. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** `word`'s slot in a vector of `DIMENSIONS`: 32-bit FNV-1a over its UTF-16 code units. */
function slotOf(word: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < word.length; i += 1) {
    hash = Math.imul(hash ^ word.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return hash % DIMENSIONS;
}

/** `sentence`'s stand-in vector: a count of its content words, each hashed to a slot. */
function hashed(sentence: string): Vector {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of contentWords(sentence)) {
    const slot = slotOf(word);
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return vector;
}

/**
 * The stand-in embedder: each sentence's content words hashed into a vector of
 * 256 slots. Sentences sharing words point the same way; paraphrase, stance
 * and word sense are invisible to it, as they are to term overlap.
 */
export const standInEmbedder: Embedder & { readonly dimensions: number } = {
  model: 'stand-in/hashed-content-words/256',
  dimensions: DIMENSIONS,
  embed: (sentences) => Promise.resolve(sentences.map(hashed)),
};

/** The stand-in stance judge: it never knows, so every pair it sees is a shared subject only. */
export const standInJudge: StanceJudge = {
  judge: () => Promise.resolve('unsure'),
};
