/**
 * A shared personal Document's seed, what derives from it, and its signed
 * copies (spec §11 "Share link"; #105; ADR-0074's personal page at level 2).
 *
 * 'Share link' makes 32 random bytes, the seed, which travels only after `#`
 * in the link, and a fresh Ed25519 keypair used for this one share. The share
 * mailbox id and the key its copies are sealed under derive from the seed
 * through the same HKDF as a group secret's (`hkdf.ts`), under labels of
 * their own, so a seed names no group or invite mailbox and opens no group
 * blob. The relay sees the share mailbox id and nothing else.
 *
 * Everyone holding the link holds the seal key, so any of them could seal a
 * copy into the mailbox. Only copies the owner's key signed count: the link
 * carries that public key, and {@link openShareRecord} keeps a copy only when
 * the record's key is the link's and its signature verifies under the share
 * tag, which no event or invite token signature ever passes for.
 * `vectors/share.json` pins both derivations and one record, computed
 * outside @noble.
 */
import { randomBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { hkdf32 } from './hkdf';
import { openTagged, signTagged } from './record';
import { SHARE_CONTEXT, type SigningKeys } from './sign';

/** A share seed's length in bytes. */
export const SHARE_SEED_BYTES = 32;

/** The HKDF label of a share's mailbox id. */
export const SHARE_MAILBOX_INFO = 'reconcile/v1/share-mailbox';

/** The HKDF label of the key a share's copies are sealed under. */
export const SHARE_KEY_INFO = 'reconcile/v1/share-key';

/** Where a share's copies go and the key they're sealed under, both derived from its seed. */
export interface ShareChannel {
  /** The share mailbox id at the relay. */
  readonly mailbox: string;
  /** The XChaCha20-Poly1305 key its copies are sealed under. */
  readonly key: Uint8Array;
}

/** A new share seed: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newShareSeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(SHARE_SEED_BYTES));
}

/** HKDF-SHA-256 of `seed` under `info`, after checking the seed's length. */
function derive(seed: Uint8Array, info: string): Uint8Array<ArrayBuffer> {
  if (seed.length !== SHARE_SEED_BYTES) {
    throw new RangeError('A share seed is 32 bytes.');
  }
  return hkdf32(seed, info);
}

/**
 * The share's mailbox id at the relay: its 43 unpadded base64url characters.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function deriveShareMailboxId(seed: Uint8Array): string {
  return base64url(derive(seed, SHARE_MAILBOX_INFO));
}

/**
 * The 32-byte key the share's copies are sealed under.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function deriveShareKey(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  return derive(seed, SHARE_KEY_INFO);
}

/**
 * The share mailbox id and key that `seed` derives.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function shareChannelOf(seed: Uint8Array): ShareChannel {
  return { mailbox: deriveShareMailboxId(seed), key: deriveShareKey(seed) };
}

/**
 * The record for one copy, signed with the share's own `keys`: public key ‖
 * signature ‖ copy, framed as an event's record is, under the share tag.
 */
export function signShareRecord(keys: SigningKeys, copy: Uint8Array): Uint8Array<ArrayBuffer> {
  return signTagged(SHARE_CONTEXT, keys, copy);
}

/**
 * The copy inside `record` when its key is exactly `publicKey`, the one the
 * link names, and its signature verifies under the share tag; otherwise
 * `null`, for bytes too short to hold a key and a signature as for any other
 * key or any changed byte. The copy comes back in bytes of its own.
 */
export function openShareRecord(record: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  return openTagged(SHARE_CONTEXT, record, publicKey);
}
