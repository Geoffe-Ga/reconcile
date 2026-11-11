/**
 * A group's secret and what derives from it (spec §3, "Group secret"; ADR-0019).
 *
 * Genesis makes 32 random bytes that only members hold. The store keeps only
 * them; the mailbox ids and the seal key are derived again wherever they are
 * needed, with HKDF-SHA-256 (RFC 5869), an empty salt and 32 bytes of output,
 * under a label of their own. The relay sees mailbox ids and nothing else,
 * and HKDF is one-way, so an id tells it nothing about the secret or the key.
 *
 * Mailboxes rotate weekly (#110; ADR-0019, ADR-0074): each relay week has its
 * own id, from the label, a zero byte and the week's 4 big-endian bytes, so
 * the relay can't tie one week's id to the next without the secret. The seal
 * key stays the same all epoch, and the mailbox id is a blob's associated
 * data, so a blob can't be moved to another week. `vectors/derive.json` pins
 * both derivations, so the labels can't drift.
 */
import { randomBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { hkdf32, type Info } from './hkdf';

/** A group secret's length in bytes. */
export const GROUP_SECRET_BYTES = 32;

/** The HKDF label of a group's mailbox id for one week (#110). */
export const MAILBOX_WEEK_INFO = 'reconcile/v1/mailbox-week';

/** The HKDF label of a group's seal key. */
export const SEAL_KEY_INFO = 'reconcile/v1/seal-key';

/** Minutes in a relay week: 7 × 1,440. */
export const WEEK_MINUTES = 10_080;

/** The largest week its 4 big-endian bytes hold. */
const LAST_WEEK = 0xffff_ffff;

/** A new group secret: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newGroupSecret(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(GROUP_SECRET_BYTES));
}

/**
 * The relay week of the relay minute `minute` (the `now` every GET returns):
 * ⌊minute / 10,080⌋. Unix minute 0 fell on a Thursday, so weeks turn over on
 * Thursday at 00:00 UTC. Callers take `minute` from the relay only, never
 * from the device clock.
 */
export function weekOf(minute: number): number {
  return Math.floor(minute / WEEK_MINUTES);
}

/** HKDF-SHA-256 of `secret` under `info`, after checking the secret's length. */
function derive(secret: Uint8Array, info: Info): Uint8Array<ArrayBuffer> {
  if (secret.length !== GROUP_SECRET_BYTES) {
    throw new RangeError('A group secret is 32 bytes.');
  }
  return hkdf32(secret, info);
}

/** The info of week `week`'s mailbox id: utf8(label) ‖ 0x00 ‖ u32be(week). */
function weekInfo(week: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(week) || week < 0 || week > LAST_WEEK) {
    throw new RangeError('A week is a whole number from 0 to 2³² − 1.');
  }
  const label = new TextEncoder().encode(MAILBOX_WEEK_INFO);
  const info = new Uint8Array(label.length + 5);
  info.set(label);
  new DataView(info.buffer).setUint32(label.length + 1, week, false);
  return info;
}

/**
 * The group's mailbox id at the relay in week `week` (#110): its 43 unpadded
 * base64url characters. It replaces M2-02's one id per secret for all group
 * traffic; an invite's mailbox is its own (`invite.ts`).
 *
 * @throws {RangeError} when `secret` isn't 32 bytes, or `week` isn't a whole
 *   number from 0 to 2³² − 1.
 */
export function deriveWeekMailboxId(secret: Uint8Array, week: number): string {
  return base64url(derive(secret, weekInfo(week)));
}

/**
 * The 32-byte XChaCha20-Poly1305 key the group's blobs are sealed under, in
 * every week of the secret's epoch.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes.
 */
export function deriveSealKey(secret: Uint8Array): Uint8Array<ArrayBuffer> {
  return derive(secret, SEAL_KEY_INFO);
}
