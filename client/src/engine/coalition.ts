/**
 * Coalitions (docs/spec/phase-1-spec.md §4 Coalitions; ADR-0036, ADR-0074, ADR-0075 §1; #100).
 *
 * A coalition is a log of its own, folded like a group's, whose members are
 * groups. Each member group holds a seat: a keypair whose public key the
 * coalition's genesis names and whose secret only that group's sealed log
 * holds. A motion opens as a Proposal in every member group, which decides it
 * with its own ballots, and only a signed pass or fail crosses back, as a
 * `group-result`. This module holds the coalition's own rules; fold.ts folds
 * its log and crossing.ts moves motions and results across group lines.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { seatKeyOf, verifySeatProof } from '../crypto/seat';
import type {
  AdmitTarget,
  CoalitionGenesisBody,
  GroupResultBody,
  GroupResultValue,
  JoinBody,
  ReconcileTarget,
  SeatEntry,
} from './event';
import { type Bar, DAY_MINUTES, type ProposalClass, type Rules } from './rules';

/** How long after a motion's deadline its results still count: 7 days, in relay minutes. */
export const RESULT_GRACE_MINUTES = 7 * DAY_MINUTES;

/** The largest coalition in which every seat must pass. From one more, two-thirds will do. */
export const UNANIMOUS_UP_TO = 4;

/**
 * What a coalition's seats have reported on one motion: how many seats its
 * snapshot holds, how many passed and how many failed (a contested seat
 * counts as a fail), and whether it has expired, at deadline + 10,080
 * minutes, when every missing result counts as a fail. `everySeat` is true
 * for a motion that needs every seat whatever the coalition's size, as
 * admitting a group does (#114).
 */
export interface SeatCounts {
  readonly seats: number;
  readonly passes: number;
  readonly fails: number;
  readonly expired: boolean;
  readonly everySeat?: boolean;
}

/** A coalition motion's outcome: open while it could still go either way. */
export interface CoalitionOutcome {
  readonly kind: 'pass' | 'fail' | 'open';
}

/**
 * The outcome of a coalition motion over N seats, in integers (ADR-0036). Up
 * to 4 seats it passes when every seat passes and fails at the first fail.
 * From 5 it passes once 3·passes ≥ 2·N and fails once 3·(N − fails) < 2·N, so
 * no one group blocks it. A motion that needs every seat (#114) is decided as
 * at 4 seats or fewer, whatever N. Once expired, every missing result counts
 * as a fail. A fail wins should the counts ever say both, which distinct
 * seats never do.
 */
export function coalitionOutcome(counts: SeatCounts): CoalitionOutcome {
  const { seats, passes, fails, expired, everySeat = false } = counts;
  const counted = expired ? seats - passes : fails;
  const unanimous = everySeat || seats <= UNANIMOUS_UP_TO;
  const failed = unanimous ? counted > 0 : 3 * (seats - counted) < 2 * seats;
  if (failed) return { kind: 'fail' };
  const passed = unanimous ? passes >= seats : 3 * passes >= 2 * seats;
  return passed ? { kind: 'pass' } : { kind: 'open' };
}

/**
 * Whether a coalition is still waiting for its founding groups, has formed,
 * or was declined: a founding seat failed its genesis, or results on it
 * stopped counting before every seat had passed.
 */
export type CoalitionStatus = 'forming' | 'formed' | 'declined';

/** Which seat a participant joined under (ADR-0075 §5: followers may read it, #124). */
export interface SeatBinding {
  readonly author: string;
  readonly seat: string;
}

/**
 * One recorded `group-result` (#100): where the relay put it, the participant
 * who posted it, and its motion, seat and result. `motion` is a motion's id,
 * or the coalition's genesis id for the reconcile result.
 */
export interface GroupResult {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly motion: string;
  readonly seat: GroupResultBody['seat'];
  readonly result: GroupResultValue;
}

/**
 * A motion's deadline, and the seats in its snapshot at receipt: who decides
 * it. `admit` is the seat an admit motion would add (#114), or null for an
 * edit.
 */
export interface MotionSeats {
  readonly id: string;
  readonly deadline: number;
  readonly seats: readonly string[];
  readonly admit: SeatEntry | null;
}

