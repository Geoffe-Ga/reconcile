/**
 * Stewards and suspensions (docs/spec/phase-1-spec.md §4 and §11; ADR-0016,
 * ADR-0049, ADR-0059, ADR-0072 §4, ADR-0075 §3; #102).
 *
 * A steward is an elected capability, not a level. A group has two seats:
 * seat 1, which the founder holds from genesis with no term until the group
 * elects someone, and seat 2, which opens at `secondSeatAt` voting members.
 * Elections and recalls are ordinary Proposals with a steward target, and the
 * steward being recalled doesn't vote on their own recall. A holder of a seat
 * can suspend another member at once: for `suspensionDays`, everyone sees it,
 * and the suspended member keeps only reading. A steward holds one suspension
 * at a time, can't suspend while a recall against them is open, and nobody is
 * suspended again within 30 days of their last suspension ending.
 *
 * The fold and the screens ask the same functions here, so a screen never
 * offers what the fold would ignore. Every rule reads relay time (`at`), and
 * this file reads only the few fields it names.
 */
import { can, isSuspended, type Roster, votingRightsCount, wouldVote } from './capabilities';
import { DAY_MINUTES, type Rules } from './rules';
import { codePointLength } from './text';

/** The steward seats, in order (ADR-0049). */
export const SEATS = [1, 2] as const;

/** A steward seat's number. */
export type SeatNumber = (typeof SEATS)[number];

/** The longest suspension reason, in code points (ADR-0072 §4). */
export const REASON_MAX = 280;

/** How long after a suspension ends before the same person can be suspended again, in days (ADR-0075 §3). */
export const SUSPENSION_GAP_DAYS = 30;

/**
 * Seat 2's first-ever term, in days: half of `termDays` (182), so the two
 * seats come due about three months apart (ADR-0049). The engine counts in
 * whole numbers and never divides, so the half is written out, and a test
 * keeps it at half the default term.
 */
export const FIRST_SECOND_SEAT_TERM_DAYS = 91;

/**
 * One steward seat. `holder` is null while it's empty. `termEnd` is the relay
 * minute the holder's term ends, or null for the founder's hold before the
 * first election, and for an empty seat. Past it, the holder keeps the seat
 * until a successor is seated. `elected` is true once an election has ever
 * filled the seat.
 */
export interface Seat {
  readonly seat: SeatNumber;
  readonly holder: string | null;
  readonly termEnd: number | null;
  readonly elected: boolean;
}

/** Both seats empty, as a group's state starts before genesis. */
export const EMPTY_SEATS: readonly Seat[] = SEATS.map((seat) => ({
  seat,
  holder: null,
  termEnd: null,
  elected: false,
}));

/**
 * What a steward Proposal changes, as the fold records it when it opens: the
 * nominee, or null for a recall, and `holder`, whoever held the seat then, so
 * a recall names the steward it would remove.
 */
export interface StewardChange {
  readonly kind: 'steward';
  readonly seat: SeatNumber;
  readonly member: string | null;
  readonly holder: string | null;
}

/**
 * What a Proposal changes: an Atom's text (#63, #72), a steward seat (#102),
 * or nothing, for a priority vote, whose top option becomes the focus (#107).
 */
export type ProposalTarget =
  { readonly kind: 'edit' } | StewardChange | { readonly kind: 'priority' };

/**
 * A suspension, from the relay's receipt of its `suspend` until `until`, that
 * minute plus `suspensionDays` × 1,440. `by` is the steward who wrote it,
 * and `reason` what they wrote, or null.
 */
export interface Suspension {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly member: string;
  readonly reason: string | null;
  readonly until: number;
}

/** What the steward rules read of a Proposal: its target, and when it closes. */
export interface StewardProposalState {
  readonly target: ProposalTarget;
  readonly deadline: number;
  readonly closedAt: number | null;
}

/** What the steward rules read of a group, at relay minute `at`. */
export interface StewardState extends Roster {
  readonly rules: Rules;
  readonly stewards: readonly Seat[];
  readonly suspensions: readonly Suspension[];
  readonly proposals: readonly StewardProposalState[];
}

/** True when `seat` names one of the {@link SEATS}. */
export function isSeatNumber(seat: number): seat is SeatNumber {
  return SEATS.some((known) => known === seat);
}

/** Seat `seat` as the state holds it, or empty. */
export function seatAt(state: Pick<StewardState, 'stewards'>, seat: SeatNumber): Seat {
  return state.stewards.find((s) => s.seat === seat) ?? { seat, ...NO_HOLDER, elected: false };
}

