/**
 * Linking a second device (#96; spec §3 "Second device"; ADR-0044 as cut by
 * ADR-0074): the code, the pairing channel, the handshake's shared secret,
 * and the confirmation number and key both devices derive from it.
 *
 * The existing device (A) makes a 32-byte seed `s` and a one-time X25519
 * keypair `e_A`. Its code is `RL1.` and the unpadded base64url of `s ‖
 * SHA-256(E_A)`: a commitment to its public key, not the key, so whoever
 * sees the code (over a shoulder, or pasted through a chat) can't work out
 * the number before the new device (B) has posted its own key, and gets one
 * guess in a million at it. The pairing mailbox id and seal key derive from
 * `s`, so the relay sees a mailbox id and nothing else.
 *
 * Both devices compute `ikm = X25519(e, E_other)` and `T = "reconcile/v1/link"
 * ‖ s ‖ E_A ‖ E_B`, then the number (`HKDF(ikm, SHA-256(T),
 * "reconcile/v1/link-number", 4)` as six digits) and the key `K` the bundle is
 * sealed under (`HKDF(ikm, SHA-256(T), "reconcile/v1/link-key", 32)`). The
 * bundle's mailbox derives from K, so only the two devices can name it.
 * `vectors/link.json` pins every step, computed outside @noble.
 *
 * Everything here is pure: `src/link/session.ts` does the relay's PUTs and GETs.
 */
import { equalBytes } from '@noble/ciphers/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, fromBase64url } from './base64url';
import { hkdf32, hkdfSalted } from './hkdf';
import { sixDigits } from './sixDigits';

/** A link seed's length in bytes. */
export const LINK_SEED_BYTES = 32;

/** An X25519 key's length in bytes, and SHA-256's. */
const KEY_BYTES = 32;

/** What every link code starts with: the format's name and version. */
export const LINK_CODE_PREFIX = 'RL1.';

/** The HKDF label of the pairing mailbox id. */
export const LINK_PAIRING_MAILBOX_INFO = 'reconcile/v1/link-mailbox';

/** The HKDF label of the key the handshake's blobs are sealed under. */
export const LINK_PAIRING_KEY_INFO = 'reconcile/v1/link-seal';

/** The tag at the start of the transcript T. */
export const LINK_TRANSCRIPT_TAG = 'reconcile/v1/link';

/** The HKDF label of the confirmation number. */
export const LINK_NUMBER_INFO = 'reconcile/v1/link-number';

/** The HKDF label of K, the key the bundle is sealed under. */
export const LINK_KEY_INFO = 'reconcile/v1/link-key';

/** The HKDF label of the bundle's mailbox id, derived from K. */
export const LINK_BUNDLE_MAILBOX_INFO = 'reconcile/v1/link-bundle';

/** The code's body: 64 bytes in 86 unpadded base64url characters. */
const CODE_BODY = /^[A-Za-z0-9_-]{86}$/;

/** A mailbox and the key its blobs are sealed under. */
export interface LinkChannel {
  /** The mailbox id at the relay. */
  readonly mailbox: string;
  /** The 32-byte XChaCha20-Poly1305 key. */
  readonly key: Uint8Array;
}

/** A one-time X25519 keypair, used for one link and dropped. */
export interface LinkKeys {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** What a code holds: the seed, and the commitment to the existing device's key. */
export interface LinkCode {
  readonly seed: Uint8Array;
  readonly commitment: Uint8Array;
}

/** What both devices derive once they hold each other's keys. */
export interface LinkSecrets {
  /** The six digits both screens show. */
  readonly number: string;
  /** K: the key the bundle is sealed under. */
  readonly key: Uint8Array<ArrayBuffer>;
  /** Where the bundle goes, sealed under K. */
  readonly bundle: LinkChannel;
}

/**
 * Thrown when a key can't take part in a link: one of the wrong length, or a
 * low-order point, whose shared secret is all zeros. @noble refuses those
 * before it runs the ladder, so no exchange with them ever completes.
 */
export class LinkRefused extends Error {
  /** Refuse the other device's key. */
  constructor() {
    super('That key can’t take part in a link.');
    this.name = 'LinkRefused';
  }
}

/** A new link seed: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newLinkSeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(LINK_SEED_BYTES));
}

/** A fresh one-time X25519 keypair, from the platform's CSPRNG. */
export function newLinkKeys(): LinkKeys {
  return x25519.keygen();
}

/** `seed`, after checking it is 32 bytes. */
function checkSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== LINK_SEED_BYTES) throw new RangeError('A link seed is 32 bytes.');
  return seed;
}

/**
 * The code the existing device shows: `RL1.` and base64url(seed ‖ SHA-256(publicKey)).
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function linkCode(seed: Uint8Array, publicKey: Uint8Array): string {
  return LINK_CODE_PREFIX + base64url(concatBytes(checkSeed(seed), sha256(publicKey)));
}

/**
 * The seed and commitment in a scanned or pasted code, or null. Text around
 * it is trimmed; anything else (another prefix, length or alphabet, padding,
 * or a final character whose spare bits aren't zero) is no code.
 */
export function parseLinkCode(text: string): LinkCode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(LINK_CODE_PREFIX)) return null;
  const body = trimmed.slice(LINK_CODE_PREFIX.length);
  if (!CODE_BODY.test(body)) return null;
  const bytes = fromBase64url(body);
  // Re-encoding catches a final character whose spare bits aren't zero.
  if (base64url(bytes) !== body) return null;
  return { seed: bytes.slice(0, LINK_SEED_BYTES), commitment: bytes.slice(LINK_SEED_BYTES) };
}

/** Whether SHA-256(`publicKey`) is `commitment`: the key the code committed to. */
export function matchesCommitment(publicKey: Uint8Array, commitment: Uint8Array): boolean {
  return commitment.length === KEY_BYTES && equalBytes(sha256(publicKey), commitment);
}

/**
 * The pairing mailbox and the key the handshake's blobs are sealed under, both from `seed`.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function pairingChannelOf(seed: Uint8Array): LinkChannel {
  checkSeed(seed);
  return {
    mailbox: base64url(hkdf32(seed, LINK_PAIRING_MAILBOX_INFO)),
    key: hkdf32(seed, LINK_PAIRING_KEY_INFO),
  };
}

/**
 * X25519 of this device's one-time `secretKey` with the other device's `publicKey`.
 *
 * @throws {LinkRefused} for a key of the wrong length or a low-order point,
 *   whose result would be all zeros.
 */
export function sharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new LinkRefused();
  }
}

/** T = "reconcile/v1/link" ‖ seed ‖ E_A ‖ E_B. */
export function linkTranscript(
  seed: Uint8Array,
  publicA: Uint8Array,
  publicB: Uint8Array,
): Uint8Array {
  return concatBytes(utf8ToBytes(LINK_TRANSCRIPT_TAG), seed, publicA, publicB);
}

/** The six-digit number for `shared` and `transcript`. */
export function linkNumber(shared: Uint8Array, transcript: Uint8Array): string {
  return sixDigits(hkdfSalted(shared, sha256(transcript), LINK_NUMBER_INFO, 4));
}

/** The number, K and the bundle's channel for `shared` and `transcript`. */
export function linkSecrets(shared: Uint8Array, transcript: Uint8Array): LinkSecrets {
  const key = hkdfSalted(shared, sha256(transcript), LINK_KEY_INFO, KEY_BYTES);
  return {
    number: linkNumber(shared, transcript),
    key,
    bundle: { mailbox: base64url(hkdf32(key, LINK_BUNDLE_MAILBOX_INFO)), key },
  };
}
