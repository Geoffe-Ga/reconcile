/**
 * A coalition room's keys (spec §3 and §4 Coalitions; ADR-0011; #125, #313).
 *
 * The room's weekly mailbox ids and seal key derive from the coalition's
 * `inner`, 32 random bytes that only seated groups hold, exactly as a
 * group's do from its secret (`groupKeys.ts`): `deriveWeekMailboxId` and
 * `deriveSealKey`. Followers (#124) hold the coalition secret and never
 * `inner`, so they derive neither.
 *
 * A founding group's reconcile Proposal carries `inner` from the card that
 * founded the coalition. A card that asks a group into a formed coalition
 * carries no `inner` (#313), so the group can't read the room while the
 * coalition decides whether to admit it. Once admitted, it receives `inner`
 * through its seat: its admit motion names the seat's X25519 key, HKDF of the
 * seat secret under {@link SEAT_KX_INFO}, and a participant from a seated
 * group posts a wrap of `inner` sealed to that key ({@link wrapInner}), a box
 * (`box.ts`) whose associated data names the coalition and the seat, so a wrap
 * moved to another seat or coalition never opens. Every member of the
 * admitted group holds its seat secret, so each opens the wrap
 * ({@link unwrapInner}); a candidate group holds no seated group's.
 *
 * A device keeps the room as one entry in its store, beside its groups and
 * coalitions, under an id derived from `inner` under a label of its own, so
 * every tab finds the same entry, and the id names no mailbox. It never
 * leaves the device: no backup file or link bundle carries a room.
 * `engine/vectors/room-keys.json` and `vectors/room-wrap.json` pin every
 * derivation and wrap here, computed outside @noble.
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, fromBase64url } from './base64url';
import { kxPublicKeyOf, openBox, sealTo } from './box';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { hkdf32 } from './hkdf';

/** The HKDF label of a room's entry id on a device. */
export const ROOM_ENTRY_INFO = 'reconcile/v1/room-entry';

/** The HKDF label of a seat's X25519 secret key, from its seat secret (#313). */
export const SEAT_KX_INFO = 'reconcile/v1/seat-kx';

/** The HKDF label of a room wrap's box (#313). */
export const ROOM_WRAP_INFO = 'reconcile/v1/room-wrap';

/** A wrap's text: unpadded base64url. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

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

/**
 * A seat's X25519 secret key: HKDF of its 32-byte seat secret under
 * {@link SEAT_KX_INFO}, a key of its own beside the seat's signing key.
 *
 * @throws {RangeError} when the seat secret isn't 32 bytes.
 */
export function seatKxKeyOf(seatSecret: Uint8Array): Uint8Array<ArrayBuffer> {
  if (seatSecret.length !== GROUP_SECRET_BYTES) throw new RangeError('A seat secret is 32 bytes.');
  return hkdf32(seatSecret, SEAT_KX_INFO);
}

/**
 * A seat's X25519 public key, in unpadded base64url: what an admit motion
 * carries as `kx`, for a wrap to be sealed to.
 *
 * @throws {RangeError} when the seat secret isn't 32 bytes.
 */
export function seatKxOf(seatSecret: Uint8Array): string {
  const secretKey = seatKxKeyOf(seatSecret);
  try {
    return base64url(kxPublicKeyOf(secretKey));
  } finally {
    secretKey.fill(0);
  }
}

/** Where a wrap belongs: the coalition, by its genesis id, and the seat it is for, by its public key. */
export interface RoomWrapPlace {
  readonly coalitionId: string;
  readonly seat: string;
}

/** A wrap's associated data: UTF-8 coalition id ‖ 0x00 ‖ UTF-8 seat key, as events spell them. */
export function roomWrapAad({ coalitionId, seat }: RoomWrapPlace): Uint8Array {
  return concatBytes(utf8ToBytes(coalitionId), Uint8Array.of(0), utf8ToBytes(seat));
}

/**
 * `inner` sealed to the seat's X25519 public key `kx` (base64url), for the
 * seat and coalition `place` names: a fresh box each time, in unpadded
 * base64url.
 *
 * @throws {RangeError} when `inner` isn't 32 bytes, or `kx` can't take a box.
 */
export function wrapInner(
  place: RoomWrapPlace & { readonly kx: string; readonly inner: Uint8Array },
): string {
  if (place.inner.length !== GROUP_SECRET_BYTES) {
    throw new RangeError('A room’s inner is 32 bytes.');
  }
  const kx = fromBase64url(place.kx);
  return base64url(sealTo(kx, place.inner, ROOM_WRAP_INFO, roomWrapAad(place)));
}

/** The bytes of canonical unpadded base64url `text`, or null. */
function bytesOf(text: string): Uint8Array | null {
  if (!BASE64URL.test(text)) return null;
  try {
    const bytes = fromBase64url(text);
    return base64url(bytes) === text ? bytes : null;
  } catch {
    // A length no base64 has, such as one character.
    return null;
  }
}

/**
 * The `inner` in `wrap`, opened with the seat's key from `seatSecret`, or
 * null when it doesn't open there or holds anything but 32 bytes: a wrap
 * for another seat or coalition, a changed byte, or a seat secret of the
 * wrong length.
 */
export function unwrapInner(
  place: RoomWrapPlace & { readonly wrap: string; readonly seatSecret: Uint8Array },
): Uint8Array | null {
  const box = bytesOf(place.wrap);
  if (box === null || place.seatSecret.length !== GROUP_SECRET_BYTES) return null;
  const secretKey = seatKxKeyOf(place.seatSecret);
  try {
    const inner = openBox(secretKey, box, ROOM_WRAP_INFO, roomWrapAad(place));
    return inner?.length === GROUP_SECRET_BYTES ? inner : null;
  } finally {
    secretKey.fill(0);
  }
}
