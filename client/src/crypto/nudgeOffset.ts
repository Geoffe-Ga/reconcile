/**
 * A group's nudge offset for a coalition's motion (#284; the founder's
 * decision of 2026-11-12, option 1; spec §3 and §7 Push).
 *
 * A coalition's motion opens in every seated group with one deadline, so
 * nudges at the deadline's own minutes would line every group's mailbox up on
 * the same relay minutes, and whoever reads the relay's nudge table could link
 * the groups. Each group shifts its nudges for a motion instead by an offset
 * every member's device derives alike: HKDF-SHA-256 of the group's secret,
 * with an empty salt, under the info {@link NUDGE_OFFSET_LABEL}, a 0x00 byte
 * and the motion's event id; its 4 bytes, read big-endian, modulo an hour of
 * minutes. Another group's secret gives an offset of its own, so two groups'
 * nudges for one motion meet only by chance, about 1 time in 60.
 * `vectors/nudge-offset.json`, computed with Python's hmac and hashlib, pins
 * it outside @noble.
 */
import { GROUP_SECRET_BYTES } from './groupKeys';
import { hkdfSalted } from './hkdf';

/** The HKDF label of a group's nudge offset (spec §3), so it never coincides with another derivation. */
export const NUDGE_OFFSET_LABEL = 'reconcile/v1/nudge-offset';

/** The offset's range in minutes: it falls within the hour after the motion's own minute. */
export const NUDGE_OFFSET_MINUTES = 60;

/** The bytes the offset takes from HKDF, read as an unsigned 32-bit number. */
const OFFSET_BYTES = 4;

/** An event id as an event spells it: 32 bytes in unpadded base64url. */
const EVENT_ID = /^[A-Za-z0-9_-]{43}$/;

/** HKDF's info for `motion`'s offset: the label's UTF-8, a 0x00 byte, then the id's UTF-8. */
export function nudgeOffsetInfo(motion: string): Uint8Array {
  const encoder = new TextEncoder();
  const label = encoder.encode(NUDGE_OFFSET_LABEL);
  const id = encoder.encode(motion);
  const info = new Uint8Array(label.length + 1 + id.length);
  info.set(label, 0);
  info.set(id, label.length + 1);
  return info;
}

/**
 * The 4 bytes HKDF gives a group's `secret` for `motion`.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes, or `motion` isn't an event id.
 */
export function nudgeOffsetBytes(secret: Uint8Array, motion: string): Uint8Array {
  if (secret.length !== GROUP_SECRET_BYTES) throw new RangeError('A group secret is 32 bytes.');
  if (!EVENT_ID.test(motion)) throw new RangeError('A nudge offset needs an event id.');
  return hkdfSalted(secret, new Uint8Array(0), nudgeOffsetInfo(motion), OFFSET_BYTES);
}

/**
 * The whole minutes, 0 to 59, a group whose secret is `secret` shifts its
 * nudges for `motion` by.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes, or `motion` isn't an event id.
 */
export function nudgeOffset(secret: Uint8Array, motion: string): number {
  const bytes = nudgeOffsetBytes(secret, motion);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0) % NUDGE_OFFSET_MINUTES;
}
