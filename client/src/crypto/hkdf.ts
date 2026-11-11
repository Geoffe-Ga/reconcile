/**
 * The one HKDF call site (spec §3): HKDF-SHA-256 (RFC 5869). A group secret's
 * weekly mailbox ids and seal key (`groupKeys.ts`), an invite seed's mailbox
 * id and key (`invite.ts`), a share seed's (`share.ts`, #105), a front
 * door's page, inbox and reply mailboxes (`door.ts`, #121) and a link's
 * channels (`link.ts`, #96) all derive through it, each under a label of its
 * own, so no two ever coincide. Most take an empty salt and 32 bytes of
 * output. A weekly mailbox id's info is bytes, its label then its week
 * (#110). A box's key (`box.ts`, #98) is salted with the two public keys of
 * its X25519 exchange; a link's number and key are salted with the hash of
 * the link's transcript, and its number takes 4 bytes; the key vault's key
 * (`keyVault.ts`, #95) is salted with the passkey's PRF salt.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Every derivation's output length in bytes, unless it asks for another. */
const OUTPUT_BYTES = 32;

/** RFC 5869's empty salt, which HMAC treats as HashLen zero bytes. */
const EMPTY_SALT = new Uint8Array(0);

/** An HKDF info: a label, taken as its UTF-8 bytes, or bytes as they are. */
export type Info = string | Uint8Array;

/** HKDF-SHA-256 of `secret` under the label `info`, with `salt`: `length` bytes. */
export function hkdfSalted(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Info,
  length: number,
): Uint8Array<ArrayBuffer> {
  const infoBytes = typeof info === 'string' ? utf8ToBytes(info) : info;
  return Uint8Array.from(hkdf(sha256, secret, salt, infoBytes, length));
}

/**
 * HKDF-SHA-256 of `secret` under the label `info`, salted with `salt` (empty
 * unless given): 32 bytes. Callers check the secret's length.
 */
export function hkdf32(
  secret: Uint8Array,
  info: Info,
  salt: Uint8Array = EMPTY_SALT,
): Uint8Array<ArrayBuffer> {
  return hkdfSalted(secret, salt, info, OUTPUT_BYTES);
}
