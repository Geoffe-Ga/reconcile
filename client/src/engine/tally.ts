/**
 * The tally (docs/spec/phase-1-spec.md §5): each version against the bar its
 * Proposal's class sets, the consent floor for an ordinary change (ADR-0002),
 * the entrenched bar (ADR-0015 §2), or removal's, which forgives one 0
 * (ADR-0075 §3, #115).
 *
 * Integers only: no floats, division or rounding, so every device reaches the
 * same outcome from the same ballots. {@link tallyDetail} also gives each
 * version's numbers and pass flags, which the consent meter and the result
 * read, so the screens never hold a threshold of their own (#74). {@link rank}
 * orders the passing versions, which a priority vote shows as its ranking
 * (#107), and the winner is always the first of them.
 */
import { type Bar, DEFAULT_RULES } from './rules';

/** One version on the ballot, with the score (0–4) each of its scorers gave it. */
export interface TallyVersion {
  readonly id: string;
  readonly scores: readonly number[];
}

/**
 * What the tally needs: the size of the eligible set, each version in ballot
 * order, and the bar a version must clear, which the Proposal's class picks
 * from the group's rules.
 */
export interface TallyInput {
  readonly eligible: number;
  readonly versions: readonly TallyVersion[];
  readonly bar: Bar;
}

/**
 * A pass names its winning version. A fail had a version at quorum; a lapse
 * had none. Each carries the bar it was tallied at, so a screen draws the
 * Proposal's own lines and holds no threshold of its own.
 */
export type TallyOutcome =
  | { readonly kind: 'pass'; readonly version: string; readonly bar: Bar }
  | { readonly kind: 'fail'; readonly bar: Bar }
  | { readonly kind: 'lapse'; readonly bar: Bar };

/** One version's numbers: how many scored it, their total, how many gave 0, and how many it needs. */
export interface VersionTotals {
  readonly scorers: number;
  readonly sum: number;
  readonly zeros: number;
  /** The fewest scorers it needs to count: min(eligible, max(3, ⌈30% of eligible⌉)), and at least 1. */
  readonly quorum: number;
}

/**
 * One version's numbers and pass flags at its bar. `averageMet` and
 * `zerosMet` are false until someone has scored it, and `passes` needs both
 * and quorum.
 */
export interface VersionTally extends VersionTotals {
  readonly id: string;
  readonly atQuorum: boolean;
  readonly averageMet: boolean;
  readonly zerosMet: boolean;
  readonly passes: boolean;
}

/**
 * The bar a tally used, each version's numbers and flags in ballot order, the
 * passing versions best first, and the outcome, whose winner is the first of them.
 */
export interface TallyDetail {
  readonly bar: Bar;
  readonly versions: readonly VersionTally[];
  readonly ranking: readonly VersionTally[];
  readonly outcome: TallyOutcome;
}

/** Quorum per version (ADR-0073), a founding rule genesis can't change. */
const { quorum: QUORUM } = DEFAULT_RULES;

/**
 * min(eligible, max(3, ⌈0.3 · eligible⌉)), and at least 1, without dividing:
 * the smallest n from min(eligible, 3) up with 100·n ≥ 30·eligible. So a
 * version is at quorum when n ≥ 1, n ≥ min(eligible, 3) and 100·n ≥ 30·eligible.
 */
function quorumOf(eligible: number): number {
  let needed = Math.min(eligible, QUORUM.min);
  while (100 * needed < QUORUM.percent * eligible) needed += 1;
  return Math.max(1, needed);
}

/**
 * True when `zeros` among `scorers` don't block at `bar`: under
 * `zerosUnderPercent`% of them (100·zeros < pct·n), or no more than the bar's
 * `zerosAllowed`, when it names one (removal's, ADR-0075 §3). Never before
 * anyone has scored.
 */
function zerosPass(zeros: number, scorers: number, bar: Bar): boolean {
  const allowed = bar.zerosAllowed !== undefined && zeros <= bar.zerosAllowed;
  return scorers > 0 && (allowed || 100 * zeros < bar.zerosUnderPercent * scorers);
}

/**
 * A version's numbers and flags: at least `avgAtLeast` on average
 * (sum ≥ avg·n), and zeros that don't block ({@link zerosPass}).
 */
function measure(version: TallyVersion, quorum: number, bar: Bar): VersionTally {
  let sum = 0;
  let zeros = 0;
  for (const score of version.scores) {
    sum += score;
    if (score === 0) zeros += 1;
  }
  const scorers = version.scores.length;
  const atQuorum = scorers >= quorum;
  const averageMet = scorers > 0 && sum >= bar.avgAtLeast * scorers;
  const zerosMet = zerosPass(zeros, scorers, bar);
  const passes = atQuorum && averageMet && zerosMet;
  return { id: version.id, scorers, sum, zeros, quorum, atQuorum, averageMet, zerosMet, passes };
}

/**
 * Negative when `a` ranks before `b` (ADR-0004): a higher average
 * (sumA·nB > sumB·nA), or an equal average with fewer zeros (a count, as
 * ADR-0002 words it). Zero for a full tie, which a stable sort leaves in
 * ballot order, so the earlier version stays first.
 */
function order(a: VersionTally, b: VersionTally): number {
  const byAverage = b.sum * a.scorers - a.sum * b.scorers;
  return byAverage === 0 ? a.zeros - b.zeros : byAverage;
}

/** The passing versions, best first. `sort` is stable, so a full tie keeps ballot order. */
function ranked(versions: readonly VersionTally[]): VersionTally[] {
  return versions.filter((version) => version.passes).sort(order);
}

/** The outcome at `bar`: a lapse with no version at quorum, else the first ranked version, else a fail. */
function outcomeOf(
  versions: readonly VersionTally[],
  ranking: readonly VersionTally[],
  bar: Bar,
): TallyOutcome {
  if (!versions.some((version) => version.atQuorum)) return { kind: 'lapse', bar };
  const [winner] = ranking;
  return winner === undefined ? { kind: 'fail', bar } : { kind: 'pass', version: winner.id, bar };
}

/** Tallies one Proposal's ballots at its bar, version by version, with the outcome. */
export function tallyDetail(input: TallyInput): TallyDetail {
  const { bar } = input;
  const quorum = quorumOf(input.eligible);
  const versions = input.versions.map((version) => measure(version, quorum, bar));
  const ranking = ranked(versions);
  return { bar, versions, ranking, outcome: outcomeOf(versions, ranking, bar) };
}

/** Tallies one Proposal's ballots, at its bar, into a pass, a fail or a lapse. */
export function tally(input: TallyInput): TallyOutcome {
  return tallyDetail(input).outcome;
}

/**
 * The versions that pass, at quorum and at the bar, best first: a higher
 * average, then fewer zeros, then the earlier version (ADR-0004). A priority
 * vote ranks its options this way (#107), and {@link tally}'s winner is always
 * the first, so the two can't disagree.
 */
export function rank(input: TallyInput): readonly VersionTally[] {
  return tallyDetail(input).ranking;
}
