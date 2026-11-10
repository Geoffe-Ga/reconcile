/**
 * The tally (docs/spec/phase-1-spec.md §5): each version against the bar its
 * Proposal's class sets, the consent floor for an ordinary change (ADR-0002)
 * or the entrenched bar (ADR-0015 §2).
 *
 * Integers only: no floats, division or rounding, so every device reaches the
 * same outcome from the same ballots.
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

/** Scorer count, score total and zero count of one version. */
interface Measure {
  readonly id: string;
  readonly n: number;
  readonly sum: number;
  readonly zeros: number;
}

/** Quorum per version (ADR-0073), a founding rule genesis can't change. */
const { quorum: QUORUM } = DEFAULT_RULES;

function measure(version: TallyVersion): Measure {
  let sum = 0;
  let zeros = 0;
  for (const score of version.scores) {
    sum += score;
    if (score === 0) zeros += 1;
  }
  return { id: version.id, n: version.scores.length, sum, zeros };
}

/** n ≥ 1, n ≥ min(eligible, 3) and 100·n ≥ 30·eligible: min(eligible, max(3, ⌈0.3·eligible⌉)). */
function atQuorum(m: Measure, eligible: number): boolean {
  return (
    m.n >= 1 && m.n >= Math.min(eligible, QUORUM.min) && 100 * m.n >= QUORUM.percent * eligible
  );
}

/** At least `avgAtLeast` on average (sum ≥ avg·n), and under `zerosUnderPercent`% zeros (100·zeros < pct·n). */
function passes(m: Measure, bar: Bar): boolean {
  return m.sum >= bar.avgAtLeast * m.n && 100 * m.zeros < bar.zerosUnderPercent * m.n;
}

/**
 * True when `a` is strictly better than `b`: a higher average (sumA·nB > sumB·nA),
 * or an equal average with fewer zeros (a count, as ADR-0002 words it).
 */
function beats(a: Measure, b: Measure): boolean {
  const left = a.sum * b.n;
  const right = b.sum * a.n;
  return left > right || (left === right && a.zeros < b.zeros);
}

/** Tallies one Proposal's ballots, at its bar, into a pass, a fail or a lapse. */
export function tally(input: TallyInput): TallyOutcome {
  const { bar } = input;
  const quorate = input.versions.map(measure).filter((m) => atQuorum(m, input.eligible));
  if (quorate.length === 0) return { kind: 'lapse', bar };
  // Versions are visited in ballot order and only a strictly better one takes over,
  // so a full tie stays with the earlier version.
  let winner: Measure | null = null;
  for (const m of quorate) {
    if (passes(m, bar) && (winner === null || beats(m, winner))) winner = m;
  }
  return winner === null ? { kind: 'fail', bar } : { kind: 'pass', version: winner.id, bar };
}
