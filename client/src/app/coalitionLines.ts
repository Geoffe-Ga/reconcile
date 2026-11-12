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
import { can, isOusted } from '../engine/capabilities';
import { seatResult } from '../engine/coalition';
import { coalitionProgress, type CoalitionProgress } from '../engine/coalitionProgress';
import { resultMismatches, seatIn } from '../engine/crossing';
import type { ReconcileTarget, SeatEntry } from '../engine/event';
import type { GroupState, HeldSeat, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
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
  /** The coalition's genesis id, whose home opens from the row (#120), or null before one. */
  readonly coalitionId: string | null;
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
    coalitionId: coalition.group,
    name: coalition.group === null ? held.name : coalition.name,
    ...standing,
    ...membership(coalition, standing.status === 'formed', me, actsForGroup(state, author)),
    me,
    mismatches: seat === undefined ? 0 : resultMismatches(state, coalition, held.key).length,
  };
}

/** A formed coalition's member groups, and whether this person, taking part, may make cards. */
function membership(
  coalition: GroupState,
  formed: boolean,
  me: CoalitionMe,
  live: boolean,
): Pick<CoalitionRow, 'members' | 'makesCards'> {
  if (!formed) return { members: [], makesCards: false };
  const members = (coalition.coalition?.seats ?? []).map((s) => s.name);
  return { members, makesCards: me.kind === 'in' && live };
}

/**
 * Whether `author` still acts for the group here: it hasn't dissolved (#108),
 * they're in it, and no removal of them has passed (#115). Only then does
 * their device make cards for its coalitions.
 */
function actsForGroup(state: GroupState, author: string): boolean {
  return state.dissolved === null && can(state, author, 'read') && !isOusted(state, author);
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

/**
 * A coalition motion's words, from the coalition's log: its title, why, the
 * coalition's name and id, any group it admits, its proposer's key there,
 * and, for an edit, its new text and discussion link (#120).
 */
export interface MotionWords {
  readonly title: string;
  readonly why: string;
  readonly coalition: string;
  readonly coalitionId: string;
  readonly admits: string | null;
  readonly text: string;
  readonly link: string | null;
  /** The proposer's key in the coalition, whose name only the coalition's own state holds. */
  readonly author: string;
}

/** The coalition `target` names, and its own Proposal `id` there, or null when this device lacks either. */
function motionIn(
  id: string,
  target: Proposal['target'],
  coalitions: readonly HeldCoalition[],
): { readonly coalition: GroupState; readonly motion: Proposal } | null {
  if (target.kind !== 'motion') return null;
  const coalition = coalitions.find(({ state }) => state.group === target.coalition)?.state;
  const motion = coalition?.proposals.find((p) => p.id === id);
  return coalition === undefined || motion === undefined ? null : { coalition, motion };
}

/** The words of the coalition motion `proposal`, or null for any other Proposal, or one not read yet. */
export function motionWords(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): MotionWords | null {
  const found = motionIn(proposal.id, proposal.target, coalitions);
  if (found === null) return null;
  const { coalition, motion } = found;
  const admits = motion.target.kind === 'admit' ? motion.target.seat.name : null;
  return {
    title: motion.title,
    why: motion.why,
    coalition: coalition.name,
    coalitionId: coalition.group ?? '',
    admits,
    text: motion.text,
    link: motion.link,
    author: motion.author,
  };
}

/**
 * `state` with each coalition motion's title, why, text and link read from
 * its coalition (#114, #120), so every list, card and ballot shows it as the
 * coalition wrote it: an edit's one version carries its new text, and its
 * proposer's coalition key, which the screens name from the coalition's
 * state (`versionViews`' `names`).
 */
export function withMotionWords(
  state: GroupState,
  coalitions: readonly HeldCoalition[],
): GroupState {
  if (!state.proposals.some((p) => p.target.kind === 'motion')) return state;
  const proposals = state.proposals.map((p) => {
    const words = motionWords(p, coalitions);
    if (words === null) return p;
    const { title, why, text, link, author } = words;
    const versions = p.versions.map((v, i) => (i === 0 ? { ...v, text, author } : v));
    return { ...p, title, why, text, link, versions };
  });
  return { ...state, proposals };
}

/**
 * A coalition motion as a member group's Proposal view shows it (#120): the
 * coalition's id, name and folded state, its own Proposal there, its
 * progress read for the group's seat, the proposer's coalition name, and
 * the section it rewords as the coalition's Document reads now, numbered
 * within its Document, or null for an admission or a section that's gone.
 */
export interface MotionView {
  readonly coalitionId: string;
  readonly coalition: string;
  readonly state: GroupState;
  readonly motion: Proposal;
  readonly progress: CoalitionProgress;
  readonly author: string;
  readonly section: { readonly number: number; readonly text: string } | null;
}

/** The section of the coalition's Document that `motion` rewords, as it reads now, or null. */
function sectionOf(coalition: GroupState, motion: Proposal): MotionView['section'] {
  const atom = coalition.atoms.find((a) => a.id === motion.atom);
  if (atom === undefined) return null;
  const sections = coalition.atoms.filter((a) => a.documentId === atom.documentId);
  return { number: sections.indexOf(atom) + 1, text: atom.text };
}

/**
 * The coalition motion `proposal` as group `group` sees it, or null for any
 * other Proposal, or one whose coalition this device hasn't read.
 */
export function motionView(
  proposal: Pick<Proposal, 'id' | 'target'>,
  group: Pick<GroupState, 'coalitions'>,
  coalitions: readonly HeldCoalition[],
): MotionView | null {
  const found = motionIn(proposal.id, proposal.target, coalitions);
  if (found === null) return null;
  const { coalition, motion } = found;
  const progress = coalitionProgress(coalition, motion.id, seatIn(group, coalition) ?? undefined);
  if (progress === null) return null;
  return {
    coalitionId: coalition.group ?? '',
    coalition: coalition.name,
    state: coalition,
    motion,
    progress,
    author: displayName(coalition, motion.author) ?? '',
    section: sectionOf(coalition, motion),
  };
}
