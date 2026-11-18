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
 */
import { concatBytes } from '@noble/hashes/utils.js';

import { canonicalBytes } from './base64url';
import {
  PUBLIC_KEY_BYTES,
  SHELF_CONTEXT,
  SIGNATURE_BYTES,
  type SigningKeys,
  sign,
  verify,
} from './sign';

export { SHELF_CONTEXT };

/** The record for `message`, signed with `keys`: the signature, then the message. */
export function signShelfRecord(keys: SigningKeys, message: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(concatBytes(sign(SHELF_CONTEXT, keys.secretKey, message), message));
}

/**
 * The message inside `record`, in bytes of its own, when `address` is a
 * canonical 43-character key and its signature over a message of at least one
 * byte verifies under the shelf tag; otherwise null.
 */
export function verifyShelfRecord(record: Uint8Array, address: string): Uint8Array | null {
  const key = canonicalBytes(address);
  if (key?.length !== PUBLIC_KEY_BYTES || record.length <= SIGNATURE_BYTES) return null;
  const message = record.subarray(SIGNATURE_BYTES);
  const signature = record.subarray(0, SIGNATURE_BYTES);
  return verify(SHELF_CONTEXT, key, signature, message) ? message.slice() : null;
}
