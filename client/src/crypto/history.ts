/**
 * The Bedfellows history's seal (#480; ADR-0080 §5): what Bedfellows showed
 * and how the reader marked it, sealed under the device's vault key, in one
 * slot of a fixed size.
 *
 * ```
 * K      = HKDF-SHA-256(ikm = vault key, salt = empty, info = "reconcile/v1/bedfellows-history", 32)
 * body   = 4-byte big-endian length ‖ plaintext ‖ zeros, 65,496 bytes
 * sealed = nonce (24) ‖ XChaCha20-Poly1305(K, nonce, AAD = "reconcile/v1/bedfellows-history")(body) ‖ tag (16)
 * ```
 *
 * The sealed slot is always exactly 64 KiB, whatever it holds, so its size
 * tells a locked device's reader nothing: an empty history and a full one
 * look the same. The key derives from the vault key under a label of its
 * own, and the label is the associated data, so the slot never opens as the
 * key vault (`keyVault.ts`) and the vault never opens as the slot.
 * `openHistory` answers null for every failure alike.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { hkdf32 } from './hkdf';
import { unframeBody } from './seal';

/** The HKDF label of the history's key, and its seal's associated data. */
export const HISTORY_INFO = 'reconcile/v1/bedfellows-history';

/** A sealed history's size in bytes, always: 64 KiB. */
export const HISTORY_SEALED_BYTES = 65536;

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;

/** The framed body inside the seal. */
const BODY_BYTES = HISTORY_SEALED_BYTES - NONCE_BYTES - TAG_BYTES;

/** The longest plaintext the slot holds: 64 KiB less 44 bytes. */
export const MAX_HISTORY_PLAINTEXT = BODY_BYTES - LENGTH_BYTES;

/** The history's own key, from the vault key. */
function historyKey(vaultKey: Uint8Array): Uint8Array<ArrayBuffer> {
  return hkdf32(vaultKey, HISTORY_INFO);
}

/**
 * `plaintext` sealed under `vaultKey` in a slot of {@link HISTORY_SEALED_BYTES},
 * under a fresh random nonce.
 *
 * @throws {RangeError} when `vaultKey` isn't 32 bytes, or `plaintext` is
 *   longer than {@link MAX_HISTORY_PLAINTEXT}.
 */
export function sealHistory(vaultKey: Uint8Array, plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  if (vaultKey.length !== KEY_BYTES) throw new RangeError('A vault key is 32 bytes.');
  if (plaintext.length > MAX_HISTORY_PLAINTEXT) {
    throw new RangeError('The Bedfellows history is longer than its slot.');
  }
  const body = new Uint8Array(BODY_BYTES);
  new DataView(body.buffer).setUint32(0, plaintext.length);
  body.set(plaintext, LENGTH_BYTES);
  const key = historyKey(vaultKey);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const sealed = xchacha20poly1305(key, nonce, utf8ToBytes(HISTORY_INFO)).encrypt(body);
    return Uint8Array.from(concatBytes(nonce, sealed));
  } finally {
    key.fill(0);
    body.fill(0);
  }
}

/**
 * The plaintext a sealed history holds, or null when it doesn't open: another
 * key, any changed byte, any other length, or a body that doesn't unframe.
 */
export function openHistory(vaultKey: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (vaultKey.length !== KEY_BYTES || sealed.length !== HISTORY_SEALED_BYTES) return null;
  const key = historyKey(vaultKey);
  try {
    const body = xchacha20poly1305(
      key,
      sealed.subarray(0, NONCE_BYTES),
      utf8ToBytes(HISTORY_INFO),
    ).decrypt(sealed.subarray(NONCE_BYTES));
    const plaintext = unframeBody(body);
    body.fill(0);
    return plaintext;
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}
