/**
 * What a group's screens say of its coalitions (#114), apart from any
 * component: group home's Coalitions rows, a reconcile Proposal's card and
 * the words of a coalition motion opened in the group.
 *
 * Everything comes from folded logs on this device: the group's own, with
 * its reconcile Proposals' seats and outcomes, and each coalition entry's.
 */
import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { can } from '../engine/capabilities';
import { seatResult } from '../engine/coalition';
import { resultMismatches } from '../engine/crossing';
import type { ReconcileTarget, SeatEntry } from '../engine/event';
import type { GroupState, HeldSeat, Proposal } from '../engine/fold';
import type { HeldCoalition } from '../store/coalitions';

/** One line under a coalition's name: whom it waits for, or who didn't pass it. */
export type CoalitionLine =
  | { readonly kind: 'waiting'; readonly group: string }
  | { readonly kind: 'didnt-pass'; readonly group: string }
  | { readonly kind: 'waiting-card' }
  | { readonly kind: 'lapsed' };

/** How this person stands in a coalition: in it as `name`, joining, free to take part, or neither. */
export type CoalitionMe =
  | { readonly kind: 'in'; readonly name: string }
  | { readonly kind: 'joining' }
  | { readonly kind: 'may-take-part' }
  | { readonly kind: 'none' };

/** A coalition as group home lists it. */
export interface CoalitionRow {
  /** The coalition's entry on this device. */
  readonly entryId: string;
  /** The group's reconcile Proposal it came from. */
  readonly proposal: string;
  /** Its name: the genesis's once there is one, else the Proposal's. */
  readonly name: string;
  readonly status: 'forming' | 'formed' | 'declined';
  readonly lines: readonly CoalitionLine[];
  /** The member groups, in seat order, once it has formed. */
  readonly members: readonly string[];
  readonly me: CoalitionMe;
  /** Whether this person may make a card from it for another group: they take part in it. */
  readonly makesCards: boolean;
  /** How many results the coalition recorded for this group that its own vote doesn't match. */
  readonly mismatches: number;
}

/** The reconcile target of the group's Proposal `id`, or null. */
function targetOf(state: GroupState, id: string): ReconcileTarget | null {
  const target = state.proposals.find((p) => p.id === id)?.target;
  return target?.kind === 'reconcile' ? target : null;
}

/** The coalition entry on this device for the coalition whose secret is `secret`, in base64url. */
export function coalitionFor(
  coalitions: readonly HeldCoalition[],
  secret: string,
): HeldCoalition | undefined {
  const id = deriveCoalitionEntryId(fromBase64url(secret));
  return coalitions.find(({ entry }) => entry.groupId === id);
}

/** Lines for a coalition with no genesis yet: the group's own vote, then the card waiting. */
function beforeGenesis(state: GroupState, held: HeldSeat): Pick<CoalitionRow, 'status' | 'lines'> {
  if (held.outcome === 'fail') {
    return { status: 'declined', lines: [{ kind: 'didnt-pass', group: state.name }] };
  }
  const own: CoalitionLine[] =
    held.outcome === 'open' ? [{ kind: 'waiting', group: state.name }] : [];
  return { status: 'forming', lines: [...own, { kind: 'waiting-card' }] };
}

/** One line per seat: whom `motion` still waits for, and who failed it. */
function seatLines(
  coalition: GroupState,
  motion: string,
  seats: readonly SeatEntry[],
): CoalitionLine[] {
  const results = coalition.coalition?.results ?? [];
  return seats.flatMap((seat): CoalitionLine[] => {
    const result = seatResult(results, motion, seat.key);
    if (result === 'fail') return [{ kind: 'didnt-pass', group: seat.name }];
    return result === null ? [{ kind: 'waiting', group: seat.name }] : [];
  });
}

/** The status and lines of a coalition whose genesis names this group's seat. */
function seated(coalition: GroupState): Pick<CoalitionRow, 'status' | 'lines'> {
  const info = coalition.coalition;
  const status = info?.status ?? 'forming';
  if (status === 'formed' || coalition.group === null || info === null)
    return { status, lines: [] };
  const founding = info.seats.filter((seat) => !info.admitted.some((a) => a.key === seat.key));
  const lines = seatLines(coalition, coalition.group, founding);
  if (status === 'forming') return { status, lines };
  const failed = lines.filter((line) => line.kind === 'didnt-pass');
  return { status, lines: failed.length > 0 ? failed : [{ kind: 'lapsed' }] };
}

/** The status and lines of a formed coalition this group asks to be admitted into. */
function admitting(
  state: GroupState,
  held: HeldSeat,
  coalition: GroupState,
): Pick<CoalitionRow, 'status' | 'lines'> {
  if (held.outcome !== 'pass') return beforeGenesis(state, held);
  const motion = coalition.coalition?.motions.find((m) => m.admit?.key === held.key);
  const decided = coalition.proposals.find((p) => p.id === motion?.id);
  if (motion === undefined || decided === undefined) {
    return { status: 'forming', lines: [] };
  }
  const seats = (coalition.coalition?.seats ?? []).filter((s) => motion.seats.includes(s.key));
  const lines = seatLines(coalition, motion.id, seats);
  const failed = decided.final && decided.outcome.kind !== 'pass';
  return failed
    ? { status: 'declined', lines: lines.filter((line) => line.kind === 'didnt-pass') }
    : { status: 'forming', lines };
}

