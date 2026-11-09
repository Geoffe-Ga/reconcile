/**
 * The consent-floor tally (docs/spec/phase-1-spec.md §5).
 *
 * Integers only: no floats, division or rounding, so every device reaches the
 * same outcome from the same ballots.
 */

/** One version on the ballot, with the score (0–4) each of its scorers gave it. */
export interface TallyVersion {
  readonly id: string;
  readonly scores: readonly number[];
}

/** What the tally needs: the size of the eligible set, and each version in ballot order. */
export interface TallyInput {
  readonly eligible: number;
  readonly versions: readonly TallyVersion[];
}

/** A pass names its winning version. A fail had a version at quorum; a lapse had none. */
export type TallyOutcome =
  | { readonly kind: 'pass'; readonly version: string }
  | { readonly kind: 'fail' }
  | { readonly kind: 'lapse' };

/** Scorer count, score total and zero count of one version. */
interface Measure {
  readonly id: string;
  readonly n: number;
  readonly sum: number;
  readonly zeros: number;
}

/** The fewest scorers any version needs, before the 30% rule (ADR-0073). */
const QUORUM_FLOOR = 3;

function measure(version: TallyVersion): Measure {
  let sum = 0;
  let zeros = 0;
  for (const score of version.scores) {
    sum += score;
    if (score === 0) zeros += 1;
  }
  return { id: version.id, n: version.scores.length, sum, zeros };
}

/** n ≥ 1, n ≥ min(eligible, 3) and 10·n ≥ 3·eligible: min(eligible, max(3, ⌈0.3·eligible⌉)). */
function atQuorum(m: Measure, eligible: number): boolean {
  return m.n >= 1 && m.n >= Math.min(eligible, QUORUM_FLOOR) && 10 * m.n >= 3 * eligible;
}

/** The consent floor (ADR-0002): an average of at least 2.0, and fewer than 10% zeros. */
function passes(m: Measure): boolean {
  return m.sum >= 2 * m.n && 10 * m.zeros < m.n;
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

/** Tallies one Proposal's ballots into a pass, a fail or a lapse. */
export function tally(input: TallyInput): TallyOutcome {
  const quorate = input.versions.map(measure).filter((m) => atQuorum(m, input.eligible));
  if (quorate.length === 0) return { kind: 'lapse' };
  // Versions are visited in ballot order and only a strictly better one takes over,
  // so a full tie stays with the earlier version.
  let winner: Measure | null = null;
  for (const m of quorate) {
    if (passes(m) && (winner === null || beats(m, winner))) winner = m;
  }
  return winner === null ? { kind: 'fail' } : { kind: 'pass', version: winner.id };
}
