/**
 * Tiers (#477; ADR-0080 §4): how far an entry sits from the reader.
 *
 * - An entry of `shortEntry.claims` claims or more is placed by its
 *   **strangeness**, one minus its coverage: close kin below
 *   `strangeness.closeBelow`, strange from `strangeness.strangeFrom`, middle
 *   between.
 * - A shorter entry says too little for coverage to mean much, so it is
 *   placed by its **closeness**: the mean of its best pair's strength (that
 *   pair's cosine) and its nearest Document's (the cosine of the entry's
 *   centroid with the centroid of the reader's nearest Document). Close kin
 *   from `shortEntry.close`, middle from `shortEntry.middle`, strange below.
 *   A strong pair in a Document otherwise far from the entry places it
 *   further out than the same pair in a Document near it.
 */
import { cosine } from './match';
import type { Tier, Vector } from './types';

/** The cuts tiers read (`THRESHOLDS.strangeness` and `THRESHOLDS.shortEntry`). */
export interface TierCuts {
  readonly strangeness: { readonly closeBelow: number; readonly strangeFrom: number };
  readonly shortEntry: { readonly claims: number; readonly close: number; readonly middle: number };
}

/** The tier of an entry of `shortEntry.claims` claims or more, by its strangeness. */
export function tierByStrangeness(strangeness: number, cuts: TierCuts): Tier {
  if (strangeness < cuts.strangeness.closeBelow) return 'close';
  return strangeness < cuts.strangeness.strangeFrom ? 'middle' : 'strange';
}

/** The mean of `vectors`, scaled to unit length; the zero vector when they cancel, empty for none. */
export function centroid(vectors: readonly Vector[]): number[] {
  const first = vectors[0];
  if (first === undefined) return [];
  const sum = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let d = 0; d < sum.length; d += 1) sum[d] = (sum[d] ?? 0) + (vector[d] ?? 0);
  }
  const length = Math.hypot(...sum);
  return length === 0 ? sum : sum.map((x) => x / length);
}

/**
 * How near an entry's claims sit to the reader's nearest Document: the
 * cosine of the entry's centroid with the nearest Document's, 0 with none.
 */
export function nearestDocument(
  entry: readonly Vector[],
  documents: readonly (readonly Vector[])[],
): number {
  const own = centroid(entry);
  return Math.max(0, ...documents.map((doc) => cosine(own, centroid(doc))));
}

/** The tier of an entry under `shortEntry.claims` claims, by its best pair and its nearest Document. */
export function tierOfShortEntry(strength: number, nearest: number, cuts: TierCuts): Tier {
  const closeness = (strength + nearest) / 2;
  if (closeness >= cuts.shortEntry.close) return 'close';
  return closeness >= cuts.shortEntry.middle ? 'middle' : 'strange';
}
