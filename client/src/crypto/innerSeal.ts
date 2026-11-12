/**
 * A coalition's seat in a coalition above it, sealed inside its own log
 * (spec §4 Coalitions; ADR-0036, ADR-0075 §1; #122).
 *
 * When coalition C reconciles into, or asks into, coalition D, its reconcile
 * motion carries D's secret, D's `inner` and C's seat secret in D. C's log is
 * readable by everyone who holds C's secret, its followers too (#124), so the
 * three travel in one `sealed` field: the app's {@link seal} under a key
 * derived from C's `inner`, which only C's member groups' sealed logs hold
 * and followers never get, with C's id as associated data, so a field moved
 * into another coalition's log never opens. The field is base64url of
 * exactly one 1,024-byte blob, the smallest a Seal makes, holding the 96
 * bytes `secret ‖ inner ‖ seat`. `vectors/innerSeal.json` pins the key and
 * one field, computed outside @noble.
 *
 * A coalition asking into a formed D holds no `inner` of D's until it is
 * seated, as a group asking in doesn't (#313): its field holds the 64 bytes
 * `secret ‖ seat`, in the same one blob, and C's devices open D's `inner`
 * from a wrap for C's seat once D admits it.
 */
import { concatBytes } from '@noble/hashes/utils.js';

import { base64url, fromBase64url } from './base64url';
import { hkdf32 } from './hkdf';
import { BLOB_SIZES, open, seal } from './seal';

/** The HKDF label of the key a coalition's seats above are sealed under. */
export const INNER_SEAL_INFO = 'reconcile/v1/inner-seal';

/** The bytes of a sealed field: one blob of the smallest size. */
export const SEALED_SECRETS_BYTES = BLOB_SIZES[0];

/** A sealed field's length in unpadded base64url: 1,366 characters. */
export const SEALED_FIELD_CHARS = Math.ceil((SEALED_SECRETS_BYTES * 4) / 3);

/** Each secret's length in bytes. */
const SECRET_BYTES = 32;

/**
 * What a sealed field holds: the coalition above's secret and `inner`, and the
 * seat secret there; no `inner` for a coalition asking into a formed one (#313).
 */
export interface SeatSecrets {
  readonly secret: Uint8Array;
  readonly inner?: Uint8Array;
  readonly seat: Uint8Array;
}

/** Refuses anything but 32 bytes. */
function check32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== SECRET_BYTES) throw new RangeError(`${what} is 32 bytes.`);
}

/**
 * The key a coalition's seats above are sealed under: HKDF-SHA-256 of its
 * `inner` under {@link INNER_SEAL_INFO}.
 *
 * @throws {RangeError} when `inner` isn't 32 bytes.
 */
export function innerSealKey(inner: Uint8Array): Uint8Array<ArrayBuffer> {
  check32(inner, 'An inner');
  return hkdf32(inner, INNER_SEAL_INFO);
}

/**
 * The `sealed` field of a reconcile motion in the coalition `coalitionId`,
 * whose `inner` is `inner`: the secrets in one blob, in base64url.
 *
 * @throws {RangeError} when `inner` or any secret isn't 32 bytes.
 */
export function sealSeatSecrets(coalitionId: string, inner: Uint8Array, held: SeatSecrets): string {
  check32(held.secret, 'A secret');
  if (held.inner !== undefined) check32(held.inner, 'An inner');
  check32(held.seat, 'A seat secret');
  const above = held.inner === undefined ? [] : [held.inner];
  const plaintext = concatBytes(held.secret, ...above, held.seat);
  return base64url(seal(coalitionId, innerSealKey(inner), plaintext));
}

/** The bytes of base64url `text`, or null when it isn't base64url. */
function bytesOf(text: string): Uint8Array | null {
  try {
    return fromBase64url(text);
  } catch {
    return null;
  }
}

/** The secrets in an opened field: 96 bytes with the `inner` above, 64 without (#313), else null. */
function secretsOf(plaintext: Uint8Array): SeatSecrets | null {
  const secret = plaintext.slice(0, SECRET_BYTES);
  const seat = plaintext.slice(-SECRET_BYTES);
  if (plaintext.length === 2 * SECRET_BYTES) return { secret, seat };
  if (plaintext.length !== 3 * SECRET_BYTES) return null;
  return { secret, inner: plaintext.slice(SECRET_BYTES, 2 * SECRET_BYTES), seat };
}

/**
 * The secrets in a `sealed` field of the coalition `coalitionId`, or null
 * when it doesn't open under `inner`: another key, another coalition, any
 * changed byte, or anything but exactly 96 bytes inside, or 64 for a seat
 * with no `inner` above (#313).
 */
export function openSeatSecrets(
  coalitionId: string,
  inner: Uint8Array,
  sealed: string,
): SeatSecrets | null {
  const blob = bytesOf(sealed);
  if (blob === null || inner.length !== SECRET_BYTES) return null;
  const plaintext = open(coalitionId, innerSealKey(inner), blob);
  return plaintext === null ? null : secretsOf(plaintext);
}
