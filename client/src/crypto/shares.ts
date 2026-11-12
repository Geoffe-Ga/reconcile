/**
 * Recovery shares (#109; ADR-0043 §1, ADR-0074, ADR-0075 §4): the relay
 * backup's key split among the people a person trusts, and each piece
 * sealed to one of them.
 *
 * - **Splitting.** {@link splitKey} splits the 32-byte backup key
 *   (`relayBackup.ts`) into `n` shares, any `t` of which rebuild it, with
 *   Shamir's scheme over GF(2^8) from `shamir-secret-sharing`, pinned
 *   exactly. This is the only file that imports it (ADR-0075 §4,
 *   dependency-cruiser holds it). Fewer than `t` shares reveal nothing about
 *   the key. Each share is the 32 y-bytes, then its x-coordinate, from 1 to
 *   255: 33 bytes.
 * - **Sealing.** {@link sealShare} seals one share to its contact's
 *   per-group encryption key (`box.ts`, #98) under the info
 *   `reconcile/v1/recovery-share`, with the group id ‖ the contact's key ‖
 *   the author's key as associated data, each as the events spell it, in
 *   UTF-8. The plaintext is the JSON `{v: 1, split, t, n, share}`: `split`
 *   names the split it came from (16 random bytes), and `share` is the
 *   share, both in unpadded base64url. A box moved to another group, or
 *   to another contact, or posted again under another author's name, never
 *   opens: the author is bound too, so nobody can pass off someone else's
 *   share as their own.
 * - **Opening.** {@link openShare} answers null alike for a box that doesn't
 *   open there and for one that opens to anything but a well-shaped share.
 *
 * The library doesn't check what it rebuilds: shares from different splits
 * rebuild a wrong key. Whoever rebuilds one (#118) checks it against the
 * relay backup's id, which only the right key names.
 * `vectors/shares.json` pins the layout, the field and the box with values
 * computed outside the library and @noble.
 */
import { combine, split } from 'shamir-secret-sharing';

import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, canonicalBytes } from './base64url';
import { openBox, sealTo } from './box';
import { isAllowedThreshold } from './recoveryPolicy';
import { BACKUP_KEY_BYTES } from './relayBackup';

/** The HKDF label of a recovery share's box. */
export const RECOVERY_SHARE_INFO = 'reconcile/v1/recovery-share';

/** A share's length in bytes: the key's 32 y-bytes, then its x-coordinate. */
export const SHARE_BYTES = BACKUP_KEY_BYTES + 1;

/** A split id's length in bytes. */
export const SPLIT_ID_BYTES = 16;

/** The one plaintext version this file seals and opens. */
const SHARE_VERSION = 1;

/** One share as its contact holds it: its split, the threshold, and the share. */
export interface RecoveryShare {
  /** The split it came from: 16 random bytes in unpadded base64url. */
  readonly split: string;
  /** How many shares it takes to rebuild the key. */
  readonly t: number;
  /** How many shares the split made. */
  readonly n: number;
  /** The 33-byte share. */
  readonly share: Uint8Array;
}

/** Where a share's box belongs: its group, the contact it is for, and who sent it. */
export interface SharePlace {
  /** The group id, as every event carries it. */
  readonly groupId: string;
  /** The contact's signing key in the group, as events name members: their `author`. */
  readonly contact: string;
  /** The sender's signing key in the group: the `author` of the event that carries the box. */
  readonly author: string;
}

/** Whether `share` is 33 bytes with an x-coordinate from 1 to 255. */
function isShare(share: Uint8Array): boolean {
  return share.length === SHARE_BYTES && share[SHARE_BYTES - 1] !== 0;
}

/**
 * Splits the 32-byte `key` into `n` shares, any `t` of which rebuild it,
 * with fresh coordinates and coefficients from the platform's CSPRNG.
 *
 * @throws {RangeError} when `key` isn't 32 bytes, or `t` of `n` isn't
 *   between 2 of 3 and 5 of 7 (`recoveryPolicy.ts`).
 */
