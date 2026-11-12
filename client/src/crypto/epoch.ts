/**
 * A new group key when someone leaves (#98; ADR-0072 item 11, ADR-0074), and
 * the check that lets a group recover from one that doesn't open (#224;
 * ADR-0075's 2026-11-11 amendment).
 *
 * A group's secret has an epoch: 0 from genesis, then a higher one each time a
 * `key-rotate` becomes canonical. Its author makes the next epoch's secret
 * and posts only two things derived from it:
 *
 * - `commit`, the unpadded base64url SHA-256 of UTF-8 `reconcile/v1/epoch-commit`
 *   ‖ 0x00 ‖ the group id's UTF-8 ‖ u32be(epoch) ‖ the secret, which every
 *   member can check a secret against and nobody can turn back into one;
 * - one wrap per member who has an encryption key: a box (`box.ts`) of the
 *   secret sealed to their `kx` under `reconcile/v1/epoch-wrap`, with the
 *   group id ‖ u32be(epoch) ‖ the member's key ‖ the commit as associated
 *   data, each text as the event spells it, in UTF-8.
 *
 * The associated data ties a wrap to its one place, so a wrap moved to
 * another member, epoch or group never opens. A member whose wrap opens to a
 * secret that doesn't match the commit treats it as missing, like one that
 * doesn't open.
 *
 * Since #224 a wrap's coins, its ephemeral key and nonce, are not drawn fresh
 * but derived from the secret and the wrap's place: the 56 bytes of
 * HKDF-SHA-256(ikm = secret, empty salt, info = UTF-8 `reconcile/v1/epoch-wrap-coins`
 * ‖ 0x00 ‖ the member's 32-byte `kx` ‖ the associated data), the first 32 the
 * ephemeral key and the last 24 the nonce (encrypt-with-hash: the secret is 32
 * random bytes, so the coins are as unguessable as fresh ones, and each place
 * gets its own). So whoever holds the secret makes every wrap again, byte for
 * byte, and a device whose own wrap opens can check that everyone else's will
 * too ({@link wrapsHold}) before it takes the key up. The secret itself never
 * leaves a device but inside a wrap. `vectors/epoch.json` pins the commit, a
 * #98 wrap and a derived wrap, all made outside @noble.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, canonicalBytes } from './base64url';
import { BOX_NONCE_BYTES, KX_KEY_BYTES, openBox, sealToWith } from './box';
import { GROUP_SECRET_BYTES, newGroupSecret } from './groupKeys';
import { hkdfSalted } from './hkdf';

/** The tag a commit hashes before its fields. */
export const EPOCH_COMMIT_TAG = 'reconcile/v1/epoch-commit';

/** The HKDF label of a wrap's box. */
export const EPOCH_WRAP_INFO = 'reconcile/v1/epoch-wrap';

/** The HKDF label a wrap's coins, its ephemeral key and nonce, derive under (#224). */
export const EPOCH_WRAP_COINS_INFO = 'reconcile/v1/epoch-wrap-coins';

/** RFC 5869's empty salt. */
const NO_SALT = new Uint8Array(0);

/** The largest epoch: its big-endian u32. */
const MAX_EPOCH = 0xffff_ffff;

/** Where a wrap belongs: its group, its epoch, and the member it is for. */
export interface WrapPlace {
  /** The group id, as every event carries it. */
  readonly groupId: string;
  /** The epoch the wrapped secret opens. */
  readonly epoch: number;
  /** The member's signing key, as the wraps name it: their `author`. */
  readonly member: string;
  /** The commit the `key-rotate` carries. */
  readonly commit: string;
}

/** A new epoch's secret: 32 bytes from the platform's CSPRNG, as genesis makes. */
export function newEpochSecret(): Uint8Array<ArrayBuffer> {
  return newGroupSecret();
}

/** `epoch` as four big-endian bytes. */
function u32be(epoch: number): Uint8Array {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) {
    throw new RangeError('An epoch is a whole number from 0 to 2^32 − 1.');
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, epoch);
  return bytes;
}

/**
 * The commit to epoch `epoch`'s `secret` in group `groupId`.
 *
 * @throws {RangeError} when the secret isn't 32 bytes or the epoch isn't a u32.
 */
export function epochCommit(groupId: string, epoch: number, secret: Uint8Array): string {
  if (secret.length !== GROUP_SECRET_BYTES) throw new RangeError('A group secret is 32 bytes.');
  const tag = concatBytes(utf8ToBytes(EPOCH_COMMIT_TAG), Uint8Array.of(0));
  return base64url(sha256(concatBytes(tag, utf8ToBytes(groupId), u32be(epoch), secret)));
}

