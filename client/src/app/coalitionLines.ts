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
import { MAX_LEVEL, seatLevel, seatResult } from '../engine/coalition';
import { coalitionProgress, type CoalitionProgress } from '../engine/coalitionProgress';
import { resultMismatches, seatIn } from '../engine/crossing';
import type { Ceiling, ReconcileTarget, SealedReconcileTarget, SeatEntry } from '../engine/event';
import type { GroupState, HeldSeat, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import {
  type CoalitionKeys,
  type HeldCoalition,
  innerOf,
  misstatesSeat,
} from '../store/coalitions';

/**
 * One line under a coalition's name: whom it waits for, or who didn't pass
 * it. `notPassing` marks the group's own line while its reconcile vote is
 * open, someone has scored it, and its count isn't a pass (#250): read from
 * the group's own ballots on its own members' devices, so never another's.
 * `lapsed` is the close-out: still forming at `formsFinal`, it didn't form.
 */
export type CoalitionLine =
  | { readonly kind: 'waiting'; readonly group: string; readonly notPassing?: true }
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
  /**
   * Whether this person may make a card from it for another coalition (#122):
   * they take part in it, it has formed, one more level stays within 3, and
   * the group's seat gives this device the coalition's `inner`, which seals
   * its seat above: a group admitted later holds none until a seated group's
   * wrap for its seat arrives (#313).
   */
  readonly reconciles: boolean;
  /** How many results the coalition recorded for this group that its own vote doesn't match. */
  readonly mismatches: number;
  /** The coalitions above it that it is in or asks into (#122), each line up in turn. */
  readonly above: readonly AboveRow[];
}

/**
 * A coalition above one of the group's coalitions (#122), as group home
 * lists it under that coalition's row: its name, its home once formed, where
 * it stands for the seat below it, and the chain of names from the group up
 * to it, as in "Riverside Tenants · in Eastside Housing · in Metro Renters".
 */
export interface AboveRow {
  readonly key: string;
  readonly name: string;
  readonly coalitionId: string | null;
  readonly status: CoalitionRow['status'];
  readonly lines: readonly CoalitionLine[];
  readonly chain: readonly string[];
}

/** The reconcile target of the group's Proposal `id`, or null. */
function targetOf(state: GroupState, id: string): ReconcileTarget | null {
  const target = state.proposals.find((p) => p.id === id)?.target;
  return target?.kind === 'reconcile' && 'secret' in target ? target : null;
}

/** The coalition entry on this device for the coalition whose secret is `secret`, in base64url. */
export function coalitionFor(
  coalitions: readonly HeldCoalition[],
  secret: string,
): HeldCoalition | undefined {
  const id = deriveCoalitionEntryId(fromBase64url(secret));
  return coalitions.find(({ entry }) => entry.groupId === id);
}

/**
 * Whether the group's own reconcile vote `held` reads as currently not
 * passing (#250): open, scored by at least one member, and its count short
 * of a pass. Before anyone scores it, every open vote would read that way,
 * so it says nothing then. A coalition's seat above has no ballots of its
 * own, so its line never says it.
 */
function notPassingNow(state: GroupState, held: HeldSeat): boolean {
  const own = state.proposals.find((p) => p.id === held.proposal);
  return own !== undefined && !own.final && own.ballots.length > 0 && own.outcome.kind !== 'pass';
}

/** The waiting line for `group`, marked currently not passing when `notPassing` (#250). */
function waitingLine(group: string, notPassing: boolean): CoalitionLine {
  return notPassing ? { kind: 'waiting', group, notPassing } : { kind: 'waiting', group };
}

/** Lines for a coalition with no genesis yet: the group's own vote, then the card waiting. */
function beforeGenesis(state: GroupState, held: HeldSeat): Pick<CoalitionRow, 'status' | 'lines'> {
  if (held.outcome === 'fail') {
    return { status: 'declined', lines: [{ kind: 'didnt-pass', group: state.name }] };
  }
  const own: CoalitionLine[] =
    held.outcome === 'open' ? [waitingLine(state.name, notPassingNow(state, held))] : [];
  return { status: 'forming', lines: [...own, { kind: 'waiting-card' }] };
}

