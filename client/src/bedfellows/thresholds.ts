/**
 * Every threshold the Bedfellows pipeline reads (#475, #477; ADR-0080 §1–§4),
 * in one place.
 *
 * The cosine thresholds are for the real model (#476, all-MiniLM-L6-v2) and
 * were set on the corpus's `tune` split (#474) with `harnessAsync`, never on
 * `held-out`; the numbers that set each are beside it. ADR-0080 holds every
 * threshold provisional until its §8 evaluation passes, and a change of model
 * means tuning them again.
 */

/** The shape of {@link THRESHOLDS}, so a tuning run can try other values. */
export interface Thresholds {
  /** A reader claim and an entry claim whose vectors' cosine is at least this are a candidate pair. */
  readonly match: number;
  /** An entry claim with a reader claim at least this alike has a counterpart: coverage counts it. */
  readonly counterpart: number;
  /** An entry more than this share of whose claims have a counterpart is a near-copy, and stays out. */
  readonly nearCopy: number;
  /** How many of an entry's best pairs go to the stance check. */
  readonly judged: number;
  /** Tier cuts by strangeness, one minus coverage, for an entry of `shortEntry.claims` claims or more. */
  readonly strangeness: { readonly closeBelow: number; readonly strangeFrom: number };
  /** Tier cuts by closeness for a shorter entry (`tiers.ts`). */
  readonly shortEntry: { readonly claims: number; readonly close: number; readonly middle: number };
  /** Term overlap (`fallback.ts`): content words a pair must share to be a candidate. */
  readonly fallback: { readonly shared: number };
  /** What the model covers (`fallback.ts`'s `covers`). */
  readonly covers: {
    readonly minWords: number;
    readonly latinShare: number;
    readonly englishShare: number;
  };
}

/**
 * The thresholds, each with the `tune` numbers that set it (#477). "Back"
 * counts the pairs of a kind that got a row, out of that kind's pairs on
 * `tune`; the judge is still the stand-in, so every row is unverified.
 */
export const THRESHOLDS: Thresholds = {
  /**
   * 0.43: shared claims back 26/33, word-sense traps 5/31, idioms 5/26,
   * passing mentions 5/26, unrelated 0/28. At 0.42, the same shared claims
   * and one more trap; at 0.41, 26/33 and 7/31; at 0.40, 29/33 but 12/31
   * traps and an unrelated pair; at 0.44, 25/33 and 4/31. The issue's
   * examples fit inside: the reading room and the library at 0.486, the chess
   * club's boards and the housing board at 0.347.
   */
  match: 0.43,
  /**
   * 0.5: a counterpart is the same claim restated, a closer pair than a
   * shared subject. On `tune` anything from 0.5 to 0.6 gives the same
   * numbers; 0.45 loses two shared claims as near-copies. 0.5, the low end,
   * spreads the rows across the tiers most (strangeness 1 for 41 of 84 rows
   * rather than 58 of 85 at 0.55).
   */
  counterpart: 0.5,
  /**
   * 0.65, not ADR-0080's "about 80%": an entry's title is a claim, and a
   * reader's Document's title isn't, so a near-copy of a Document (title and
   * two sentences) covers at most 2/3. At 0.65, near-copies back 0/28 and
   * shared claims 26/33; at 0.7, 18/28 near-copies come back; at 0.8, 17–21.
   * Anything from 0.6 to just under 2/3 gives the same numbers.
   */
  nearCopy: 0.65,
  /** ADR-0080 §3: the stance check reads an entry's best three pairs. */
  judged: 3,
  /**
   * Cut where `tune`'s 84 rows fall: 7 with strangeness 0.5 (two claims of
   * four restated) are close, 36 between 0.667 and 0.8 middle, and 41 with
   * none restated, a subject shared and nothing more, strange.
   */
  strangeness: { closeBelow: 0.6, strangeFrom: 0.9 },
  /**
   * Not tuned: every `tune` entry has three claims or more (a title and at
   * least two sentences). Set so a pair just at `match` in a Document near
   * the entry is middle, and close needs a pair and a Document well past it.
   */
  shortEntry: { claims: 3, close: 0.6, middle: 0.45 },
  /**
   * Two shared content words, #474's baseline's line for common ground. Term
   * overlap alone on `tune` at 2: shared claims 11/33, traps 3/31, idioms
   * 2/26, passing mentions 8/26, near-copies 4/28, unrelated 2/28. At 1,
   * traps 23/31 and unrelated 11/28; at 3, shared claims 4/33.
   */
  fallback: { shared: 2 },
  /**
   * Not tuned on the corpus, which is all English: a text of 8 words or more
   * is covered when at least half its letters are Latin script and a tenth
   * of its words are English function words (`fallback.ts`). Every
   * Document and entry in the corpus is covered (`fallback.test.ts` holds it).
   */
  covers: { minWords: 8, latinShare: 0.5, englishShare: 0.1 },
};
