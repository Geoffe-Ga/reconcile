/**
 * Every threshold the Bedfellows pipeline reads (#475; ADR-0080 §3, §4), in
 * one place, so each later issue in #473 tunes them on the corpus's `tune`
 * split (#474) rather than by eye.
 *
 * These are provisional values for the stand-in models: a word-hashing
 * embedder and a judge that is never sure. They were picked by reading, not
 * tuned, and they mean little once a real model lands; ADR-0080 holds every
 * threshold provisional until its §8 evaluation passes.
 */
export const THRESHOLDS = {
  /** A reader claim and an entry claim whose vectors' cosine is at least this are a candidate pair. */
  match: 0.35,
  /**
   * An entry more than this share of whose claims have a counterpart in the
   * reader's writing is a near-copy: it shares everything, not something, and
   * stays out (ADR-0080 §4's "about 80%").
   */
  nearCopy: 0.8,
  /** How many of an entry's best pairs go to the stance check (ADR-0080 §3). */
  judged: 3,
  /**
   * Tier cuts for an entry of `shortEntry.claims` claims or more, by
   * strangeness (one minus coverage): close kin below `closeBelow`, strange
   * from `strangeFrom`, middle between.
   */
  strangeness: { closeBelow: 0.45, strangeFrom: 0.7 },
  /**
   * An entry under `claims` claims is too short for coverage to say much, so
   * it is placed by its reason's strength (the pair's cosine) instead: close
   * kin from `close`, middle from `middle`, strange below. The coverage rule
   * for near-copies doesn't apply to it.
   */
  shortEntry: { claims: 3, close: 0.75, middle: 0.55 },
} as const;