/** How `me` stands in the coalition, for group home's row. */
function meIn(state: GroupState, me: string, held: HeldCoalition, open: boolean): CoalitionMe {
  const { entry, state: coalition } = held;
  const bound = coalition.coalition?.bindings.some((b) => b.author === entry.me.author);
  const member = coalition.members.find((m) => m.author === entry.me.author);
  if (bound === true && member !== undefined) return { kind: 'in', name: member.name };
  if (entry.joinAs === state.group || entry.outbox.length > 0) return { kind: 'joining' };
  return open && can(state, me, 'propose') ? { kind: 'may-take-part' } : { kind: 'none' };
}

/** Where the coalition stands for the group's seat `held`: before a genesis, asking in, or seated. */
function standingOf(
  state: GroupState,
  held: HeldSeat,
  coalition: GroupState,
  seat: SeatEntry | undefined,
): Pick<CoalitionRow, 'status' | 'lines'> {
  if (coalition.group === null) return beforeGenesis(state, held);
  return seat === undefined ? admitting(state, held, coalition) : seated(coalition);
}

/** One coalition row for the group's reconcile Proposal `held`, or null with no entry yet. */
function rowOf(
  state: GroupState,
  author: string,
  held: HeldSeat,
  coalitions: readonly HeldCoalition[],
): CoalitionRow | null {
  const target = targetOf(state, held.proposal);
  const entry = target === null ? undefined : coalitionFor(coalitions, target.secret);
  if (entry === undefined) return null;
  const coalition = entry.state;
  const seat = coalition.coalition?.seats.find((s) => s.key === held.key);
  const standing = standingOf(state, held, coalition, seat);
  const me = meIn(state, author, entry, seat !== undefined && standing.status !== 'declined');
  return {
    entryId: entry.entry.groupId,
    proposal: held.proposal,
    name: coalition.group === null ? held.name : coalition.name,
    ...standing,
    ...membership(state, coalition, standing.status === 'formed', me),
    me,
    mismatches: seat === undefined ? 0 : resultMismatches(state, coalition, held.key).length,
  };
}

/** A formed coalition's member groups, and whether this person, taking part, may make cards. */
function membership(
  state: GroupState,
  coalition: GroupState,
  formed: boolean,
  me: CoalitionMe,
): Pick<CoalitionRow, 'members' | 'makesCards'> {
  if (!formed) return { members: [], makesCards: false };
  const members = (coalition.coalition?.seats ?? []).map((s) => s.name);
  return { members, makesCards: me.kind === 'in' && state.dissolved === null };
}

/**
 * Group home's Coalitions (#114): one row per reconcile Proposal of the
 * group that holds a coalition entry on this device, newest last. `state`
 * should be folded with the coalitions' motions (`foldGroup`).
 */
export function coalitionRows(
  state: GroupState,
  me: string,
  coalitions: readonly HeldCoalition[],
): CoalitionRow[] {
  return state.coalitions.flatMap((held) => {
    const row = rowOf(state, me, held, coalitions);
    return row === null ? [] : [row];
  });
}

/** What a reconcile Proposal shows of its coalition: the card's words, and the other groups once named. */
export interface ReconcileView {
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
  /** The coalition's other groups once its genesis names them, else null. */
  readonly others: readonly string[] | null;
}

/** The coalition a reconcile Proposal proposes, or null for any other Proposal. */
export function reconcileView(
  proposal: Pick<Proposal, 'target'>,
  coalitions: readonly HeldCoalition[],
): ReconcileView | null {
  const { target } = proposal;
  if (target.kind !== 'reconcile') return null;
  const coalition = coalitionFor(coalitions, target.secret)?.state;
  const seats = coalition?.group === null ? undefined : coalition?.coalition?.seats;
  const others = seats === undefined ? null : seats.filter((s) => s.key !== target.key);
  return {
    name: target.name,
    title: target.title,
    atoms: target.atoms,
    others: others === null ? null : others.map((s) => s.name),
  };
}

/** A coalition motion's words, from the coalition's log: its title, why, the coalition, and any group it admits. */
export interface MotionWords {
  readonly title: string;
  readonly why: string;
  readonly coalition: string;
  readonly admits: string | null;
}

/** The words of the coalition motion `proposal`, or null for any other Proposal, or one not read yet. */
export function motionWords(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): MotionWords | null {
  const { target } = proposal;
  if (target.kind !== 'motion') return null;
  const coalition = coalitions.find(({ state }) => state.group === target.coalition)?.state;
  const motion = coalition?.proposals.find((p) => p.id === proposal.id);
  if (coalition === undefined || motion === undefined) return null;
  const admits = motion.target.kind === 'admit' ? motion.target.seat.name : null;
  return { title: motion.title, why: motion.why, coalition: coalition.name, admits };
}

/**
 * `state` with each coalition motion's title and why read from its
 * coalition (#114), so every list and card names it as the coalition does.
 */
export function withMotionWords(
  state: GroupState,
  coalitions: readonly HeldCoalition[],
): GroupState {
  if (!state.proposals.some((p) => p.target.kind === 'motion')) return state;
  const proposals = state.proposals.map((p) => {
    const words = motionWords(p, coalitions);
    return words === null ? p : { ...p, title: words.title, why: words.why };
  });
  return { ...state, proposals };
}