/** The seat `person` holds, if any. */
export function seatOf(state: Pick<StewardState, 'stewards'>, person: string): Seat | undefined {
  return state.stewards.find((s) => s.holder === person);
}

/** A seat's fields once its holder has gone. */
const NO_HOLDER = { holder: null, termEnd: null } as const;

/** The steward change a Proposal makes, or null when it changes an Atom. */
export function stewardChangeOf(proposal: StewardProposalState): StewardChange | null {
  const { target } = proposal;
  return target.kind === 'steward' ? target : null;
}

/** True while a Proposal takes ballots at relay minute `at`: before its deadline and any early close. */
function isOpen(proposal: StewardProposalState, at: number): boolean {
  return proposal.closedAt === null && at < proposal.deadline;
}

/** The steward Proposals open at `state.at`, with what each would change. */
function openChanges(state: StewardState): StewardChange[] {
  return state.proposals.flatMap((p) => {
    const change = stewardChangeOf(p);
    return change !== null && isOpen(p, state.at) ? [change] : [];
  });
}

/** True when a steward Proposal on `seat` is open: a seat takes one at a time. */
export function hasOpenStewardProposal(state: StewardState, seat: SeatNumber): boolean {
  return openChanges(state).some((change) => change.seat === seat);
}

/** True while a recall of `person` is open: they can't suspend meanwhile (ADR-0075 §3). */
export function facesRecall(state: StewardState, person: string): boolean {
  return openChanges(state).some((change) => change.member === null && change.holder === person);
}

/**
 * Whether `seat` exists for an election now (ADR-0049, ADR-0075 §3): seat 2
 * from `secondSeatAt` voting members, and seat 1 from `firstElectionAt` until
 * its first election, then always.
 */
function electionOpens(state: StewardState, seat: SeatNumber): boolean {
  const { firstElectionAt, secondSeatAt } = state.rules.stewards;
  const count = votingRightsCount(state);
  if (seat === 2) return count >= secondSeatAt;
  return seatAt(state, seat).elected || count >= firstElectionAt;
}

/**
 * Whether `person` could take `seat`: their level votes, and they don't hold
 * the other seat. The holder of `seat` itself can take it again.
 */
function canTake(state: StewardState, seat: SeatNumber, person: string): boolean {
  const other = seatOf(state, person);
  return wouldVote(state, person) && (other === undefined || other.seat === seat);
}

/** Whether `person` can stand for `seat` now: they could take it, and they aren't suspended. */
export function canStand(state: StewardState, seat: SeatNumber, person: string): boolean {
  return canTake(state, seat, person) && !isSuspended(state, person);
}

/**
 * Whether a steward Proposal's target is valid now: a seat with no open
 * steward Proposal, and either an election whose seat exists for the group's
 * size and whose nominee can stand, or a recall of a seat someone holds. A
 * recall of seat 1 before its first election also needs `firstElectionAt`
 * voting members, as every steward Proposal on it does.
 */
export function stewardTargetIsValid(
  state: StewardState,
  target: { readonly seat: number; readonly member: string | null },
): boolean {
  const { seat, member } = target;
  if (!isSeatNumber(seat) || hasOpenStewardProposal(state, seat)) return false;
  if (member !== null) return electionOpens(state, seat) && canStand(state, seat, member);
  return seatAt(state, seat).holder !== null && (seat === 2 || electionOpens(state, seat));
}

/** Whether `author` may make a steward Proposal on `target`: they may propose, and it's valid now. */
export function mayProposeSteward(
  state: StewardState,
  author: string,
  target: { readonly seat: number; readonly member: string | null },
): boolean {
  return can(state, author, 'propose') && stewardTargetIsValid(state, target);
}

/** Whether an election on `seat` could open now, for some nominee: the seat exists and has no open steward Proposal. */
export function seatTakesElection(state: StewardState, seat: SeatNumber): boolean {
  return !hasOpenStewardProposal(state, seat) && electionOpens(state, seat);
}

/**
 * Whether a steward election on `seat` is due (ADR-0049): it could open now,
 * and the seat is empty, still held by the founder before its first
 * election, or past its holder's term end.
 */
export function electionDue(state: StewardState, seat: SeatNumber): boolean {
  const { holder, termEnd } = seatAt(state, seat);
  const expired = holder === null || termEnd === null || state.at >= termEnd;
  return expired && seatTakesElection(state, seat);
}