/** A wrap's associated data: group id ‖ u32be(epoch) ‖ member key ‖ commit. */
function wrapAad({ groupId, epoch, member, commit }: WrapPlace): Uint8Array {
  return concatBytes(utf8ToBytes(groupId), u32be(epoch), utf8ToBytes(member), utf8ToBytes(commit));
}

/**
 * Epoch `epoch`'s `secret` wrapped to one member's X25519 public key `kx`, in
 * unpadded base64url, with coins the secret and the place derive (#224): the
 * same secret to the same place makes the same wrap.
 *
 * @throws {RangeError} when `kx` can't take a box, or the epoch isn't a u32.
 */
export function wrapEpochSecret(
  place: WrapPlace & { readonly kx: Uint8Array; readonly secret: Uint8Array },
): string {
  const aad = wrapAad(place);
  const info = concatBytes(utf8ToBytes(EPOCH_WRAP_COINS_INFO), Uint8Array.of(0), place.kx, aad);
  const coins = hkdfSalted(place.secret, NO_SALT, info, KX_KEY_BYTES + BOX_NONCE_BYTES);
  const ephemeral = coins.subarray(0, KX_KEY_BYTES);
  const nonce = coins.subarray(KX_KEY_BYTES);
  try {
    return base64url(
      sealToWith(place.kx, place.secret, EPOCH_WRAP_INFO, aad, { ephemeral, nonce }),
    );
  } finally {
    coins.fill(0);
  }
}

/**
 * The secret in a member's `wrap`, opened with their X25519 secret key
 * `kxKey`, or null when it doesn't open there, or opens to anything that isn't
 * the secret the commit names: either way the wrap is missing.
 */
export function unwrapEpochSecret(
  place: WrapPlace & { readonly wrap: string; readonly kxKey: Uint8Array },
): Uint8Array | null {
  const box = canonicalBytes(place.wrap);
  if (box === null) return null;
  const secret = openBox(place.kxKey, box, EPOCH_WRAP_INFO, wrapAad(place));
  if (secret?.length !== GROUP_SECRET_BYTES) return null;
  return epochCommit(place.groupId, place.epoch, secret) === place.commit ? secret : null;
}

/** A key change as {@link wrapsHold} checks it: where it goes, the secret, and each wrap with the key it's for. */
export interface WrapSet {
  readonly groupId: string;
  readonly epoch: number;
  readonly commit: string;
  readonly secret: Uint8Array;
  /** Each recipient's encryption key, base64url, by member key: what the group held for them. */
  readonly keys: Readonly<Record<string, string>>;
  /** Each recipient's wrap, by member key, as the key change carries it. */
  readonly wraps: Readonly<Record<string, string>>;
}

/** The 32-byte X25519 public key in base64url `kx`, or null. */
function keyBytes(kx: string): Uint8Array | null {
  const bytes = canonicalBytes(kx);
  return bytes?.length === KX_KEY_BYTES ? bytes : null;
}

/** The wrap `secret` makes for one recipient at `set`'s place, or null when their key can't take one. */
function wrapFor(set: WrapSet, member: string, kx: string): string | null {
  const key = keyBytes(kx);
  if (key === null) return null;
  const { groupId, epoch, commit, secret } = set;
  try {
    return wrapEpochSecret({ groupId, epoch, member, commit, kx: key, secret });
  } catch {
    // A key of low order: no box can be sealed to it.
    return null;
  }
}

/**
 * Whether every wrap in `set` is the one its secret makes for its member, and
 * the wraps and keys name the same members (#224). A device whose own wrap
 * opens checks this before it takes the key up: when it holds, every other
 * recipient's wrap opens for them too, so no member is left out of the new
 * key while the rest move on. A secret the commit doesn't name never holds.
 */
export function wrapsHold(set: WrapSet): boolean {
  const { groupId, epoch, commit, secret, keys, wraps } = set;
  if (secret.length !== GROUP_SECRET_BYTES) return false;
  if (epochCommit(groupId, epoch, secret) !== commit) return false;
  const members = Object.keys(keys);
  if (Object.keys(wraps).length !== members.length) return false;
  return members.every((member) => {
    const kx = keys[member] ?? '';
    return Object.hasOwn(wraps, member) && wraps[member] === wrapFor(set, member, kx);
  });
}
