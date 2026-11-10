/**
 * A group's secret and what derives from it (spec §3, "Group secret"; ADR-0019).
 *
 * Genesis makes 32 random bytes that only members hold. The store keeps only
 * them; the mailbox id and the seal key are derived again wherever they are
 * needed, with HKDF-SHA-256 (RFC 5869), an empty salt and 32 bytes of output,
 * under a label of their own. The relay sees the mailbox id and nothing else,
 * and HKDF is one-way, so the id tells it nothing about the secret or the key.
 * `vectors/derive.json` pins both derivations, so the labels can't drift.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';

/** A group secret's length in bytes. */
export const GROUP_SECRET_BYTES = 32;

/** The HKDF label of a group's mailbox id. */
export const MAILBOX_INFO = 'reconcile/v1/mailbox';

/** The HKDF label of a group's seal key. */
export const SEAL_KEY_INFO = 'reconcile/v1/seal-key';

/** Every derivation's output length in bytes. */
const OUTPUT_BYTES = 32;

/** RFC 5869's empty salt, which HMAC treats as HashLen zero bytes. */
const EMPTY_SALT = new Uint8Array(0);

/** A new group secret: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newGroupSecret(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(GROUP_SECRET_BYTES));
}

/** HKDF-SHA-256 of `secret` under `info`, after checking the secret's length. */
function derive(secret: Uint8Array, info: string): Uint8Array<ArrayBuffer> {
  if (secret.length !== GROUP_SECRET_BYTES) {
    throw new RangeError('A group secret is 32 bytes.');
  }
  return Uint8Array.from(hkdf(sha256, secret, EMPTY_SALT, utf8ToBytes(info), OUTPUT_BYTES));
}

/**
 * The group's mailbox id at the relay: its 43 unpadded base64url characters.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes.
 */
export function deriveMailboxId(secret: Uint8Array): string {
  return base64url(derive(secret, MAILBOX_INFO));
}

/**
 * The 32-byte XChaCha20-Poly1305 key the group's blobs are sealed under.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes.
 */
export function deriveSealKey(secret: Uint8Array): Uint8Array<ArrayBuffer> {
  return derive(secret, SEAL_KEY_INFO);
}
