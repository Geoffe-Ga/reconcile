/**
 * Ed25519 signatures (spec §3, "Records"): the only Ed25519 call site in the app.
 *
 * Every signature covers a context tag's UTF-8, one 0x00 byte, then the
 * message, so a signature made for one purpose can never pass as another:
 * an event's signature is no invite token's (#73), and neither is a shared
 * Document's copy (#105) nor a front door's page (#121). Verification is strict
 * RFC 8032, `zip215: false`, never the library's default, which accepts
 * non-canonical point encodings and small-order keys: a small-order key has
 * "signatures" that hold for every message, and devices that disagreed on
 * encodings would fold different groups.
 *
 * Each group membership has its own keys (ADR-0009, as ADR-0073 cut it):
 * independent random keypairs, with no root identity behind them. The secret
 * key never leaves the device; the public key travels only in the group's log.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** The tag on an event's signature. */
export const EVENT_CONTEXT = 'reconcile/v1/event';

/** The tag on an invite token: an inviter's signature over the group id (#73). */
export const INVITE_TOKEN_CONTEXT = 'reconcile/v1/invite-token';

/** The tag on a shared personal Document's copy (#105): its owner's signature over the copy. */
export const SHARE_CONTEXT = 'reconcile/v1/share';

/** The tag on a front door's page (#121): the door's own signature over the page. */
export const DOOR_PAGE_CONTEXT = 'reconcile/v1/door-page';

/** What a signature is for. */
export type SignContext =
  | typeof EVENT_CONTEXT
  | typeof INVITE_TOKEN_CONTEXT
  | typeof SHARE_CONTEXT
  | typeof DOOR_PAGE_CONTEXT;

/** An Ed25519 public key's length in bytes. */
export const PUBLIC_KEY_BYTES = 32;

/** An Ed25519 secret key's length in bytes: the RFC 8032 seed. */
export const SECRET_KEY_BYTES = 32;

/** An Ed25519 signature's length in bytes. */
export const SIGNATURE_BYTES = 64;

/** The byte between the context tag and the message. */
const SEPARATOR = Uint8Array.of(0);

/** One membership's keypair. */
export interface SigningKeys {
  /** The 32-byte public key: an event's `author`, in base64url. */
  readonly publicKey: Uint8Array;
  /** The 32-byte secret key. It stays on this device, with this group's records only. */
  readonly secretKey: Uint8Array;
}

/** A fresh keypair from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newSigningKeys(): SigningKeys {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

/** The public key that belongs to a 32-byte secret key. */
export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

/** What a signature under `ctx` covers: the tag's UTF-8, 0x00, then `msg`. */
function tagged(ctx: SignContext, msg: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(ctx), SEPARATOR, msg);
}

/** Signs `msg` for the purpose `ctx`: a 64-byte RFC 8032 signature, the same every time. */
export function sign(ctx: SignContext, secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(tagged(ctx, msg), secretKey);
}

/**
 * Whether `sig` is `publicKey`'s signature over `msg` for the purpose `ctx`,
 * under strict RFC 8032 rules. A key or signature of the wrong length is
 * refused, not thrown on.
 */
export function verify(
  ctx: SignContext,
  publicKey: Uint8Array,
  sig: Uint8Array,
  msg: Uint8Array,
): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES || sig.length !== SIGNATURE_BYTES) return false;
  return ed25519.verify(sig, tagged(ctx, msg), publicKey, { zip215: false });
}