/**
 * One line per seat: whom `motion` still waits for, and who failed it. The
 * line of `notPassing`'s seat, the group's own, is marked when it holds (#250).
 */
function seatLines(
  coalition: GroupState,
  motion: string,
  seats: readonly SeatEntry[],
  notPassing: string | null = null,
): CoalitionLine[] {
  const results = coalition.coalition?.results ?? [];
  return seats.flatMap((seat): CoalitionLine[] => {
    const result = seatResult(results, motion, seat.key);
    if (result === 'fail') return [{ kind: 'didnt-pass', group: seat.name }];
    return result === null ? [waitingLine(seat.name, seat.key === notPassing)] : [];
  });
}

/**
 * The status and lines of a coalition whose genesis names this group's seat
 * `held`, its own line marked while its vote reads as not passing (#250).
 */
function seated(
  state: GroupState,
  held: HeldSeat,
  coalition: GroupState,
): Pick<CoalitionRow, 'status' | 'lines'> {
  const info = coalition.coalition;
  const status = info?.status ?? 'forming';
  if (status === 'formed' || coalition.group === null || info === null)
    return { status, lines: [] };
  const founding = info.seats.filter((seat) => !info.admitted.some((a) => a.key === seat.key));
  const own = notPassingNow(state, held) ? held.key : null;
  const lines = seatLines(coalition, coalition.group, founding, own);
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
  return seat === undefined ? admitting(state, held, coalition) : seated(state, held, coalition);
}

/** The coalition on this device whose seats name `key`, once its genesis is back (#122). */
function coalitionSeating(
  coalitions: readonly HeldCoalition[],
  key: string,
): HeldCoalition | undefined {
  return coalitions.find(({ state }) => state.coalition?.seats.some((s) => s.key === key));
}

/**
 * The coalitions above `lower` (#122): one row for each of its reconcile
 * motions, by the coalition on this device whose seats name its key, then
 * the coalitions above that one, up to level 3. `chain` is the names from
 * the group up to `lower`.
 */
function aboveRows(
  lower: GroupState,
  chain: readonly string[],
  coalitions: readonly HeldCoalition[],
): AboveRow[] {
  if (chain.length > MAX_LEVEL) return [];
  return lower.coalitions.flatMap((held) => {
    const above = coalitionSeating(coalitions, held.key)?.state;
    const seat = above?.coalition?.seats.find((s) => s.key === held.key);
    const standing =
      above === undefined ? beforeGenesis(lower, held) : standingOf(lower, held, above, seat);
    const name = above === undefined ? held.name : above.name;
    const row = {
      key: held.key,
      name,
      coalitionId: above?.group ?? null,
      ...standing,
      chain: [...chain, name],
    };
    const higher =
      above === undefined || standing.status !== 'formed'
        ? []
        : aboveRows(above, row.chain, coalitions);
    return [row, ...higher];
  });
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
  if (target === null || entry === undefined) return null;
  const coalition = entry.state;
  const seat = coalition.coalition?.seats.find((s) => s.key === held.key);
  const standing = standingOf(state, held, coalition, seat);
  const me = meIn(state, author, entry, seat !== undefined && standing.status !== 'declined');
  const name = coalition.group === null ? held.name : coalition.name;
  const formed = standing.status === 'formed';
  return {
    entryId: entry.entry.groupId,
    proposal: held.proposal,
    coalitionId: coalition.group,
    name,
    ...standing,
    ...membership(
      coalition,
      { formed, keyed: holdsInner(target, held, coalition) },
      me,
      actsForGroup(state, author),
    ),
    me,
    mismatches: seat === undefined ? 0 : resultMismatches(state, coalition, held.key).length,
    above: seat === undefined ? [] : aboveRows(coalition, [state.name, name], coalitions),
  };
}

/**
 * Whether the group's reconcile target `target`, for the seat `held`, gives
 * this device `coalition`'s `inner` (#313): its own, for a founding group's,
 * or a wrap for its seat in the coalition's log, as `innerOf` opens one.
 */
