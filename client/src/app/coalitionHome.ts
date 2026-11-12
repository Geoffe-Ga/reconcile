/**
 * What a coalition's own screens show (#120), apart from any component: its
 * home, its Documents and who on this device may propose there.
 *
 * Everything comes from folded logs on this device: the coalition entry's,
 * which holds group names, motions, the coalition's text and one pass or fail
 * per group, never a ballot (ADR-0036); and this device's own groups', for
 * which of them hold a seat and whether this person may propose in them.
 * Nothing here reads a person's key in one log to find them in another.
 */
import { can, followerCan } from '../engine/capabilities';
import { MAX_LEVEL, seatLevel } from '../engine/coalition';
import { coalitionProgress, type CoalitionProgress } from '../engine/coalitionProgress';
import { type Dispatch, newestFirst } from '../engine/dispatches';
import { openProposalOn } from '../engine/composeOption';
import { type ParsedEvent, parseRecord } from '../engine/event';
import type { Atom, GroupState } from '../engine/fold';
import type { HeldCoalition } from '../store/coalitions';
import { roomEntryFor } from '../store/rooms';

/**
 * A group on this device, as the coalition's screens read it; or a coalition
 * this device holds an entry for (`kind: 'coalition'`, #122), which may hold
 * a seat in a coalition above it as a group does.
 */
export interface DeviceGroup {
  readonly groupId: string;
  /** This person's author id in the group. */
  readonly me: string;
  /** The group folded from its relay records. */
  readonly state: GroupState;
  /** Whether this device's leave waits for the relay (#77). */
  readonly leaving: boolean;
  /** Whether the group only reads on this device (#108). */
  readonly archived: boolean;
  readonly kind?: 'coalition';
}

/**
 * One of the coalition's members, whether a group or coalition on this device
 * holds its seat, and whether it is a coalition, by the level its seat
 * states (#122).
 */
export interface MemberGroup {
  readonly name: string;
  readonly mine: boolean;
  readonly coalition: boolean;
}

/** One of the coalition's Documents, by its id and title. */
export interface DocumentRef {
  readonly id: string;
  readonly title: string;
}

/**
 * A motion as the coalition home lists it: its title, deadline, progress, the
 * relay minute the coalition decided it, and a group on this device whose
 * seat decides it, whose Proposal view opens it, or null.
 */
export interface MotionItem {
  readonly id: string;
  readonly title: string;
  readonly deadline: number;
  readonly closedAt: number | null;
  readonly decidedAt: number;
  readonly progress: CoalitionProgress;
  readonly groupId: string | null;
}

/**
 * Where this person stands in the coalition: may propose, through the member
 * group whose seat they joined under; may take part from a member group
 * where they can propose; is joining; or only reads.
 */
export type CoalitionStanding =
  | { readonly kind: 'proposes'; readonly groupId: string }
  | { readonly kind: 'take-part'; readonly groupId: string }
  | { readonly kind: 'joining' }
  | { readonly kind: 'reads' };

/** The coalition home (#120). */
export interface CoalitionHomeView {
  /** The coalition's genesis id. */
  readonly coalitionId: string;
  /** Its entry on this device. */
  readonly entryId: string;
  readonly name: string;
  readonly members: readonly MemberGroup[];
  readonly documents: readonly DocumentRef[];
  /** Motions not yet final, closing soonest first. */
  readonly open: readonly MotionItem[];
  /** Final motions, the latest decided first. */
  readonly decided: readonly MotionItem[];
  /** Motions this device proposed that the relay hasn't ordered yet, oldest first. */
  readonly pending: readonly { readonly id: string; readonly title: string }[];
  readonly standing: CoalitionStanding;
  /** The coalition's Dispatches, newest first (#124), which everyone who opens it reads. */
  readonly dispatches: readonly Dispatch[];
  /**
   * True when this device only follows the coalition (#124): it kept the
   * entry from a follow link, and no group here holds a seat in it. A
   * follower reads at the Member level ({@link followerCan}): no proposing
   * and no Take part.
   */
  readonly follower: boolean;
  /** True when this person may share a follow link (#124): they take part, bound to a seat. */
  readonly share: boolean;
  /**
   * Whether this device may read the coalition's room (#125): a group it goes
   * on in holds one of its seats and `inner`, which a group admitted later
   * holds only once a seated group's participant wraps it to its seat (#313).
   * Never on a device in none of its member groups, as a follower's (#124).
   */
  readonly room: boolean;
}