/**
 * A group admitted into a formed coalition (#114): the admit motion that
 * admitted it, its public seat key, and the relay minute its pass became
 * final, when it took its seat.
 */
export interface Admission {
  readonly motion: string;
  readonly key: string;
  readonly at: number;
}

/**
 * What a coalition's fold keeps beside a group's state (#100).
 *
 * `status` is as of the state's `at`. `declinedAt` is the relay minute it was
 * declined, at which relay time stops, or null. `seats` are the genesis's,
 * then each admitted group's, in the order they were admitted (#114), and
 * `founding` its name and its one Document's title and Atoms as written
 * (#92), which each founding group checks against the target it passed.
 * `formsBy` is the relay minute from which results on the genesis no longer
 * count: the latest a founding group's reconcile vote can close,
 * `windows.ordinary.max` days after the genesis, plus
 * {@link RESULT_GRACE_MINUTES}. `bindings` holds every
 * participant's seat in join order, and `results` every valid result in relay
 * order. `motions` holds each motion's snapshot of seats, and `admitted`
 * each group admitted after the genesis, in order (#114).
 */
export interface Coalition {
  readonly status: CoalitionStatus;
  readonly declinedAt: number | null;
  readonly seats: readonly SeatEntry[];
  readonly founding: CoalitionStatement;
  readonly formsBy: number;
  readonly bindings: readonly SeatBinding[];
  readonly results: readonly GroupResult[];
  readonly motions: readonly MotionSeats[];
  readonly admitted: readonly Admission[];
}

/**
 * What a coalition is founded on, as its genesis wrote it: its name, and its
 * one Document's title and Atoms (#92), the statement each founding group's
 * reconcile Proposal passed.
 */
export interface CoalitionStatement {
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
}

/** A {@link Coalition} while the fold runs. */
export interface CoalitionDraft extends Omit<
  Coalition,
  'status' | 'declinedAt' | 'seats' | 'bindings' | 'results' | 'motions' | 'admitted'
> {
  status: CoalitionStatus;
  declinedAt: number | null;
  readonly seats: SeatEntry[];
  readonly bindings: SeatBinding[];
  readonly results: GroupResult[];
  readonly motions: MotionSeats[];
  readonly admitted: Admission[];
}

/**
 * A group's reconcile target as the fold keeps it on the Proposal (#100): as
 * written, secrets included, plus `key`, the public seat key its seat secret
 * makes. Only the group's own log, and the state folded from it, hold it.
 */
export interface ReconcileChange extends ReconcileTarget {
  readonly key: string;
}

/**
 * A coalition motion that would admit a group (#114): the seat it would add.
 * Its author, who holds that seat's secret, is the Proposal's `author`.
 */
export interface AdmitChange {
  readonly kind: 'admit';
  readonly seat: SeatEntry;
}

/**
 * A group Proposal that is a coalition motion (#100): the coalition it came
 * from, and the bar the coalition set for it, which the group's ballots are
 * tallied at.
 */
export interface MotionTarget {
  readonly kind: 'motion';
  readonly coalition: string;
  readonly bar: Bar;
}

/**
 * A coalition motion as each member group's fold takes it (#100): its id, the
 * coalition's id, where the relay put it, and the class, window, deadline and
 * bar the coalition gave it. `crossing.ts`'s `motionsFor` makes these, and
 * `fold`'s `outside` opens each as a group Proposal.
 */
export interface Motion {
  readonly id: string;
  readonly coalition: string;
  readonly seq: number;
  readonly received: number;
  readonly class: ProposalClass;
  readonly window: number;
  readonly deadline: number;
  readonly bar: Bar;
}

/** Where an event sits in the relay's log. */
interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/** Two or more seats with distinct keys: what a coalition genesis needs. */
export function seatsAreValid(seats: readonly SeatEntry[]): boolean {
  const keys = new Set(seats.map((seat) => seat.key));
  return seats.length >= 2 && keys.size === seats.length;
}

/**
 * A coalition as its genesis founds it, forming, or null when its seats can't
 * found one or it founds no Document. Its statement is its first Document;
 * the fold founds a coalition only on exactly one (#92).
 */
