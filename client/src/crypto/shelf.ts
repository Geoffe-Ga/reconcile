/**
 * Public shelf records (#484; ADR-0081; docs/spec/listed-doors.md §4.1).
 *
 * A record is a 64-byte Ed25519 signature, then the message it covers: the
 * record's compact UTF-8 JSON (`shelf/record.ts` writes and reads it). The
 * signature is over the shelf tag, `reconcile/v1/shelf`, one 0x00 byte and
 * the message (`sign.ts`), so no event, page or copy ever passes for one. The
 * signer is a listed door's `sign` key for a group's records, and its
 * address, the public key in unpadded base64url, travels beside the record
 * (the relay path it's PUT to, and each record a GET returns), not inside it.
 *
 * Verification is `sign.ts`'s strict RFC 8032 check, so the relay, which
 * checks too, is never the only thing that stands between a reader and a
 * forged record. `vectors/shelf.json` pins it, computed outside @noble.
 *
 * The steward's inbox (#490; listed-doors.md §6.3) is an ordinary mailbox
 * whose id derives from the steward's pinned X25519 key, as a door's inbox
 * derives from its address:
 *
 * ```
 * inbox = base64url(HKDF(steward box key, "reconcile/v1/steward-inbox"))
 * ```
 *
 * Reports and appeals go there as padded boxes (`door.ts`) sealed to that
 * key, each under a box label of its own ({@link REPORT_INFO},
 * {@link APPEAL_INFO}), so neither ever opens as the other or as anything
 * else. An appeal's plaintext is signed as a record is, by the listed door's
 * key, but under a tag of its own, `reconcile/v1/steward-appeal`, so no
 * appeal passes for a shelf record and no shelf record for an appeal.
 */
import { concatBytes } from '@noble/hashes/utils.js';

import { base64url, canonicalBytes } from './base64url';
import { KX_KEY_BYTES } from './box';
import { hkdf32 } from './hkdf';
import {
  APPEAL_CONTEXT,
  PUBLIC_KEY_BYTES,
  SHELF_CONTEXT,
  SIGNATURE_BYTES,
  type SignContext,
  type SigningKeys,
  sign,
  verify,
} from './sign';

export { SHELF_CONTEXT };

/** The HKDF label of the steward's inbox mailbox id (#490). */
export const STEWARD_INBOX_INFO = 'reconcile/v1/steward-inbox';

/** The box label of a report, sealed to the steward's box key (#490). */
export const REPORT_INFO = 'reconcile/v1/steward-report';

/** The box label of an appeal, sealed to the steward's box key (#490). */
export const APPEAL_INFO = 'reconcile/v1/steward-appeal-box';

/**
 * The steward's inbox mailbox id, from the steward's X25519 public key.
 *
 * @throws {RangeError} when `box` isn't 32 bytes.
 */
export function stewardInboxOf(box: Uint8Array): string {
  if (box.length !== KX_KEY_BYTES) throw new RangeError('The steward’s box key is 32 bytes.');
  return base64url(hkdf32(box, STEWARD_INBOX_INFO));
}

/** `message` signed with `keys` under `tag`: the signature, then the message. */
function signed(tag: SignContext, keys: SigningKeys, message: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(concatBytes(sign(tag, keys.secretKey, message), message));
}

/** The message in `record` when it verifies under `tag` and `address`, as a copy; else null. */
function verified(tag: SignContext, record: Uint8Array, address: string): Uint8Array | null {
  const key = canonicalBytes(address);
  if (key?.length !== PUBLIC_KEY_BYTES || record.length <= SIGNATURE_BYTES) return null;
  const message = record.subarray(SIGNATURE_BYTES);
  const signature = record.subarray(0, SIGNATURE_BYTES);
  return verify(tag, key, signature, message) ? message.slice() : null;
}

/** The record for `message`, signed with `keys`: the signature, then the message. */
export function signShelfRecord(keys: SigningKeys, message: Uint8Array): Uint8Array<ArrayBuffer> {
  return signed(SHELF_CONTEXT, keys, message);
}

/**
 * The message inside `record`, in bytes of its own, when `address` is a
 * canonical 43-character key and its signature over a message of at least one
 * byte verifies under the shelf tag; otherwise null.
 */
export function verifyShelfRecord(record: Uint8Array, address: string): Uint8Array | null {
  return verified(SHELF_CONTEXT, record, address);
}

/** An appeal's `message`, signed with a listed door's `keys` under the appeal tag (#490). */
export function signAppeal(keys: SigningKeys, message: Uint8Array): Uint8Array<ArrayBuffer> {
  return signed(APPEAL_CONTEXT, keys, message);
}

/**
 * The message inside an appeal, in bytes of its own, when its signature over
 * at least one byte verifies under the appeal tag and `address`; else null.
 */
export function verifyAppeal(record: Uint8Array, address: string): Uint8Array | null {
  return verified(APPEAL_CONTEXT, record, address);
}
