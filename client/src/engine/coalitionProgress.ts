/**
 * How far a coalition motion has got (docs/spec/phase-1-spec.md §4 Coalitions;
 * ADR-0036, ADR-0069; #120).
 *
 * Each member group votes on a motion inside itself, and only its pass or
 * fail crosses into the coalition's log. This reads that log alone, so it
 * never sees a ballot, a score, a count of voters or a name from any group:
 * just how many groups have passed or failed, how many must pass, which
 * groups are still deciding, and, once the counts settle it, the outcome
 * `coalitionOutcome` gives.
 */
import {
  coalitionOutcome,
  motionOutcome,
  RESULT_GRACE_MINUTES,
  seatCounts,
  seatResult,
  UNANIMOUS_UP_TO,
} from './coalition';
import type { GroupResultValue } from './event';
import type { GroupState } from './fold';

/** One member group as a motion's progress lists it: its name there, and what it reported. */
export interface GroupStanding {
  readonly name: string;
  /** Its result, a contested seat counting as a fail, or null while it hasn't reported. */
  readonly result: GroupResultValue | null;
}

/**
 * A coalition motion's progress (#120): how many groups decide it, how many
 * have passed and failed (a contested group counts once, as a fail), how
 * many passes it needs, the names of the groups still deciding, and each
 * group in seat order. `mine` is what the viewer's own group reported, when
 * a seat is given and it has. `outcome` is set once the counts decide it,
 * as `coalitionOutcome` does. A fail is final at once; a pass becomes `final`
 * at `settles`, its deadline plus 10,080 minutes, when results stop counting
 * and the coalition's text changes (#100, #250).
 */
export interface CoalitionProgress {
  readonly seats: number;
  readonly passed: number;
  readonly failed: number;
  readonly needed: number;
  readonly deciding: readonly string[];
  readonly mine?: GroupResultValue;
  readonly outcome?: GroupResultValue;
  readonly groups: readonly GroupStanding[];
  readonly final: boolean;
  readonly settles: number;
}

/**
 * How many of `seats` must pass: every one up to 4, or for a motion that
 * needs every seat (#114), else the fewest that make 3·passes ≥ 2·N, in
 * integers, as `coalitionOutcome` counts.
 */
export function passesNeeded(seats: number, everySeat: boolean): number {
  if (everySeat || seats <= UNANIMOUS_UP_TO) return seats;
  let needed = 0;
  while (3 * needed < 2 * seats) needed += 1;
  return needed;
}

/**
 * The progress of motion `motionId` in `coalition`'s folded state, read as
 * the group whose seat key is `mySeat`, if given; null when the coalition
 * holds no such motion, or `coalition` is a group's state. It reads relay
 * time from the state's `at`.
 */
export function coalitionProgress(
  coalition: GroupState,
  motionId: string,
  mySeat?: string,
): CoalitionProgress | null {
  const info = coalition.coalition;
  const motion = info?.motions.find((m) => m.id === motionId);
  if (info === null || motion === undefined) return null;
  const { results } = info;
  const names = new Map(info.seats.map((seat) => [seat.key, seat.name]));
  const groups = motion.seats.map((key) => ({
    name: names.get(key) ?? '',
    result: seatResult(results, motionId, key),
  }));
  const { passes, fails } = seatCounts(results, motionId, motion.seats);
  const everySeat = motion.admit !== null;
  const settles = motion.deadline + RESULT_GRACE_MINUTES;
  const expired = coalition.at >= settles;
  const { kind } = coalitionOutcome({ seats: groups.length, passes, fails, expired, everySeat });
  const mine = mySeat === undefined ? null : seatResult(results, motionId, mySeat);
  return {
    seats: groups.length,
    passed: passes,
    failed: fails,
    needed: passesNeeded(groups.length, everySeat),
    deciding: groups.filter((g) => g.result === null).map((g) => g.name),
    ...(mine === null ? {} : { mine }),
    ...(kind === 'open' ? {} : { outcome: kind }),
    groups,
    final: kind === 'fail' || (kind === 'pass' && expired),
    settles,
  };
}

/**
 * The relay minute the coalition decided motion `motionId` (#104): a pass
 * when it became final, at its deadline plus 10,080 minutes, when results
 * stop counting and the coalition's text changes; a fail at the receipt of
 * the result that failed it, or, when it failed for want of results, at that
 * same minute. Null when the coalition holds no such motion, or `coalition`
 * is a group's state.
 */
export function motionDecidedAt(coalition: GroupState, motionId: string): number | null {
  const info = coalition.coalition;
  const motion = info?.motions.find((m) => m.id === motionId);
  if (info === null || motion === undefined) return null;
  const results = info.results.filter((r) => r.motion === motionId);
  const failing = results.find((_, i) => {
    const sofar = { results: results.slice(0, i + 1), motions: info.motions };
    return motionOutcome(sofar, motionId, false).kind === 'fail';
  });
  return failing?.received ?? motion.deadline + RESULT_GRACE_MINUTES;
}
