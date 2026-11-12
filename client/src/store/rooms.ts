/**
 * A device's coalition rooms (spec §4 Coalitions; ADR-0011, ADR-0009; #125):
 * one store entry per coalition whose room this device may read, synced by
 * the same loop as a group (`sync.ts`).
 *
 * A room's mailboxes and seal key derive from the coalition's `inner`, which
 * each founding group's reconcile Proposal carries and followers never get
 * (#124). A group admitted later holds no `inner` while it is decided on: its
 * card carried none, and once it is seated, a participant from a seated group
 * wraps `inner` to its seat in the coalition's log, which its devices open
 * with the seat secret in the group's own reconcile Proposal (#313,
 * `crypto/room.ts`). A coalition's seat in a coalition above it is held the
 * same way one level down (#122, #344): a device in its groups opens the
 * coalition's own room, then the sealed reconcile motion its seat above is
 * in, and takes the room above's `inner` from that motion, as a founding
 * seat's does, or from a wrap for the seat once it is seated, checked
 * against the genesis's commitment as a group's wrap is (#371). So a device
 * keeps a room exactly while a group it goes on in (not leaving, not
 * read-only) holds one of the coalition's seats and its `inner`, itself or
 * through a coalition it is in, up to three levels: the room's
 * entry (`kind: 'room'`, under `deriveRoomEntryId(inner)`) holds that
 * `inner` as its secret, and the coalition entry's signing key and author, so
 * its person writes there under their coalition name, never a group's
 * (ADR-0009). Its log keeps 30 days of relay time (`db.ts`).
 *
 * {@link keepRooms} runs on every pass: it makes each room this device may
 * read, and purges, messages and all, each it may no longer, the moment its
 * last group here leaves, is removed or dissolves, or the coalition is
 * declined. A room whose coalition entry's key changed, as a restore can
 * change it, is purged and made again under the new key, so nothing is ever
 * sent under a key the coalition doesn't bind. No backup file or link bundle
 * carries a room (`snapshot.ts` lists groups and coalitions only): a device
 * reads its rooms again from the relay.
 */
import { deriveRoomEntryId } from '../crypto/room';
import { type Coalition, MAX_LEVEL, type ReconcileChange } from '../engine/coalition';
import type { GroupState } from '../engine/fold';
import type { ProposalTarget } from '../engine/stewards';
import { heldCoalitions, type HeldCoalition, innerOf, seatInner, seatsAbove } from './coalitions';
import { type Group, type NewGroup, type Store } from './db';
import { foldGroup } from './expiry';

/**
 * A group or coalition (#344) on the device as the room reads it: its fold,
 * and whether it goes on here.
 */
export interface RoomHolder {
  /** The group or coalition folded from its relay records. */
  readonly state: GroupState;
  /** True unless its leave waits for the relay (#77) or it only reads here (#108, #115). */
  readonly live: boolean;
}

/** A coalition to read a room of: its id and what its fold keeps beside a group's state. */
interface RoomOf {
  readonly id: string;
  readonly info: Coalition;
}

/**
 * The `inner` of `coalition`'s room on this device, from the first live
 * holder in `holders` with one of the coalition's seats and its `inner`, or
 * null: before the genesis, once it was declined, on a device with no such
 * holder, as a follower's, and for a group or coalition admitted later until
 * a seated participant wraps `inner` to its seat (#313). A group holds a seat
 * through its reconcile Proposal (`coalitions.ts`'s `innerOf`); a coalition
 * through its sealed reconcile motion, opened under its own room's `inner`
 * (#344), so the levels below it are read first, `depth` counting them.
 */
export function innerFor(
  coalition: GroupState,
  holders: readonly RoomHolder[],
  depth = 1,
): Uint8Array | null {
  const info = coalition.coalition;
  const id = coalition.group;
  if (id === null || info === null || info.status === 'declined') return null;
  for (const { state, live } of holders) {
    // The coalition itself holds none of its own seats.
    if (!live || state.group === id) continue;
    const inner =
      state.coalition === null
        ? innerThroughGroup(state, { id, info })
        : innerThroughCoalition(state, { id, info }, holders, depth);
    if (inner !== null) return inner;
  }
  return null;
}