function holdsInner(target: ReconcileTarget, held: HeldSeat, coalition: GroupState): boolean {
  const { coalition: info, group } = coalition;
  if (info === null || group === null) return false;
  return innerOf({ ...target, key: held.key }, info, group) !== null;
}

/**
 * A formed coalition's member groups, and whether this person, taking part,
 * may make cards: for another group, and while one more level stays within 3
 * and this device holds its `inner` (`keyed`, #313), for another coalition
 * (#122).
 */
function membership(
  coalition: GroupState,
  { formed, keyed }: { readonly formed: boolean; readonly keyed: boolean },
  me: CoalitionMe,
  live: boolean,
): Pick<CoalitionRow, 'members' | 'makesCards' | 'reconciles'> {
  if (!formed) return { members: [], makesCards: false, reconciles: false };
  const members = (coalition.coalition?.seats ?? []).map((s) => s.name);
  const makesCards = me.kind === 'in' && live;
  const level = coalition.coalition?.level ?? MAX_LEVEL;
  return { members, makesCards, reconciles: makesCards && keyed && level < MAX_LEVEL };
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
 * Whether the group sits in a formed coalition on this device (#126): one
 * whose seats name a seat its reconcile Proposals hold, so a Dispatch it
 * passes can rise.
 */
export function sitsInFormed(
  state: Pick<GroupState, 'coalitions'>,
  coalitions: readonly HeldCoalition[],
): boolean {
  return state.coalitions.some(({ key }) => {
    const above = coalitionSeating(coalitions, key)?.state.coalition;
    return above?.status === 'formed';
  });
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

/**
 * The reconcile target a Proposal carries: a group's own, or for a coalition
 * motion, the coalition's own reconcile motion's (#122), or null.
 */
function reconcileTargetOf(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): Extract<Proposal['target'], { kind: 'reconcile' }> | null {
  const { target } = proposal;
  if (target.kind === 'reconcile') return target;
  const origin = motionIn(proposal.id, target, coalitions)?.motion.target;
  return origin?.kind === 'reconcile' ? origin : null;
}

/** The coalition on this device a reconcile target names, once its genesis is back. */
function coalitionOf(
  target: Extract<Proposal['target'], { kind: 'reconcile' }>,
  coalitions: readonly HeldCoalition[],
): GroupState | undefined {
  const held =
    'secret' in target
      ? coalitionFor(coalitions, target.secret)
      : coalitionSeating(coalitions, target.key);
  return held?.state.group === null ? undefined : held?.state;
}

/**
 * The coalition a reconcile Proposal proposes, or a coalition's motion to
 * join one above (#122), as the group votes on it, or null for any other
 * Proposal.
 */
export function reconcileView(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): ReconcileView | null {
  const target = reconcileTargetOf(proposal, coalitions);
  if (target === null) return null;
  const seats = coalitionOf(target, coalitions)?.coalition?.seats;
  const others = seats === undefined ? null : seats.filter((s) => s.key !== target.key);
  return {
    name: target.name,
    title: target.title,
    atoms: target.atoms,
    others: others === null ? null : others.map((s) => s.name),
  };
}

/**
 * The founding group whose fail declined the coalition `proposal`, the
 * group's own reconcile vote, would found, while that vote is still open
 * (#250): its ballot is withdrawn, since the coalition won't form whatever
 * this group decides. Null for any other Proposal, a vote that has closed,
 * or a coalition that isn't declined, or was declined with no fail, at its
 * close-out, by when every founding group's vote has closed.
 */
export function withdrawnBy(
  proposal: Pick<Proposal, 'target' | 'final'>,
  coalitions: readonly HeldCoalition[],
): string | null {
  const { target } = proposal;
  if (proposal.final || target.kind !== 'reconcile' || !('secret' in target)) return null;
  return failedFounding(coalitionFor(coalitions, target.secret)?.state);
}

/** The first founding seat whose fail declined `coalition`, by name, or null while it isn't declined. */
function failedFounding(coalition: GroupState | undefined): string | null {
  const info = coalition?.coalition;
  if (coalition?.group == null || info?.status !== 'declined') return null;
  const genesis = coalition.group;
  const failed = info.seats.find((s) => seatResult(info.results, genesis, s.key) === 'fail');
  return failed?.name ?? null;
}

/**
 * A coalition motion's words, from the coalition's log: its title, why, the
 * coalition's name and id, any group it admits, its proposer's key there,
 * and, for an edit, its new text and discussion link (#120).
 */
export interface MotionWords {
  readonly title: string;
  readonly why: string;
  /** The name of the coalition whose motion it is: for a nested one, the highest (#122). */
  readonly coalition: string;
  readonly coalitionId: string;
  /** The coalitions it came through to reach this group, nearest first, by name (#122). */
  readonly through: readonly string[];
  readonly admits: string | null;
  /** For a coalition it admits (#122): the level and member groups its motion states. */
  readonly admitsLevel: number;
  readonly admitsGroups: readonly string[];
  readonly text: string;
  readonly link: string | null;
  /** The proposer's key in the coalition, whose name only the coalition's own state holds. */
  readonly author: string;
  /** For a promotion motion (#126): the Dispatch it sends on, and where it came from. */
  readonly promoted: PromotedWords | null;
}

/**
 * A promotion motion's Dispatch as a group votes on it (#126): its words,
 * its ceiling and the level it has reached, and the name of the seat that
 * passed it, as the coalition's seats name it.
 */
export interface PromotedWords {
  readonly title: string;
  readonly text: string;
  readonly ceiling: Ceiling;
  readonly level: number;
  readonly from: string;
}

/**
 * The coalition whose motion `target` opens, its own Proposal `id` there,
 * and the coalitions on this device it came through, nearest first (#122):
 * for a coalition's own motion, the coalition `target` names; for one from
 * further up, the last in its chain. Null when this device lacks any of them.
 */
function motionIn(
  id: string,
  target: Proposal['target'],
  coalitions: readonly HeldCoalition[],
): {
  readonly coalition: GroupState;
  readonly motion: Proposal;
  readonly through: readonly GroupState[];
} | null {
  if (target.kind !== 'motion') return null;
  const route = [target.coalition, ...target.chain].map(
    (cid) => coalitions.find(({ state }) => state.group === cid)?.state,
  );
  const coalition = route.at(-1);
  const motion = coalition?.proposals.find((p) => p.id === id);
  const through = route.slice(0, -1).flatMap((state) => (state === undefined ? [] : [state]));
  if (coalition === undefined || motion === undefined || through.length < route.length - 1) {
    return null;
  }
  return { coalition, motion, through };
}

/**
 * A coalition's motion to take a seat above it (#122), as a group votes on
 * it: the coalition's id, its entry on this device, and its sealed target.
 */
export interface SealedSeatMotion {
  readonly coalitionId: string;
  readonly entryId: string;
  readonly target: SealedReconcileTarget;
}

/**
 * The coalition motion `proposal` opens, when it is a coalition's motion to
 * take a seat above (#122) held on this device, or null for any other
 * Proposal.
 */
export function sealedSeatMotion(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): SealedSeatMotion | null {
  const found = motionIn(proposal.id, proposal.target, coalitions);
  const target = found?.motion.target;
  if (target?.kind !== 'reconcile' || !('sealed' in target)) return null;
  const coalitionId = found?.coalition.group ?? null;
  const entry = coalitions.find(({ state }) => state.group === coalitionId)?.entry;
  if (coalitionId === null || entry === undefined) return null;
  return { coalitionId, entryId: entry.groupId, target };
}

/**
 * Whether this device offers no ballot on the coalition's motion `motion`
 * (#375): the seat secret its sealed target holds, opened under the `inner`
 * `keys` hold for the coalition, doesn't make the seat key it states. False
 * where this device holds no `inner` to open it with, as a follower doesn't.
 */
export function misstatedSeat(
  motion: SealedSeatMotion,
  keys: ReadonlyMap<string, Pick<CoalitionKeys, 'inner'>>,
): boolean {
  const inner = keys.get(motion.entryId)?.inner ?? null;
  return inner !== null && misstatesSeat(motion.coalitionId, inner, motion.target);
}

/** The level and member groups an admit motion states for a coalition (#122), or none. */
function admitted(motion: Proposal): Pick<MotionWords, 'admits' | 'admitsLevel' | 'admitsGroups'> {
  if (motion.target.kind !== 'admit') return { admits: null, admitsLevel: 0, admitsGroups: [] };
  const { seat, groups } = motion.target;
  return { admits: seat.name, admitsLevel: seatLevel(seat), admitsGroups: groups };
}

/** A promotion motion's Dispatch and where it came from (#126), or null for any other motion. */
function promotedOf(coalition: GroupState, motion: Proposal): PromotedWords | null {
  const { target } = motion;
  if (target.kind !== 'promote') return null;
  const seat = coalition.coalition?.seats.find((s) => s.key === target.from);
  const { title, text } = target.dispatch;
  const { ceiling, level } = target;
  return { title, text, ceiling, level, from: seat?.name ?? '' };
}

/** The words of the coalition motion `proposal`, or null for any other Proposal, or one not read yet. */
export function motionWords(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): MotionWords | null {
  const found = motionIn(proposal.id, proposal.target, coalitions);
  if (found === null) return null;
  const { coalition, motion, through } = found;
  return {
    title: motion.title,
    why: motion.why,
    coalition: coalition.name,
    coalitionId: coalition.group ?? '',
    through: through.map((state) => state.name),
    ...admitted(motion),
    text: motion.text,
    link: motion.link,
    author: motion.author,
    promoted: promotedOf(coalition, motion),
  };
}

/**
 * `state` with each coalition motion's title, why, text and link read from
 * its coalition (#114, #120), so every list, card and ballot shows it as the
 * coalition wrote it: an edit's one version carries its new text, and its
 * proposer's coalition key, which the screens name from the coalition's
 * state (`versionViews`' `names`). A promotion motion (#126) carries the
 * Dispatch it sends on as `dispatch`, for the screens: the group's fold
 * never sends it.
 */
export function withMotionWords(
  state: GroupState,
  coalitions: readonly HeldCoalition[],
): GroupState {
  if (!state.proposals.some((p) => p.target.kind === 'motion')) return state;
  const proposals = state.proposals.map((p) => {
    const words = motionWords(p, coalitions);
    if (words === null) return p;
    const { title, why, text, link, author, promoted } = words;
    const versions = p.versions.map((v, i) => (i === 0 ? { ...v, text, author } : v));
    const dispatch =
      promoted === null ? p.dispatch : { title: promoted.title, text: promoted.text };
    return { ...p, title, why, text, link, versions, dispatch };
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
  /** The coalitions it came through, nearest first, by name (#122). */
  readonly through: readonly string[];
  readonly state: GroupState;
  readonly motion: Proposal;
  readonly progress: CoalitionProgress;
  /**
   * For a motion from further up (#122), each coalition it came through,
   * nearest first, with its progress on it, read for the seat below it on
   * this device's way up: the group's in the nearest.
   */
  readonly steps: readonly { readonly name: string; readonly progress: CoalitionProgress }[];
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

/** Each coalition a nested motion came through, with its progress for the seat below it (#122). */
function stepsOf(
  group: Pick<GroupState, 'coalitions'>,
  through: readonly GroupState[],
  id: string,
): MotionView['steps'] {
  let below: Pick<GroupState, 'coalitions'> = group;
  return through.flatMap((coalition) => {
    const progress = coalitionProgress(coalition, id, seatIn(below, coalition) ?? undefined);
    below = coalition;
    return progress === null ? [] : [{ name: coalition.name, progress }];
  });
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
  const { coalition, motion, through } = found;
  const below = through.at(-1) ?? group;
  const progress = coalitionProgress(coalition, motion.id, seatIn(below, coalition) ?? undefined);
  if (progress === null) return null;
  return {
    coalitionId: coalition.group ?? '',
    coalition: coalition.name,
    through: through.map((state) => state.name),
    state: coalition,
    motion,
    progress,
    steps: stepsOf(group, through, motion.id),
    author: displayName(coalition, motion.author) ?? '',
    section: sectionOf(coalition, motion),
  };
}