/** The coalition on this device whose genesis id is `coalitionId`, or undefined. */
export function coalitionById(
  coalitions: readonly HeldCoalition[],
  coalitionId: string,
): HeldCoalition | undefined {
  return coalitions.find(({ state }) => state.group === coalitionId);
}

/**
 * The coalition's Documents, as #92 will list several: today its one, whose
 * id is its genesis id and whose title is its genesis title.
 */
export function coalitionDocuments(state: GroupState): DocumentRef[] {
  return state.group === null ? [] : [{ id: state.group, title: state.title }];
}

/** The sections of the coalition's Document `documentId`, in order. */
export function documentAtoms(state: GroupState, documentId: string): Atom[] {
  return state.atoms.filter((atom) => atom.documentId === documentId);
}

/** True when `group` holds `seatKey` through one of its reconcile Proposals. */
function holds(group: DeviceGroup, seatKey: string): boolean {
  return group.state.coalitions.some((held) => held.key === seatKey);
}

/** True when this person may propose in `group` now: they can, it goes on, and they're staying. */
function proposesIn(group: DeviceGroup): boolean {
  return !group.leaving && group.state.dissolved === null && can(group.state, group.me, 'propose');
}

/** The events a record list carries, skipping any that doesn't verify. */
function eventsOf(outbox: readonly Uint8Array[]): ParsedEvent[] {
  return outbox.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

/** A participant's standing: they propose while they can propose in the group that holds their seat. */
function boundStanding(groups: readonly DeviceGroup[], seat: string): CoalitionStanding {
  const holder = groups.find((group) => holds(group, seat));
  return holder !== undefined && proposesIn(holder)
    ? { kind: 'proposes', groupId: holder.groupId }
    : { kind: 'reads' };
}

/**
 * Where this person stands in the coalition (#120): bound to a seat, they
 * propose while they can propose in the group that holds it; with a join
 * planned or waiting, they're joining; else, in a formed coalition, they may
 * take part from a member group where they can propose; or they only read.
 */
export function standingIn(held: HeldCoalition, groups: readonly DeviceGroup[]): CoalitionStanding {
  const { entry, state } = held;
  const info = state.coalition;
  const bound = info?.bindings.find((b) => b.author === entry.me.author)?.seat;
  if (bound !== undefined) return boundStanding(groups, bound);
  const joining = eventsOf(entry.outbox).some(({ event }) => event.type === 'join');
  if (joining || entry.joinAs !== undefined) return { kind: 'joining' };
  if (info?.status !== 'formed') return { kind: 'reads' };
  const from = groups.find((g) => proposesIn(g) && info.seats.some((seat) => holds(g, seat.key)));
  return from === undefined ? { kind: 'reads' } : { kind: 'take-part', groupId: from.groupId };
}

/**
 * A group on this device whose vote reaches one of `seats`: one holding a
 * seat itself, or one below a coalition on this device that holds one (#122),
 * up to level 3.
 */
function deciderOf(
  seats: readonly string[],
  groups: readonly DeviceGroup[],
  depth = 1,
): DeviceGroup | undefined {
  const holding = groups.filter((group) => seats.some((seat) => holds(group, seat)));
  const direct = holding.find((group) => group.kind !== 'coalition');
  if (direct !== undefined || depth >= MAX_LEVEL) return direct;
  for (const coalition of holding) {
    const below = (coalition.state.coalition?.seats ?? []).map((seat) => seat.key);
    const found = deciderOf(below, groups, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Each motion of the coalition with its progress, and a group on this device that decides it. */
function motionItems(state: GroupState, groups: readonly DeviceGroup[]): MotionItem[] {
  return state.proposals.flatMap((proposal) => {
    const progress = coalitionProgress(state, proposal.id);
    const snapshot = state.coalition?.motions.find((m) => m.id === proposal.id)?.seats ?? [];
    if (progress === null) return [];
    const decider = deciderOf(snapshot, groups);
    return [
      {
        id: proposal.id,
        title: proposal.title,
        deadline: proposal.deadline,
        closedAt: proposal.closedAt,
        decidedAt: proposal.closedAt ?? progress.settles,
        progress,
        groupId: decider?.groupId ?? null,
      },
    ];
  });
}

/** The motions this device proposed that wait for the relay. */
function pendingIn(held: HeldCoalition): CoalitionHomeView['pending'] {
  return eventsOf(held.entry.outbox).flatMap(({ id, event }) =>
    event.type === 'proposal' ? [{ id, title: event.body.title }] : [],
  );
}

/**
 * Whether this device only follows the coalition (#124): it followed the
 * entry's link, and no group here holds one of its seats.
 */
function onlyFollows(held: HeldCoalition, members: readonly MemberGroup[]): boolean {
  return held.entry.following === true && !members.some((member) => member.mine);
}

/**
 * Whether this person may share a follow link (#124): they take part in the
 * formed coalition, bound to a seat. A follower holds no binding: they read
 * at the Member level, which doesn't invite.
 */
function maySharePerson(held: HeldCoalition): boolean {
  const { entry, state } = held;
  const bound = state.coalition?.bindings.some((b) => b.author === entry.me.author) ?? false;
  return bound && state.coalition?.status === 'formed';
}

/**
 * The coalition home for `held` (#120): its name, its member groups,
 * marking those a group on this device holds, its Documents, its open and
 * decided motions, what this device proposed that waits, where this person
 * stands, its Dispatches (#124), whether this device only follows it, and
 * whether this person may share a follow link. Null before its genesis is
 * back.
 */
export function coalitionHome(
  held: HeldCoalition,
  groups: readonly DeviceGroup[],
): CoalitionHomeView | null {
  const { state, entry } = held;
  if (state.group === null || state.coalition === null) return null;
  const motions = motionItems(state, groups);
  const members = state.coalition.seats.map((seat) => ({
    name: seat.name,
    mine: groups.some((group) => holds(group, seat.key)),
    coalition: seatLevel(seat) > 0,
  }));
  const follower = onlyFollows(held, members);
  return {
    coalitionId: state.group,
    entryId: entry.groupId,
    name: state.name,
    members,
    documents: coalitionDocuments(state),
    open: motions.filter((m) => !m.progress.final).sort((a, b) => a.deadline - b.deadline),
    decided: motions.filter((m) => m.progress.final).sort((a, b) => b.decidedAt - a.decidedAt),
    pending: pendingIn(held),
    // A follower reads at the Member level, which proposes nothing (ADR-0021).
    standing: follower && !followerCan('propose') ? { kind: 'reads' } : standingIn(held, groups),
    dispatches: newestFirst(state),
    follower,
    share: maySharePerson(held),
    room: roomEntryFor(state, groups.map(holderOf)) !== null,
  };
}

/** A group on this device as the room reads it (#125): its fold, and whether it goes on here. */
export function holderOf({ state, leaving, archived }: DeviceGroup) {
  return { state, live: !leaving && !archived };
}

/**
 * True while a motion is open on the coalition's section `atomId`: it takes
 * no new one until that motion is final, and a coalition motion takes no
 * other version (#100), so the section waits.
 */
export function sectionIsOpen(state: GroupState, atomId: string): boolean {
  return openProposalOn(state, atomId) !== undefined;
}