export function newCoalition(
  body: CoalitionGenesisBody,
  rules: Rules,
  received: number,
): CoalitionDraft | null {
  const [statement] = body.documents;
  if (!seatsAreValid(body.seats) || statement === undefined) return null;
  const { name, seats } = body;
  return {
    status: 'forming',
    declinedAt: null,
    seats: [...seats],
    founding: { name, title: statement.title, atoms: statement.atoms },
    formsBy: received + rules.windows.ordinary.max * DAY_MINUTES + RESULT_GRACE_MINUTES,
    bindings: [],
    results: [],
    motions: [],
    admitted: [],
  };
}

/** The seats the genesis named, which decide it: every seat but those admitted since (#114). */
export function foundingSeats(coalition: Pick<Coalition, 'seats' | 'admitted'>): string[] {
  const admitted = new Set(coalition.admitted.map((a) => a.key));
  return coalition.seats.map((seat) => seat.key).filter((key) => !admitted.has(key));
}

/**
 * Whether `author` may propose admitting `target`'s seat into the formed
 * coalition `coalitionId` (#114): they aren't a participant, the seat isn't
 * one of the coalition's and no earlier admit motion names it, and the
 * seat's proof for their key verifies. So one admit motion per group, from
 * someone who holds its seat secret.
 */
export function mayAdmit(
  coalition: Pick<Coalition, 'seats' | 'motions'>,
  coalitionId: string,
  author: string,
  target: AdmitTarget,
): boolean {
  const { key } = target.seat;
  if (coalition.seats.some((seat) => seat.key === key)) return false;
  if (coalition.motions.some((m) => m.admit?.key === key)) return false;
  return verifySeatProof(
    fromBase64url(key),
    fromBase64url(target.proof),
    coalitionId,
    fromBase64url(author),
  );
}

/**
 * Seats the group an admit motion names once its pass is final (#114): its
 * seat joins the coalition's, after those already there, at relay minute
 * `at`. Its people then join under it as anyone joins.
 */
export function admitSeat(coalition: CoalitionDraft, motion: MotionSeats, at: number): void {
  if (motion.admit === null || coalition.admitted.some((a) => a.motion === motion.id)) return;
  coalition.seats.push(motion.admit);
  coalition.admitted.push({ motion: motion.id, key: motion.admit.key, at });
}

/** The public seat key, in base64url, that a reconcile target's seat secret makes. */
export function seatKeyFor(target: Pick<ReconcileTarget, 'seat'>): string {
  return base64url(seatKeyOf(fromBase64url(target.seat)));
}

/**
 * Whether a join binds its author to a seat of the coalition `coalitionId`:
 * it names one of the coalition's seats, and that seat's proof for the
 * author's key verifies (`crypto/seat.ts`). The proof shows the group, never
 * the person.
 */
export function bindsSeat(
  coalition: Pick<Coalition, 'seats'>,
  coalitionId: string,
  author: string,
  seat: NonNullable<JoinBody['seat']>,
  proof: NonNullable<JoinBody['proof']>,
): boolean {
  if (!coalition.seats.some((entry) => entry.key === seat)) return false;
  return verifySeatProof(
    fromBase64url(seat),
    fromBase64url(proof),
    coalitionId,
    fromBase64url(author),
  );
}

/**
 * The seats that decide `motion`: the genesis's founding seats for the
 * genesis id, never one admitted since (#114), else the motion's snapshot.
 */
export function seatsDeciding(
  coalition: Pick<Coalition, 'seats' | 'motions' | 'admitted'>,
  coalitionId: string,
  motion: string,
): readonly string[] {
  if (motion === coalitionId) return foundingSeats(coalition);
  return coalition.motions.find((m) => m.id === motion)?.seats ?? [];
}

/** The relay minute from which results on `motion` no longer count, or null for no such motion. */
function resultsEnd(
  coalition: Pick<Coalition, 'formsBy' | 'motions'>,
  coalitionId: string,
  motion: string,
): number | null {
  if (motion === coalitionId) return coalition.formsBy;
  const found = coalition.motions.find((m) => m.id === motion);
  return found === undefined ? null : found.deadline + RESULT_GRACE_MINUTES;
}