/** The `inner` of `room`'s coalition that the group folded as `group` holds a seat and `inner` of (#313). */
function innerThroughGroup(group: GroupState, room: RoomOf): Uint8Array | null {
  const seats = new Set(room.info.seats.map((seat) => seat.key));
  for (const { target } of group.proposals) {
    if (!holdsSeat(target, seats)) continue;
    const inner = innerOf(target, room.info, room.id);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * The `inner` of `room`'s coalition that the coalition folded as `lower`
 * holds a seat and `inner` of (#344): `lower`'s own room's `inner`, read
 * through `holders` a level further down, opens its sealed reconcile motions,
 * and a seat they hold in `room`'s coalition gives its `inner` as a group's
 * seat does ({@link seatInner}). No level past {@link MAX_LEVEL} is read.
 */
function innerThroughCoalition(
  lower: GroupState,
  room: RoomOf,
  holders: readonly RoomHolder[],
  depth: number,
): Uint8Array | null {
  if (depth >= MAX_LEVEL) return null;
  const own = innerFor(lower, holders, depth + 1);
  if (own === null) return null;
  const seats = new Set(room.info.seats.map((seat) => seat.key));
  for (const above of seatsAbove(lower, own)) {
    if (!seats.has(above.key)) continue;
    const inner = seatInner(above, room.info, room.id);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * Whether `target` is a group's reconcile Proposal holding one of `seats`. A
 * coalition's seat above is sealed in its own log (#122), and read through
 * {@link innerThroughCoalition} (#344).
 */
function holdsSeat(target: ProposalTarget, seats: ReadonlySet<string>): target is ReconcileChange {
  return target.kind === 'reconcile' && !('sealed' in target) && seats.has(target.key);
}

/**
 * The entry id of `coalition`'s room on this device, or null when it may read
 * none. `holders` are the device's groups and its other coalitions (#344).
 */
export function roomEntryFor(coalition: GroupState, holders: readonly RoomHolder[]): string | null {
  const inner = innerFor(coalition, holders);
  return inner === null ? null : deriveRoomEntryId(inner);
}

/**
 * A new room for `inner`, written under the coalition entry `entry`'s key
 * and author. A room has no name of its own: its people show under their
 * coalition names.
 */
export function newRoom(inner: Uint8Array, entry: Pick<Group, 'signingKey' | 'me'>): NewGroup {
  return {
    kind: 'room',
    groupId: deriveRoomEntryId(inner),
    secret: Uint8Array.from(inner),
    signingKey: Uint8Array.from(entry.signingKey),
    me: { author: entry.me.author, name: '' },
  };
}

/**
 * Each group's fold as {@link keepRooms} last read it, by group id, with the
 * log's and cleared list's lengths it was folded at: the reconcile
 * Proposals a room reads don't change with relay time, so a group whose log
 * hasn't changed isn't folded again. The sync loop keeps one for its life.
 */
export type RoomReads = Map<string, { readonly mark: string; readonly state: GroupState }>;

/** Every group on the device as the room reads it, folding only those changed since `reads`. */
async function groupHolders(
  store: Pick<Store, 'listGroups'>,
  reads: RoomReads,
): Promise<RoomHolder[]> {
  return (await store.listGroups()).map((group) => {
    const mark = `${String(group.log.length)}/${String(group.cleared?.length ?? 0)}`;
    let read = reads.get(group.groupId);
    if (read?.mark !== mark) {
      read = { mark, state: foldGroup(group) };
      reads.set(group.groupId, read);
    }
    return {
      state: read.state,
      live: group.leaving === undefined && group.archived === undefined,
    };
  });
}

/**
 * Every coalition on the device as a room above it reads it (#344): its fold,
 * live unless it only reads here, as a removed member's copy does (#115).
 */
function coalitionHolders(coalitions: readonly HeldCoalition[]): RoomHolder[] {
  return coalitions.map(({ entry, state }) => ({ state, live: entry.archived === undefined }));
}

/** The room each coalition on the device should have, by its entry id, with its `inner`. */
function wantedRooms(coalitions: readonly HeldCoalition[], holders: readonly RoomHolder[]) {
  const wanted = new Map<string, { inner: Uint8Array; entry: Group }>();
  for (const { entry, state } of coalitions) {
    const inner = innerFor(state, holders);
    if (inner !== null) wanted.set(deriveRoomEntryId(inner), { inner, entry });
  }
  return wanted;
}

/**
 * Keeps one room for each coalition on the device whose `inner` a live group
 * here holds, itself or through a coalition it is in (#344), and purges every
 * other room, its messages and outbox with it.
 * A room whose author is no longer its coalition entry's is purged and made
 * again under the entry's key. Another tab may make a room first: then the
 * device keeps that one. `reads` remembers each group's fold between calls.
 */
export async function keepRooms(store: Store, reads: RoomReads = new Map()): Promise<void> {
  const rooms = await store.listRooms();
  const coalitions = await heldCoalitions(store);
  if (rooms.length === 0 && coalitions.length === 0) return;
  const holders = [...(await groupHolders(store, reads)), ...coalitionHolders(coalitions)];
  const wanted = wantedRooms(coalitions, holders);
  for (const room of rooms) {
    const want = wanted.get(room.groupId);
    if (want === undefined || want.entry.me.author !== room.me.author) {
      await store.purgeGroup(room.groupId);
    } else {
      wanted.delete(room.groupId);
    }
  }
  for (const { inner, entry } of wanted.values()) {
    await store.addGroup(newRoom(inner, entry)).catch(() => undefined);
  }
}
