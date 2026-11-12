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
 * `crypto/room.ts`). So a device keeps a room exactly while a group it goes
 * on in (not leaving, not read-only) holds one of the coalition's seats and
 * its `inner`: the room's
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
import type { ReconcileChange } from '../engine/coalition';
import type { GroupState } from '../engine/fold';
import type { ProposalTarget } from '../engine/stewards';
import { heldCoalitions, type HeldCoalition, innerOf } from './coalitions';
import { type Group, type NewGroup, type Store } from './db';
import { foldGroup } from './expiry';

/** A group on the device as the room reads it: its fold, and whether it goes on here. */
export interface RoomHolder {
  /** The group folded from its relay records. */
  readonly state: GroupState;
  /** True unless its leave waits for the relay (#77) or it only reads here (#108). */
  readonly live: boolean;
}

/**
 * The `inner` of `coalition`'s room on this device, from the first live
 * group in `groups` whose reconcile Proposal holds one of the coalition's
 * seats and its `inner` (`coalitions.ts`'s `innerOf`), or null: before the genesis, once
 * it was declined, on a device with no such group, as a follower's, and for a
 * group admitted later until a seated group's participant wraps `inner` to
 * its seat (#313).
 */
export function innerFor(coalition: GroupState, groups: readonly RoomHolder[]): Uint8Array | null {
  const info = coalition.coalition;
  const id = coalition.group;
  if (id === null || info === null || info.status === 'declined') return null;
  const seats = new Set(info.seats.map((seat) => seat.key));
  for (const { state, live } of groups) {
    if (!live) continue;
    for (const { target } of state.proposals) {
      if (!holdsSeat(target, seats)) continue;
      const inner = innerOf(target, info, id);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Whether `target` is a group's reconcile Proposal holding one of `seats`. A
 * coalition's seat above is sealed in its own log (#122), so no room opens
 * through it (#344).
 */
function holdsSeat(target: ProposalTarget, seats: ReadonlySet<string>): target is ReconcileChange {
  return target.kind === 'reconcile' && !('sealed' in target) && seats.has(target.key);
}

/** The entry id of `coalition`'s room on this device, or null when it may read none. */
export function roomEntryFor(coalition: GroupState, groups: readonly RoomHolder[]): string | null {
  const inner = innerFor(coalition, groups);
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
async function holders(store: Pick<Store, 'listGroups'>, reads: RoomReads): Promise<RoomHolder[]> {
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

/** The room each coalition on the device should have, by its entry id, with its `inner`. */
function wantedRooms(coalitions: readonly HeldCoalition[], groups: readonly RoomHolder[]) {
  const wanted = new Map<string, { inner: Uint8Array; entry: Group }>();
  for (const { entry, state } of coalitions) {
    const inner = innerFor(state, groups);
    if (inner !== null) wanted.set(deriveRoomEntryId(inner), { inner, entry });
  }
  return wanted;
}

/**
 * Keeps one room for each coalition on the device whose `inner` a live group
 * here holds, and purges every other room, its messages and outbox with it.
 * A room whose author is no longer its coalition entry's is purged and made
 * again under the entry's key. Another tab may make a room first: then the
 * device keeps that one. `reads` remembers each group's fold between calls.
 */
export async function keepRooms(store: Store, reads: RoomReads = new Map()): Promise<void> {
  const rooms = await store.listRooms();
  const coalitions = await heldCoalitions(store);
  if (rooms.length === 0 && coalitions.length === 0) return;
  const wanted = wantedRooms(coalitions, await holders(store, reads));
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
