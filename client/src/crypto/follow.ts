/**
 * A follow link's seed, and what derives from it (spec §3 "Follow seed"; #124).
 *
 * A new follow link starts from 32 random bytes, the link's seed, which travels
 * only after `#` in the link. The follow mailbox id and the key its envelope
 * is sealed under derive from the seed through the same HKDF as a group
 * secret's (`hkdf.ts`), under labels of their own, so a seed names no group,
 * invite, card or coalition mailbox and opens no blob of theirs. The relay
 * sees the follow mailbox id and nothing else. `vectors/follow.json` pins
 * both derivations, computed outside @noble.
 */
import { randomBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { hkdf32 } from './hkdf';
import type { InviteChannel } from './invite';

/** A follow seed's length in bytes. */
export const FOLLOW_SEED_BYTES = 32;

/** The HKDF label of a follow link's mailbox id. */
export const FOLLOW_MAILBOX_INFO = 'reconcile/v1/follow-mailbox';

/** The HKDF label of the key a follow link's envelope is sealed under. */
export const FOLLOW_KEY_INFO = 'reconcile/v1/follow-key';

/** A new follow seed: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newFollowSeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(FOLLOW_SEED_BYTES));
}

/**
 * The follow mailbox id and the key its envelope is sealed under, both
 * derived from `seed`.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function followChannelOf(seed: Uint8Array): InviteChannel {
  if (seed.length !== FOLLOW_SEED_BYTES) throw new RangeError('A follow seed is 32 bytes.');
  return {
    mailbox: base64url(hkdf32(seed, FOLLOW_MAILBOX_INFO)),
    key: hkdf32(seed, FOLLOW_KEY_INFO),
  };
}