/** The seats whose election is due now, in seat order. */
export function electionsDue(state: StewardState): SeatNumber[] {
  return SEATS.filter((seat) => electionDue(state, seat));
}

/** The suspension of `person` running at `state.at`, if any. */
export function activeSuspension(
  state: Pick<StewardState, 'suspensions' | 'at'>,
  person: string,
): Suspension | undefined {
  return state.suspensions.find((s) => s.member === person && state.at < s.until);
}

/** True when `person` was never suspended, or their last suspension ended more than 30 days ago. */
function gapHasPassed(state: StewardState, person: string): boolean {
  const last = state.suspensions.filter((s) => s.member === person).at(-1);
  return last === undefined || state.at - last.until > SUSPENSION_GAP_DAYS * DAY_MINUTES;
}

/** Whether `author` may suspend anyone now: a seat, no suspension of their own running, no open recall of them. */
export function mayUseSuspend(state: StewardState, author: string): boolean {
  return (
    can(state, author, 'suspend') &&
    !state.suspensions.some((s) => s.by === author && state.at < s.until) &&
    !facesRecall(state, author)
  );
}

/**
 * Whether `author` may suspend `person` now (ADR-0016, ADR-0059, ADR-0075 §3):
 * {@link mayUseSuspend}, and `person` is another current member, not
 * suspended, whose last suspension ended more than 30 days ago.
 */
export function maySuspend(state: StewardState, author: string, person: string): boolean {
  return (
    mayUseSuspend(state, author) &&
    person !== author &&
    state.members.some((m) => m.author === person) &&
    !isSuspended(state, person) &&
    gapHasPassed(state, person)
  );
}

/** True when a suspension's reason, if any, is at most {@link REASON_MAX} code points. */
export function reasonFits(reason: string | null): boolean {
  return reason === null || codePointLength(reason) <= REASON_MAX;
}

/** When a suspension received at relay minute `received` ends: `suspensionDays` × 1,440 later. */
export function suspensionEnd(rules: Rules, received: number): number {
  return received + rules.suspensionDays * DAY_MINUTES;
}

/**
 * The seats once `person` gives up any they hold, on a step down to Member
 * (#102), a leave (#77) or a removal (#115). Whether an election ever filled
 * the seat stays as it was.
 */
export function vacate(seats: readonly Seat[], person: string): Seat[] {
  return seats.map((s) => (s.holder === person ? { ...s, ...NO_HOLDER } : s));
}

/** `seats` with `next` in its place. */
function replace(seats: readonly Seat[], next: Seat): Seat[] {
  return seats.map((s) => (s.seat === next.seat ? next : s));
}

/**
 * The seats once a steward Proposal that opened as `change` passes, closing at
 * relay minute `close`. A recall empties the seat if the steward it named
 * still holds it. An election seats the nominee if their level still votes
 * and they don't hold the other seat, for a term of `termDays` from the
 * close; seat 2's first-ever term runs {@link FIRST_SECOND_SEAT_TERM_DAYS}. A suspension doesn't stop it: a steward can't
 * block an election by suspending the nominee.
 */
export function seatsAfterPass(state: StewardState, change: StewardChange, close: number): Seat[] {
  const seat = seatAt(state, change.seat);
  const { member, holder } = change;
  if (member === null) {
    const recalled = holder !== null && seat.holder === holder;
    return recalled ? vacate(state.stewards, holder) : [...state.stewards];
  }
  if (!canTake(state, seat.seat, member)) return [...state.stewards];
  const { termDays } = state.rules.stewards;
  const days = seat.seat === 2 && !seat.elected ? FIRST_SECOND_SEAT_TERM_DAYS : termDays;
  const termEnd = close + days * DAY_MINUTES;
  return replace(state.stewards, { seat: seat.seat, holder: member, termEnd, elected: true });
}

/**
 * The seats at `state.at` once terms have run out: past its term end, a
 * holder keeps the seat until a successor is seated, which seat 2 can't have
 * below `secondSeatAt` voting members. So a group that has shrunk below that
 * keeps its second steward until the term ends, or until it recalls them.
 */
export function seatsAtTermEnds(state: StewardState): Seat[] {
  const open = votingRightsCount(state) >= state.rules.stewards.secondSeatAt;
  return state.stewards.map((s) =>
    s.seat === 2 && s.termEnd !== null && state.at >= s.termEnd && !open
      ? { ...s, ...NO_HOLDER }
      : s,
  );
}
