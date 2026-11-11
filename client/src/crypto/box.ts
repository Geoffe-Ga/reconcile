/**
 * Boxes sealed to one member's encryption key (#98; ADR-0009, ADR-0074).
 *
 * Each membership has an X25519 keypair beside its signing key: random, made
 * for that group alone and never reused in another (ADR-0009). Its public half
 * travels in the group's log as the member's `kx`; its secret half stays with
 * the group's record on the device, and in the backup file.
 *
 * A box is sealed to a public key with a fresh ephemeral key, so only the
 * holder of the matching secret key can open it:
 *
 * ```
 * dh  = X25519(ephemeral secret, recipient public key)   refused when all zeros
 * k   = HKDF-SHA-256(dh, salt = ephPub ‖ recipient public key, info, 32 bytes)
 * box = ephPub (32) ‖ nonce (24) ‖ XChaCha20-Poly1305(k, nonce, aad)(plaintext) ‖ tag (16)
 * ```
 *
 * `info` names what the box is for, and `aad` binds it to where it belongs, so
 * a box read for any other purpose or place never opens. `openBox` answers
 * `null` for every failure alike. A key change's wraps (`epoch.ts`) are boxes,
 * and #109's recovery shares will be too. `vectors/box.json` pins the format
 * with a box sealed outside @noble.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';

import { hkdf32 } from './hkdf';

/** An X25519 key's length in bytes, secret or public. */
export const KX_KEY_BYTES = 32;

/** XChaCha20's nonce length in bytes. */
const NONCE_BYTES = 24;

/** Poly1305's tag length in bytes. */
const TAG_BYTES = 16;

/** Everything in a box beside its plaintext: the ephemeral public key, the nonce and the tag. */
export const BOX_OVERHEAD = KX_KEY_BYTES + NONCE_BYTES + TAG_BYTES;

/** The scalar {@link isUsableKxKey} multiplies by: any will do, since @noble refuses a low-order key first. */
const PROBE = new Uint8Array(KX_KEY_BYTES).fill(0x42);

/** The public keys {@link isUsableKxKey} has passed in this page's life, by their hex. */
const usable = new Set<string>();

/** A new X25519 secret key: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newKxKey(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(x25519.utils.randomSecretKey());
}

/** The X25519 public key of a 32-byte secret key. */
export function kxPublicKeyOf(secretKey: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(x25519.getPublicKey(secretKey));
}

/**
 * The X25519 shared secret of `secretKey` and `publicKey`, or null for keys of
 * the wrong length or a public key of low order. @noble refuses those before
 * its ladder runs; the all-zeros check is RFC 7748 §6.1's, kept in case it
 * ever doesn't.
 */
function sharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  let dh: Uint8Array;
  try {
    dh = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    return null;
  }
  return dh.some((byte) => byte !== 0) ? dh : null;
}

/**
 * Whether a box can be sealed to `publicKey`: 32 bytes, and not of low order.
 * A member's `kx` counts only when it is (#98), so nobody can post a key no box
 * can be sealed to and so stop the group's key from ever changing.
 */
export function isUsableKxKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== KX_KEY_BYTES) return false;
  const hex = Array.from(publicKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (usable.has(hex)) return true;
  const dh = sharedSecret(PROBE, publicKey);
  if (dh === null) return false;
  dh.fill(0);
  usable.add(hex);
  return true;
}

/** The box key for one exchange: HKDF of the shared secret, salted with both public keys. */
function boxKey(dh: Uint8Array, ephemeralPublic: Uint8Array, publicKey: Uint8Array, info: string) {
  return hkdf32(dh, info, concatBytes(ephemeralPublic, publicKey));
}

/**
 * Seals `plaintext` to the X25519 `publicKey`: a fresh ephemeral key and
 * nonce, the key from HKDF over their exchange under `info`, and
 * XChaCha20-Poly1305 with `aad` as associated data.
 *
 * @throws {RangeError} when `publicKey` isn't 32 bytes or is of low order.
 */
export function sealTo(
  publicKey: Uint8Array,
  plaintext: Uint8Array,
  info: string,
  aad: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const ephemeral = newKxKey();
  const dh = sharedSecret(ephemeral, publicKey);
  if (dh === null) {
    ephemeral.fill(0);
    throw new RangeError('A box can’t be sealed to that key.');
  }
  const ephemeralPublic = kxPublicKeyOf(ephemeral);
  ephemeral.fill(0);
  const key = boxKey(dh, ephemeralPublic, publicKey, info);
  dh.fill(0);
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return Uint8Array.from(concatBytes(ephemeralPublic, nonce, sealed));
  } finally {
    key.fill(0);
  }
}

/**
 * The plaintext in `box` for the holder of `secretKey`, under `info` and
 * `aad`, or `null` when it doesn't open: a box too short, another key, info or
 * AAD, any changed byte, or keys of the wrong length.
 */
export function openBox(
  secretKey: Uint8Array,
  box: Uint8Array,
  info: string,
  aad: Uint8Array,
): Uint8Array | null {
  if (box.length < BOX_OVERHEAD || secretKey.length !== KX_KEY_BYTES) return null;
  const ephemeralPublic = box.subarray(0, KX_KEY_BYTES);
  const nonce = box.subarray(KX_KEY_BYTES, KX_KEY_BYTES + NONCE_BYTES);
  const dh = sharedSecret(secretKey, ephemeralPublic);
  if (dh === null) return null;
  const key = boxKey(dh, ephemeralPublic, x25519.getPublicKey(secretKey), info);
  dh.fill(0);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(box.subarray(KX_KEY_BYTES + NONCE_BYTES));
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}
