/**
 * A coalition room's keys (spec §3 and §4 Coalitions; ADR-0011; #125).
 *
 * The room's weekly mailbox ids and seal key derive from the coalition's
 * `inner`, 32 random bytes that only member groups' sealed logs hold, exactly
 * as a group's do from its secret (`groupKeys.ts`): `deriveWeekMailboxId` and
 * `deriveSealKey`. Followers (#124) hold the coalition secret and never
 * `inner`, so they derive neither.
 *
 * A device keeps the room as one entry in its store, beside its groups and
 * coalitions, under an id derived from `inner` under a label of its own, so
 * every tab finds the same entry, and the id names no mailbox. It never
 * leaves the device: no backup file or link bundle carries a room.
 * `engine/vectors/room-keys.json` pins every derivation here, computed
 * outside @noble.
 */
import { base64url } from './base64url';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { hkdf32 } from './hkdf';

/** The HKDF label of a room's entry id on a device. */
export const ROOM_ENTRY_INFO = 'reconcile/v1/room-entry';

/**
 * The id a device keeps the room whose `inner` this is under: 43 unpadded
 * base64url characters.
 *
 * @throws {RangeError} when `inner` isn't 32 bytes.
 */
export function deriveRoomEntryId(inner: Uint8Array): string {
  if (inner.length !== GROUP_SECRET_BYTES) throw new RangeError('A room’s inner is 32 bytes.');
  return base64url(hkdf32(inner, ROOM_ENTRY_INFO));
}
