/**
 * The key vault's cryptography (#95; ADR-0008, ADR-0030): every secret on the
 * device, sealed under a key only the person's passkey can give back.
 *
 * Where a passkey supports WebAuthn's PRF extension, the authenticator turns
 * a 32-byte salt into 32 bytes of output that only that credential, after
 * user verification, can produce. The vault key derives from that output:
 *
 * ```
 * K      = HKDF-SHA-256(ikm = PRF output, salt = PRF salt, info = "reconcile/v1/key-vault", 32)
 * sealed = nonce (24) ‖ XChaCha20-Poly1305(K, nonce, AAD = "reconcile/v1/key-vault" ‖ credential id)
 * ```
 *
 * The credential id is associated data, so a vault never opens under another
 * passkey's id, and the label keeps the key and the seal apart from every
 * other derivation in the app. The PRF output never leaves the device and
 * derives only K; callers zero it once K is made. `vectors/keyVault.json`
 * pins the derivation and the seal with a vault sealed outside @noble, so a
 * vault sealed today opens tomorrow. `openVault` answers null for every
 * failure alike.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { hkdf32 } from './hkdf';

/** The HKDF label of the vault key, and the start of the seal's associated data. */
export const VAULT_INFO = 'reconcile/v1/key-vault';

/** A PRF output's length, its salt's, and the vault key's: 32 bytes each. */
export const PRF_BYTES = 32;

const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/** What sealing adds to the plaintext: the nonce before it and the tag after: 40 bytes. */
export const VAULT_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** A new PRF salt: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newPrfSalt(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(PRF_BYTES));
}

/**
 * The 32-byte vault key from a passkey's PRF output and the salt it was asked with.
 *
 * @throws {RangeError} when either isn't 32 bytes.
 */
export function vaultKeyFromPrf(prf: Uint8Array, prfSalt: Uint8Array): Uint8Array<ArrayBuffer> {
  if (prf.length !== PRF_BYTES || prfSalt.length !== PRF_BYTES) {
    throw new RangeError('A PRF output and its salt are 32 bytes each.');
  }
  return hkdf32(prf, VAULT_INFO, prfSalt);
}

/** The seal's associated data: the label, then the credential id. */
function associatedData(credentialId: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(VAULT_INFO), credentialId);
}

/**
 * Seals `plaintext` under the vault key for the passkey `credentialId`, under
 * a fresh random nonce: nonce ‖ ciphertext ‖ tag.
 *
 * @throws {RangeError} when `key` isn't 32 bytes.
 */
export function sealVault(
  key: Uint8Array,
  credentialId: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (key.length !== PRF_BYTES) throw new RangeError('A vault key is 32 bytes.');
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, associatedData(credentialId)).encrypt(plaintext);
  return Uint8Array.from(concatBytes(nonce, sealed));
}

/**
 * The plaintext `sealed` holds, or null when it doesn't open: another key or
 * credential id, any changed byte, or too few bytes to hold a nonce and tag.
 */
export function openVault(
  key: Uint8Array,
  credentialId: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | null {
  if (key.length !== PRF_BYTES || sealed.length < VAULT_OVERHEAD) return null;
  const nonce = sealed.subarray(0, NONCE_BYTES);
  try {
    return xchacha20poly1305(key, nonce, associatedData(credentialId)).decrypt(
      sealed.subarray(NONCE_BYTES),
    );
  } catch {
    return null;
  }
}
