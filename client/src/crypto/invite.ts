/**
 * An invite link's seed, what derives from it, and the inviter's token (spec
 * §3 "Invite seed", §7 "Joining with full history"; #73).
 *
 * Copy invite link makes 32 random bytes, the seed, which travels only after
 * `#` in the link. The invite mailbox id and the key its envelope is sealed
 * under derive from the seed through the same HKDF as a group secret's
 * (`hkdf.ts`), under labels of their own, so a seed names no group mailbox
 * and opens no group blob. The relay sees the invite mailbox id and nothing
 * else. `vectors/invite.json` pins both derivations and one token, computed
 * outside @noble.
 *
 * The token is the inviter's signature over the group id's UTF-8, under its
 * own tag, so it can never pass for an event's signature or the other way
 * round. A joiner carries it in their `join`, and the fold names the inviter
 * only when it verifies.
 */
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { hkdf32 } from './hkdf';
import { INVITE_TOKEN_CONTEXT, sign, verify } from './sign';

/** An invite seed's length in bytes. */
export const INVITE_SEED_BYTES = 32;

/** The HKDF label of an invite's mailbox id. */
export const INVITE_MAILBOX_INFO = 'reconcile/v1/invite-mailbox';

/** The HKDF label of the key an invite's envelope is sealed under. */
export const INVITE_KEY_INFO = 'reconcile/v1/invite-key';

/** Where an invite's envelope goes and the key it's sealed under, both derived from its seed. */
export interface InviteChannel {
  /** The invite mailbox id at the relay. */
  readonly mailbox: string;
  /** The XChaCha20-Poly1305 key the envelope's blobs are sealed under. */
  readonly key: Uint8Array;
}

/** A new invite seed: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newInviteSeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(INVITE_SEED_BYTES));
}

/** HKDF-SHA-256 of `seed` under `info`, after checking the seed's length. */
function derive(seed: Uint8Array, info: string): Uint8Array<ArrayBuffer> {
  if (seed.length !== INVITE_SEED_BYTES) {
    throw new RangeError('An invite seed is 32 bytes.');
  }
  return hkdf32(seed, info);
}

/**
 * The invite's mailbox id at the relay: its 43 unpadded base64url characters.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function deriveInviteMailboxId(seed: Uint8Array): string {
  return base64url(derive(seed, INVITE_MAILBOX_INFO));
}

/**
 * The 32-byte key the invite's envelope is sealed under.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function deriveInviteKey(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  return derive(seed, INVITE_KEY_INFO);
}

/**
 * The invite mailbox id and key that `seed` derives.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function inviteChannelOf(seed: Uint8Array): InviteChannel {
  return { mailbox: deriveInviteMailboxId(seed), key: deriveInviteKey(seed) };
}

/** The inviter's 64-byte token for group `groupId`: their signature over its UTF-8, under the token tag. */
export function signInviteToken(secretKey: Uint8Array, groupId: string): Uint8Array {
  return sign(INVITE_TOKEN_CONTEXT, secretKey, utf8ToBytes(groupId));
}

/**
 * Whether `sig` is `publicKey`'s token for group `groupId`, under strict
 * RFC 8032 rules. A key or signature of the wrong length is refused, not
 * thrown on.
 */
export function verifyInviteToken(
  publicKey: Uint8Array,
  sig: Uint8Array,
  groupId: string,
): boolean {
  return verify(INVITE_TOKEN_CONTEXT, publicKey, sig, utf8ToBytes(groupId));
}
