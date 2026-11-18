/**
 * The bridging bonus (#479; ADR-0080 §6): an entry with candidate pairs in two
 * or more of the reader's Documents that are unlike each other bridges them,
 * and goes first in its tier. Two Documents are unlike when the cosine of
 * their centroids is below `THRESHOLDS.bridge.unlikeBelow`. A reader with one
 * Document has nothing to bridge: no bonus, and no error.
 */
import { cosine } from './match';
import type { Vector } from './types';

/** The indexes of `documents` that hold any of `sentences`, each once, in order. */
export function documentsOf(
  sentences: readonly string[],
  documents: readonly (readonly string[])[],
): number[] {
  const wanted = new Set(sentences);
  return documents.flatMap((claims, i) => (claims.some((claim) => wanted.has(claim)) ? [i] : []));
}

/**
 * Whether two of the Documents at `hit` are unlike each other: the cosine of
 * their `centroids` below `unlikeBelow`. A Document with no centroid is unlike
 * nothing.
 */
export function bridges(
  hit: readonly number[],
  centroids: readonly Vector[],
  unlikeBelow: number,
): boolean {
  const known = hit.flatMap((i) => {
    const centroid = centroids[i];
    return centroid === undefined ? [] : [centroid];
  });
  return known.some((a, i) => known.slice(i + 1).some((b) => cosine(a, b) < unlikeBelow));
}