/** Whether results on `motion` still count at relay minute `at`. */
export function resultsCount(
  coalition: Pick<Coalition, 'formsBy' | 'motions'>,
  coalitionId: string,
  motion: string,
  at: number,
): boolean {
  const end = resultsEnd(coalition, coalitionId, motion);
  return end !== null && at < end;
}

/**
 * Whether `author` may post `body` now (#100): a current participant bound
 * to its seat, the seat among those deciding the motion, while results on it
 * still count, and not a repeat of a result already recorded for that motion
 * and seat.
 */
function mayReport(
  coalition: CoalitionDraft,
  coalitionId: string,
  author: string,
  body: GroupResultBody,
  received: number,
): boolean {
  const { motion, seat, result } = body;
  const bound = coalition.bindings.some((b) => b.author === author && b.seat === seat);
  if (!bound || !seatsDeciding(coalition, coalitionId, motion).includes(seat)) return false;
  if (!resultsCount(coalition, coalitionId, motion, received)) return false;
  return !coalition.results.some(
    (r) => r.motion === motion && r.seat === seat && r.result === result,
  );
}

/**
 * Records a result when its author, a current participant, may post it
 * ({@link mayReport}); on the genesis id it moves the coalition's status at
 * once. Returns whether it was recorded.
 */
export function recordResult(
  coalition: CoalitionDraft,
  coalitionId: string,
  author: string,
  body: GroupResultBody,
  at: Receipt,
): boolean {
  if (!mayReport(coalition, coalitionId, author, body, at.received)) return false;
  coalition.results.push({ ...at, by: author, ...body });
  if (body.motion === coalitionId) {
    coalition.status = formation(coalition, coalitionId);
    if (coalition.status === 'declined') coalition.declinedAt = at.received;
  }
  return true;
}

/**
 * What one seat has reported on `motion`: `fail` if it ever reported a fail,
 * so a contested seat counts as one, else `pass` if it reported a pass, else
 * null. So a seat-secret holder can block a motion but never pass one.
 */
export function seatResult(
  results: readonly GroupResult[],
  motion: string,
  seat: string,
): GroupResultValue | null {
  const reported = results.filter((r) => r.motion === motion && r.seat === seat);
  if (reported.some((r) => r.result === 'fail')) return 'fail';
  return reported.length > 0 ? 'pass' : null;
}

/** How many of `seats` passed and failed `motion`, each seat counted once by {@link seatResult}. */
export function seatCounts(
  results: readonly GroupResult[],
  motion: string,
  seats: readonly string[],
): { readonly passes: number; readonly fails: number } {
  const each = seats.map((seat) => seatResult(results, motion, seat));
  return {
    passes: each.filter((r) => r === 'pass').length,
    fails: each.filter((r) => r === 'fail').length,
  };
}

/**
 * The coalition's status from its genesis results so far: declined once any
 * founding seat fails, formed once every one has passed, else forming.
 * Forming needs every founding group, however many there are (ADR-0036).
 */
function formation(coalition: CoalitionDraft, coalitionId: string): CoalitionStatus {
  const seats = foundingSeats(coalition);
  const { passes, fails } = seatCounts(coalition.results, coalitionId, seats);
  if (fails > 0) return 'declined';
  return passes === seats.length ? 'formed' : 'forming';
}

/**
 * Declines a coalition still forming once relay time reaches `formsBy`, when
 * results on its genesis stop counting. Relay time stops there.
 */
export function expireFormation(coalition: CoalitionDraft, at: number): void {
  if (coalition.status === 'forming' && at >= coalition.formsBy) {
    coalition.status = 'declined';
    coalition.declinedAt = coalition.formsBy;
  }
}

/**
 * A motion's outcome from the results recorded so far, over the seats in its
 * snapshot; `expired` once relay time has reached its deadline + 10,080. An
 * admit motion needs every seat in its snapshot, however many (#114).
 */
export function motionOutcome(
  coalition: Pick<Coalition, 'results' | 'motions'>,
  motion: string,
  expired: boolean,
): CoalitionOutcome {
  const found = coalition.motions.find((m) => m.id === motion);
  const seats = found?.seats ?? [];
  const counts = seatCounts(coalition.results, motion, seats);
  const everySeat = (found?.admit ?? null) !== null;
  return coalitionOutcome({ seats: seats.length, ...counts, expired, everySeat });
}
