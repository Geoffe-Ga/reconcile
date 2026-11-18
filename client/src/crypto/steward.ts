/**
 * The steward's keys (#488; ADR-0081; docs/spec/listed-doors.md §6.2).
 *
 * The steward, the platform's moderator (the founder during the pilot), has
 * two keys, as §6.2 says: an Ed25519 key that signs notices, and an X25519
 * key reports are sealed to (#489). Both derive from one 32-byte secret by
 * HKDF (`hkdf.ts`), each under a label of its own, so the steward imports
 * one secret on one device and the two public halves are what the app pins
 * (`shelf/steward.ts`) and the relay holds. `scripts/steward_key.py` makes
 * the secret offline the same way, and `vectors/steward.json`, computed
 * there, pins both.
 *
 * The secret never leaves the steward's device: Settings imports it, and the
 * store keeps it through `keepKeys`, in the passkey vault where there is one.
 */
import { canonicalBytes } from './base64url';
import { kxPublicKeyOf } from './box';
import { hkdf32 } from './hkdf';
import { publicKeyOf, type SigningKeys } from './sign';

/** The steward's secret's length in bytes. */
export const STEWARD_SECRET_BYTES = 32;

/** The HKDF label of the key that signs notices. */
export const STEWARD_SIGN_INFO = 'reconcile/v1/steward-sign';

/** The HKDF label of the key reports are sealed to (#489). */
export const STEWARD_BOX_INFO = 'reconcile/v1/steward-box';

/** An X25519 key pair. */
export interface BoxKeys {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** The steward's two key pairs. */
export interface StewardKeys {
  /** Signs notices: its public half is the relay's steward key. */
  readonly signing: SigningKeys;
  /** Opens reports (#489). */
  readonly box: BoxKeys;
}

/**
 * Both of the steward's key pairs from its 32-byte `secret`.
 *
 * @throws {RangeError} for a secret of any other length.
 */
export function stewardKeysOf(secret: Uint8Array): StewardKeys {
  if (secret.length !== STEWARD_SECRET_BYTES) {
    throw new RangeError('The steward’s secret is 32 bytes.');
  }
  const signSecret = hkdf32(secret, STEWARD_SIGN_INFO);
  const boxSecret = hkdf32(secret, STEWARD_BOX_INFO);
  return {
    signing: { secretKey: signSecret, publicKey: publicKeyOf(signSecret) },
    box: { secretKey: boxSecret, publicKey: kxPublicKeyOf(boxSecret) },
  };
}

/**
 * The secret `text` spells, as `scripts/steward_key.py` prints it: 32 bytes
 * in canonical unpadded base64url, spaces around it ignored; else null.
 */
export function stewardSecretFrom(text: string): Uint8Array<ArrayBuffer> | null {
  const bytes = canonicalBytes(text.trim());
  return bytes?.length === STEWARD_SECRET_BYTES ? bytes : null;
}
