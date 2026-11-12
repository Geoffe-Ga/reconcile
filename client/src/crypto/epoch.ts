/**
 * A new group key when someone leaves (#98; ADR-0072 item 11, ADR-0074).
 *
 * A group's secret has an epoch: 0 from genesis, then one more each time a
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
 * doesn't open. The secret itself never leaves a device but inside a wrap.
 * `vectors/epoch.json` pins the commit and a wrap, made outside @noble.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, canonicalBytes } from './base64url';
import { openBox, sealTo } from './box';
import { GROUP_SECRET_BYTES, newGroupSecret } from './groupKeys';

/** The tag a commit hashes before its fields. */
export const EPOCH_COMMIT_TAG = 'reconcile/v1/epoch-commit';

/** The HKDF label of a wrap's box. */
export const EPOCH_WRAP_INFO = 'reconcile/v1/epoch-wrap';

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
 * unpadded base64url.
 *
 * @throws {RangeError} when `kx` can't take a box, or the epoch isn't a u32.
 */
export function wrapEpochSecret(
  place: WrapPlace & { readonly kx: Uint8Array; readonly secret: Uint8Array },
): string {
  return base64url(sealTo(place.kx, place.secret, EPOCH_WRAP_INFO, wrapAad(place)));
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
