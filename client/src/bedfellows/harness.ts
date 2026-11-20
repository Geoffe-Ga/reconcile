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
 * while tuning; {@link harnessAsync} and {@link heldOutReportAsync} do the
 * same for a matcher that answers later, as the pipeline (#475) does. The
 * harness imports no React and reaches no network.
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
import { claimsIn, splitClaims } from './split';
import type { HostilityCheck } from './types';

/** What a matcher says of one reader and one entry. */
export type Verdict = 'common-ground' | 'shared-subject' | 'nothing';

/** A matcher: one reader's Documents and one shelf entry in, a verdict out. */
export type Matcher = (reader: Reader, entry: Entry) => Verdict;

/** A matcher that answers later, as one running models does (#475's pipeline). */
export type AsyncMatcher = (reader: Reader, entry: Entry) => Promise<Verdict>;

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

/** A labelled pair on the split being read, with its reader and entry. */
interface Labelled {
  readonly kind: PairKind;
  readonly reader: Reader;
  readonly entry: Entry;
}

/**
 * `corpus`'s pairs on `split`, in the corpus's order, each with its reader and entry.
 *
 * @throws {Error} for a pair that names a reader or entry the corpus doesn't hold.
 */
function labelled(split: Split, corpus: Corpus): Labelled[] {
  const readers = new Map(corpus.readers.map((r) => [r.id, r]));
  const entries = new Map(corpus.entries.map((e) => [e.id, e]));
  const found: Labelled[] = [];
  for (const pair of corpus.pairs) {
    const reader = readers.get(pair.reader);
    const entry = entries.get(pair.entry);
    if (reader === undefined || entry === undefined) {
      throw new Error(`Pair ${pair.id} names a reader or entry the corpus doesn't hold.`);
    }
    if (reader.split === split) found.push({ kind: pair.kind, reader, entry });
  }
  return found;
}

/** The report on `split` from each pair's kind and the verdict it got. */
function tally(
  split: Split,
  verdicts: readonly { readonly kind: PairKind; readonly verdict: Verdict }[],
): Report {
  const byKind = empty();
  for (const { kind, verdict } of verdicts) {
    const counts = byKind[kind];
    counts.pairs += 1;
    counts[COUNTER[verdict]] += 1;
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

/** `matcher`'s report on `split` of `corpus`. */
function report(matcher: Matcher, split: Split, corpus: Corpus): Report {
  return tally(
    split,
    labelled(split, corpus).map(({ kind, reader, entry }) => ({
      kind,
      verdict: matcher(reader, entry),
    })),
  );
}

/** `matcher`'s report on `split` of `corpus`, asking about one pair at a time. */
async function reportAsync(matcher: AsyncMatcher, split: Split, corpus: Corpus): Promise<Report> {
  const verdicts: { kind: PairKind; verdict: Verdict }[] = [];
  for (const { kind, reader, entry } of labelled(split, corpus)) {
    verdicts.push({ kind, verdict: await matcher(reader, entry) });
  }
  return tally(split, verdicts);
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

/**
 * {@link harness} for an {@link AsyncMatcher}: `matcher`'s report on `split`,
 * which must be `tune`, asking about one pair at a time. Held-out numbers
 * come only from {@link heldOutReportAsync}.
 *
 * @throws {Error} for `held-out`, or a pair that names a reader or entry the corpus doesn't hold.
 */
export async function harnessAsync(
  matcher: AsyncMatcher,
  split: Split,
  corpus: Corpus = loadCorpus(),
): Promise<Report> {
  if (split === 'held-out') throw new Error('Held-out numbers come only from heldOutReportAsync.');
  return reportAsync(matcher, split, corpus);
}

/**
 * {@link heldOutReport} for an {@link AsyncMatcher}: the numbers a threshold
 * is judged by, read only once it's set on `tune`.
 */
export function heldOutReportAsync(
  matcher: AsyncMatcher,
  corpus: Corpus = loadCorpus(),
): Promise<Report> {
  return reportAsync(matcher, 'held-out', corpus);
}

/*
 * The shared-enemy check (#481; ADR-0080 §6), scored here because only the
 * harness reads the corpus: how many of each split's `hostile` entries a
 * check catches, how many others it wrongly flags, and how anger at the
 * powerful fares. The check itself is `hostility.ts`.
 */

/** How a check did on one kind of entry. */
export interface HostilityCounts {
  readonly entries: number;
  /** Entries with at least one claim flagged. */
  readonly flagged: number;
  readonly claims: number;
  readonly claimsFlagged: number;
}

/** How a check did on one split. */
export interface HostilityReport {
  readonly split: Split;
  /** Entries labelled `hostile`: flagged is caught. */
  readonly hostile: HostilityCounts;
  /** Every other entry: flagged is wrongly flagged. */
  readonly others: HostilityCounts;
  /** The others that are anger at the powerful, the control (`corpus/README.md`). */
  readonly angerAtPowerful: HostilityCounts;
  /** Wrongly flagged entries by subject, to see whether they lean toward one kind of group. */
  readonly othersFlaggedBySubject: Readonly<Record<string, number>>;
  /** The ids of wrongly flagged entries, in corpus order. */
  readonly flaggedOthers: readonly string[];
  /** The ids of hostile entries with no claim flagged, in corpus order. */
  readonly missedHostile: readonly string[];
}

/** One entry's claims and how many `check` flags. */
interface Checked {
  readonly entry: Entry;
  readonly claims: number;
  readonly flagged: number;
}

/** The counts over `checked`. */
function countsOf(checked: readonly Checked[]): HostilityCounts {
  return {
    entries: checked.length,
    flagged: checked.filter((c) => c.flagged > 0).length,
    claims: checked.reduce((sum, c) => sum + c.claims, 0),
    claimsFlagged: checked.reduce((sum, c) => sum + c.flagged, 0),
  };
}

/** `check`'s report on `split` of `corpus`, asking about one claim at a time. */
async function hostilityReportOf(
  check: HostilityCheck,
  split: Split,
  corpus: Corpus,
): Promise<HostilityReport> {
  const checked: Checked[] = [];
  for (const entry of corpus.entries.filter((e) => e.split === split)) {
    const claims = claimsIn(entry.title, entry.text, splitClaims);
    let flagged = 0;
    for (const claim of claims) if (await check.isMainlyHostile(claim)) flagged += 1;
    checked.push({ entry, claims: claims.length, flagged });
  }
  const hostile = checked.filter((c) => c.entry.hostile);
  const others = checked.filter((c) => !c.entry.hostile);
  const wrong = others.filter((c) => c.flagged > 0);
  const bySubject: Record<string, number> = {};
  for (const { entry } of wrong) bySubject[entry.subject] = (bySubject[entry.subject] ?? 0) + 1;
  return {
    split,
    hostile: countsOf(hostile),
    others: countsOf(others),
    angerAtPowerful: countsOf(others.filter((c) => c.entry.angerAtPowerful === true)),
    othersFlaggedBySubject: bySubject,
    flaggedOthers: wrong.map((c) => c.entry.id),
    missedHostile: hostile.filter((c) => c.flagged === 0).map((c) => c.entry.id),
  };
}

/**
 * `check`'s report on `split`, which must be `tune`: held-out numbers come
 * only from {@link heldOutHostilityReport}, as the harness's do.
 *
 * @throws {Error} for `held-out`.
 */
export async function hostilityReport(
  check: HostilityCheck,
  split: Split,
  corpus: Corpus = loadCorpus(),
): Promise<HostilityReport> {
  if (split === 'held-out')
    throw new Error('Held-out numbers come only from heldOutHostilityReport.');
  return hostilityReportOf(check, split, corpus);
}

/** `check`'s report on `held-out`: read once its bar is set on `tune`. */
export function heldOutHostilityReport(
  check: HostilityCheck,
  corpus: Corpus = loadCorpus(),
): Promise<HostilityReport> {
  return hostilityReportOf(check, 'held-out', corpus);
}
