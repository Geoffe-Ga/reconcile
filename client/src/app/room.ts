/**
 * What a coalition's room shows, and Send (#125; ADR-0011, ADR-0009), apart
 * from any component.
 *
 * Everything comes from folded logs on this device: the coalition entry's,
 * for its participants and their coalition names; this device's own groups',
 * for whether one it goes on in holds a seat, which is what lets it read the
 * room at all (`store/rooms.ts`); and the room's own log and outbox. Nothing
 * here reads a person's key in one log to find them in another: a message
 * goes under the coalition entry's key, and shows under its author's
 * coalition name.
 */
import { signEvent, parseRecord } from '../engine/event';
import { foldRoom, messageText, MESSAGE_MAX, type RoomMessage } from '../engine/room';
import type { HeldCoalition } from '../store/coalitions';
import type { Group, Store } from '../store/db';
import { keepRooms, roomEntryFor } from '../store/rooms';
import { type DeviceGroup, holderOf, standingIn } from './coalitionHome';

/**
 * Where this person stands in the room: writes, once bound to one of the
 * coalition's seats; may take part from a member group where they can
 * propose; is joining; or only reads.
 */
export type RoomStanding =
  | { readonly kind: 'writes' }
  | { readonly kind: 'take-part'; readonly groupId: string }
  | { readonly kind: 'joining' }
  | { readonly kind: 'reads' };

/** A message this device wrote that waits in the room's outbox: its id and text. */
export interface PendingMessage {
  readonly id: string;
  readonly text: string;
}

/** The room (#125), as its screen shows it. */
export interface RoomView {
  /** The coalition's genesis id. */
  readonly coalitionId: string;
  /** The room's entry on this device. */
  readonly roomId: string;
  /** The coalition's name. */
  readonly name: string;
  /** The messages, oldest first. */
  readonly messages: readonly RoomMessage[];
  /** What this device wrote that the relay doesn't have yet, oldest first. */
  readonly pending: readonly PendingMessage[];
  /** This person's key in the coalition, which signs what they write. */
  readonly me: string;
  /** The name this person writes under: their coalition name. */
  readonly myName: string;
  readonly standing: RoomStanding;
}

/**
 * Where this person stands in the room: bound to a seat, they write, whatever
 * their level in their group, since the room checks only the seat; otherwise
 * as on the coalition's home, without a seat they can't write.
 */
export function roomStanding(held: HeldCoalition, groups: readonly DeviceGroup[]): RoomStanding {
  const bound = held.state.coalition?.bindings.some((b) => b.author === held.entry.me.author);
  if (bound === true) return { kind: 'writes' };
  const standing = standingIn(held, groups);
  return standing.kind === 'take-part' || standing.kind === 'joining'
    ? standing
    : { kind: 'reads' };
}

/** The messages `outbox` holds that this device wrote for the coalition `coalitionId`. */
function pendingIn(outbox: readonly Uint8Array[], coalitionId: string): PendingMessage[] {
  return outbox.flatMap((bytes) => {
    const event = parseRecord(bytes);
    if (event?.event.type !== 'message' || event.event.group !== coalitionId) return [];
    return [{ id: event.id, text: event.event.body.text }];
  });
}

/**
 * The room for `held` (#125), with `room` its entry on this device, which a
 * pass makes once a group here holds one of the coalition's seats. Null when
 * this device may read no room of the coalition's: before its genesis, once
 * it was declined, and on a device in none of its member groups, as a
 * follower's (#124).
 */
export function roomView(
  held: HeldCoalition,
  groups: readonly DeviceGroup[],
  room: Pick<Group, 'log' | 'outbox' | 'relayNow'> | undefined,
): RoomView | null {
  const { state, entry } = held;
  const roomId = roomEntryFor(state, groups.map(holderOf));
  if (roomId === null || state.group === null) return null;
  return {
    coalitionId: state.group,
    roomId,
    name: state.name,
    messages: room === undefined ? [] : foldRoom(room.log, state, room.relayNow),
    pending: room === undefined ? [] : pendingIn(room.outbox, state.group),
    me: entry.me.author,
    myName: entry.me.name,
    standing: roomStanding(held, groups),
  };
}

/** What {@link sendMessage} needs: the store, a sync to run at once, and the device clock in ms. */
export interface RoomServices {
  readonly store: Store;
  readonly sync: { syncOnce(): Promise<boolean> };
  readonly now: () => number;
}

/**
 * Send: signs `text`, in NFC and trimmed, as a message in the coalition
 * `coalitionId`, with the room's key, the coalition entry's, queues it in the
 * room's outbox and syncs at once. A room this device may read but hasn't
 * made yet is made first.
 *
 * @throws {RangeError} when the text isn't 1 to 2,000 code points.
 * @throws {Error} when this device can't read that room; nothing is queued.
 */
export async function sendMessage(
  services: RoomServices,
  coalitionId: string,
  roomId: string,
  text: string,
): Promise<void> {
  const body = messageText(text);
  if (body === null) {
    throw new RangeError(`A message is 1 to ${MESSAGE_MAX.toLocaleString('en')} characters.`);
  }
  const { store } = services;
  if ((await store.getGroup(roomId)) === undefined) await keepRooms(store);
  const room = await store.getGroup(roomId);
  if (room?.kind !== 'room') throw new Error('This device can’t read that room.');
  const signed = signEvent(room.signingKey, {
    type: 'message',
    group: coalitionId,
    ts: services.now(),
    body: { text: body },
  });
  await store.enqueue(roomId, signed.record);
  void services.sync.syncOnce();
}