export async function splitKey(
  key: Uint8Array,
  n: number,
  t: number,
): Promise<Uint8Array<ArrayBuffer>[]> {
  if (key.length !== BACKUP_KEY_BYTES) throw new RangeError('A backup key is 32 bytes.');
  if (!isAllowedThreshold(t, n)) {
    throw new RangeError('Recovery takes from 2 of 3 to 5 of 7 contacts.');
  }
  // A copy in this realm: the library checks each array's constructor.
  const secret = Uint8Array.from(key);
  try {
    const shares = await split(secret, n, t);
    return shares.map((share) => Uint8Array.from(share));
  } finally {
    secret.fill(0);
  }
}

/** Whether `shares` can be one set: 2 to 255 shares, each well-shaped, no coordinate twice. */
function isShareSet(shares: readonly Uint8Array[]): boolean {
  const xs = new Set(shares.map((share) => share[SHARE_BYTES - 1]));
  return (
    shares.length >= 2 && shares.length <= 255 && xs.size === shares.length && shares.every(isShare)
  );
}

/**
 * The key that `shares` rebuild, or null when they can't be one set: fewer
 * than two, one of the wrong length or with coordinate 0, or one coordinate
 * twice. Shares from different splits, or fewer than their threshold,
 * rebuild a wrong key, which only the relay backup's id tells apart.
 */
export async function combineShares(
  shares: readonly Uint8Array[],
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isShareSet(shares)) return null;
  const copies = shares.map((share) => Uint8Array.from(share));
  try {
    return Uint8Array.from(await combine(copies));
  } finally {
    for (const copy of copies) copy.fill(0);
  }
}

/** A new split id: 16 random bytes in unpadded base64url, 22 characters. */
export function newSplitId(): string {
  return base64url(randomBytes(SPLIT_ID_BYTES));
}

/** A box's associated data: group id ‖ contact key ‖ author key, in UTF-8. */
function shareAad({ groupId, contact, author }: SharePlace): Uint8Array {
  return concatBytes(utf8ToBytes(groupId), utf8ToBytes(contact), utf8ToBytes(author));
}

/** Whether `split` is 16 bytes in canonical unpadded base64url. */
function isSplitId(split: unknown): split is string {
  return canonicalBytes(split)?.length === SPLIT_ID_BYTES;
}

/**
 * `share` sealed to the contact's X25519 public key `kx` at `place`, as the
 * unpadded base64url a `recovery-share` event carries.
 *
 * @throws {RangeError} when the share isn't 33 bytes with a coordinate from
 *   1 to 255, the split id isn't 16 bytes, the threshold isn't allowed, or
 *   `kx` can't take a box.
 */
export function sealShare(
  place: SharePlace & { readonly kx: Uint8Array },
  { split: splitId, t, n, share }: RecoveryShare,
): string {
  if (!isShare(share) || !isSplitId(splitId) || !isAllowedThreshold(t, n)) {
    throw new RangeError('That isn’t a recovery share.');
  }
  const json = JSON.stringify({ v: SHARE_VERSION, split: splitId, t, n, share: base64url(share) });
  const plaintext = utf8ToBytes(json);
  try {
    return base64url(sealTo(place.kx, plaintext, RECOVERY_SHARE_INFO, shareAad(place)));
  } finally {
    plaintext.fill(0);
  }
}

/** The JSON object in `plaintext`, or null for bad UTF-8, bad JSON or anything but an object. */
function objectIn(plaintext: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/** The share a box's plaintext holds, or null unless it is a well-shaped version-1 share. */
function shareIn(plaintext: Uint8Array): RecoveryShare | null {
  const body = objectIn(plaintext);
  if (body === null || body.v !== SHARE_VERSION || !isSplitId(body.split)) return null;
  const { t, n } = body;
  const share = canonicalBytes(body.share);
  if (typeof t !== 'number' || typeof n !== 'number' || !isAllowedThreshold(t, n)) return null;
  return share !== null && isShare(share) ? { split: body.split, t, n, share } : null;
}

/**
 * The share in `box` for the holder of the X25519 secret key `kxKey` at
 * `place`, or null when the box doesn't open there (another contact, group
 * or author, or any changed byte) or opens to anything but a well-shaped
 * share.
 */
export function openShare(
  place: SharePlace & { readonly kxKey: Uint8Array; readonly box: string },
): RecoveryShare | null {
  const box = canonicalBytes(place.box);
  if (box === null) return null;
  const plaintext = openBox(place.kxKey, box, RECOVERY_SHARE_INFO, shareAad(place));
  if (plaintext === null) return null;
  try {
    return shareIn(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
