/**
 * Matching claims (#477; ADR-0080 §1, §4). Every one of the reader's claims
 * is held against every one of an entry's by the cosine of their vectors:
 *
 * - a pair at or above the **match** threshold is a candidate pair, and the
 *   best of them go to the stance check;
 * - an entry claim with a reader claim at or above the **counterpart**
 *   threshold has a counterpart in the reader's writing, and **coverage** is
 *   the share of the entry's claims that do.
 *
 * Coverage only counts: an entry claim with no counterpart, such as a
 * sentence on another subject, can only lower it.
 *
 * Every tie is broken by words, never by position, so the order claims come
 * in never changes what is found.
 */
import type { Vector } from './types';

/** A claim and its vector. */
export interface Claim {
  readonly sentence: string;
  readonly vector: Vector;
}

/** A candidate pair of claims and how alike their vectors are. */
export interface Candidate {
  readonly readerSentence: string;
  readonly entrySentence: string;
  readonly similarity: number;
}

/** What matching found for one entry. */
export interface EntryMatch {
  /** Every candidate pair, best first. */
  readonly candidates: readonly Candidate[];
  /** The share of the entry's claims with a counterpart in the reader's writing; 0 with no claims. */
  readonly coverage: number;
}

/** The two cuts matching reads (`THRESHOLDS.match` and `THRESHOLDS.counterpart`). */
export interface MatchCuts {
  readonly match: number;
  readonly counterpart: number;
}

/** The cosine of the angle between `a` and `b`; 0 when either is the zero vector. */
export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** Orders strings by their UTF-16 code units, the same on every device and in every locale. */
export function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Stronger pairs first; equal pairs by the entry's sentence, then the reader's. */
export function byStrength(a: Candidate, b: Candidate): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity;
  return byText(a.entrySentence, b.entrySentence) || byText(a.readerSentence, b.readerSentence);
}

/** How alike `entryClaim` is to each of the reader's claims, in the reader's order. */
function similarities(entryClaim: Claim, reader: readonly Claim[]): number[] {
  return reader.map((own) => cosine(own.vector, entryClaim.vector));
}

/** Whether `entryClaim` has a counterpart among the reader's claims. */
function hasCounterpart(entryClaim: Claim, reader: readonly Claim[], counterpart: number): boolean {
  return similarities(entryClaim, reader).some((similarity) => similarity >= counterpart);
}

/** The share of `entry`'s claims with a counterpart among `reader`'s, at `counterpart`; 0 with none. */
export function coverage(
  entry: readonly Claim[],
  reader: readonly Claim[],
  counterpart: number,
): number {
  if (entry.length === 0) return 0;
  return entry.filter((claim) => hasCounterpart(claim, reader, counterpart)).length / entry.length;
}

/** Every candidate pair of `entry`'s claims with `reader`'s, best first, and the entry's coverage. */
export function matchEntry(
  entry: readonly Claim[],
  reader: readonly Claim[],
  cuts: MatchCuts,
): EntryMatch {
  const candidates: Candidate[] = [];
  let covered = 0;
  for (const claim of entry) {
    const scores = similarities(claim, reader);
    if (scores.some((similarity) => similarity >= cuts.counterpart)) covered += 1;
    scores.forEach((similarity, i) => {
      if (similarity < cuts.match) return;
      const own = reader[i];
      if (own !== undefined) {
        candidates.push({
          readerSentence: own.sentence,
          entrySentence: claim.sentence,
          similarity,
        });
      }
    });
  }
  return {
    candidates: candidates.sort(byStrength),
    coverage: entry.length === 0 ? 0 : covered / entry.length,
  };
}
