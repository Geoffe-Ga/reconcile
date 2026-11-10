/**
 * The one HKDF call site (spec §3): HKDF-SHA-256 (RFC 5869) with an empty
 * salt and 32 bytes of output. A group secret's mailbox id and seal key
 * (`groupKeys.ts`) and an invite seed's mailbox id and key (`invite.ts`) all
 * derive through it, each under a label of its own, so no two ever coincide.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Every derivation's output length in bytes. */
const OUTPUT_BYTES = 32;

/** RFC 5869's empty salt, which HMAC treats as HashLen zero bytes. */
const EMPTY_SALT = new Uint8Array(0);

/** HKDF-SHA-256 of `secret` under the label `info`: 32 bytes. Callers check the secret's length. */
export function hkdf32(secret: Uint8Array, info: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hkdf(sha256, secret, EMPTY_SALT, utf8ToBytes(info), OUTPUT_BYTES));
}
