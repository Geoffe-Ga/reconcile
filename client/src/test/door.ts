/**
 * Front doors for tests (#121): fixed door values, each with its two secrets
 * spelled from repeated bytes, so no test holds high-entropy text and each
 * reads the same on every run. A real door's secrets come from
 * `newDoorSecrets` (src/crypto/door.ts), on the proposer's device.
 */
import { base64url } from '../crypto/base64url';
import type { FrontDoor } from '../engine/optIns';

/** 32 bytes of `byte`, in unpadded base64url: a door secret no one would draw. */
export function secretOf(byte: number): string {
  return base64url(new Uint8Array(32).fill(byte));
}

/** A door made of `sign` and `box` bytes that hides the count unless `showCount`. */
export function doorOf(sign: number, box: number, showCount = false): FrontDoor {
  return { sign: secretOf(sign), box: secretOf(box), showCount };
}

/** An open front door that hides the member count. */
export const DOOR: FrontDoor = doorOf(0x11, 0x22);

/** The same door, showing the member count. */
export const COUNTED: FrontDoor = { ...DOOR, showCount: true };

/** Another door: new keys, the count hidden, as a rotation would make. */
export const ROTATED: FrontDoor = doorOf(0x33, 0x44);

/** A covenant hash for tests (#485): 32 bytes of 0x5a, no covenant's real hash. */
export const COVENANT_HASH = secretOf(0x5a);

/** The open door, listed under {@link COVENANT_HASH} (#485; ADR-0081). */
export const LISTED: FrontDoor = { ...DOOR, listed: true, covenant: COVENANT_HASH };

/** The listed door, accepting another covenant version. */
export const RENEWED: FrontDoor = { ...LISTED, covenant: secretOf(0x5b) };
