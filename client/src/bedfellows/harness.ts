/**
 * The Bedfellows harness (#474; ADR-0080 §8): it takes any matcher and
 * reports how it does on each kind of labelled pair in the corpus, so every
 * threshold in #473 is set by measurement rather than by eye.
 *
 * A matcher reads one reader's Documents and one shelf entry, and says what
 * Bedfellows would say: `common-ground` ("You both care about this:"),
 * `shared-subject` ("You both write about this:"), or `nothing` (the entry
 * isn't shown on that pair's account). Only a `shared-claim` pair deserves
 * common ground, so precision is the share of common ground that falls on
 * shared claims, and false agreement is the share of `opposed` pairs called
 * common ground, which ADR-0080 §8 holds under 5%.
 *
 * Thresholds are tuned on `tune` alone. `held-out` numbers come only from
 * {@link heldOutReport}, asked for by name, so they're never read by accident
 * while tuning. The harness imports no React and reaches no network.
 */
import {
  type Corpus,
  type Entry,
  loadCorpus,
  PAIR_KINDS,
  type PairKind,
  type Reader,
  type Split,
} from './corpus';

/** What a matcher says of one reader and one entry. */
export type Verdict = 'common-ground' | 'shared-subject' | 'nothing';

/** A matcher: one reader's Documents and one shelf entry in, a verdict out. */
export type Matcher = (reader: Reader, entry: Entry) => Verdict;

/** How a matcher did on one kind of pair. */
export interface KindCounts {
  readonly pairs: number;
  readonly commonGround: number;
  readonly sharedSubject: number;
  readonly nothing: number;
}

/** How a matcher did on one split. */
export interface Report {
  readonly split: Split;
  readonly byKind: Readonly<Record<PairKind, KindCounts>>;
  /** The share of `common-ground` verdicts that fell on `shared-claim` pairs, or null with none. */
  readonly precision: number | null;
  /** The share of `opposed` pairs called `common-ground`, 0 with none. */
  readonly falseAgreement: number;
}

/** Each verdict's counter in {@link KindCounts}. */
const COUNTER = {
  'common-ground': 'commonGround',
  'shared-subject': 'sharedSubject',
  nothing: 'nothing',
} as const satisfies Record<Verdict, keyof KindCounts>;

/** The count of every kind, before any pair. */
function empty(): Record<PairKind, { -readonly [K in keyof KindCounts]: number }> {
  return Object.fromEntries(
    PAIR_KINDS.map((kind) => [kind, { pairs: 0, commonGround: 0, sharedSubject: 0, nothing: 0 }]),
  ) as Record<PairKind, { -readonly [K in keyof KindCounts]: number }>;
}

/** `matcher`'s report on `split` of `corpus`. */
function report(matcher: Matcher, split: Split, corpus: Corpus): Report {
  const readers = new Map(corpus.readers.map((r) => [r.id, r]));
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));
  const byKind = empty();
  for (const pair of corpus.pairs) {
    const reader = readers.get(pair.reader);
    const entry = entries.get(pair.entry);
    if (reader === undefined || entry === undefined) {
      throw new Error(`Pair ${pair.id} names a reader or entry the corpus doesn't hold.`);
    }
    if (reader.split !== split) continue;
    const counts = byKind[pair.kind];
    counts.pairs += 1;
    counts[COUNTER[matcher(reader, entry)]] += 1;
  }
  const commonGround = PAIR_KINDS.reduce((sum, kind) => sum + byKind[kind].commonGround, 0);
  const { opposed } = byKind;
  return {
    split,
    byKind,
    precision: commonGround === 0 ? null : byKind['shared-claim'].commonGround / commonGround,
    falseAgreement: opposed.pairs === 0 ? 0 : opposed.commonGround / opposed.pairs,
  };
}

/**
 * `matcher`'s report on `split`, which must be `tune`: held-out numbers come
 * only from {@link heldOutReport}.
 *
 * @throws {Error} for `held-out`, or a pair that names a reader or entry the corpus doesn't hold.
 */
export function harness(matcher: Matcher, split: Split, corpus: Corpus = loadCorpus()): Report {
  if (split === 'held-out') throw new Error('Held-out numbers come only from heldOutReport.');
  return report(matcher, split, corpus);
}

/**
 * `matcher`'s report on `held-out`: the numbers a threshold is judged by,
 * read only once it's set on `tune`.
 */
export function heldOutReport(matcher: Matcher, corpus: Corpus = loadCorpus()): Report {
  return report(matcher, 'held-out', corpus);
}
