/**
 * Recovering with contacts (#118; ADR-0043 §2, ADR-0008, ADR-0075 §4): the
 * code a new device shows, the number read out on a call, the mailbox the
 * shares come back through, and the two boxes that carry the rest.
 *
 * - **The code.** The new device makes a 16-byte seed `r` and an X25519 key
 *   `E_R`, and shows `RR1.` and the unpadded base64url of `r ‖ E_R`: 68
 *   characters. The person sends it to their contacts by any means.
 * - **The check.** Beside the code it shows six digits,
 *   `u32be(SHA-256("reconcile/v1/recovery-check" ‖ 0x00 ‖ code)[0..4]) mod
 *   10^6` (`sixDigits.ts`, #96's reduction), which the person reads out on a
 *   call or in person. A contact's device computes the same from the code it
 *   was sent, so a code swapped on the way, by a chat app or anyone else,
 *   shows another number, and the contact stops.
 * - **The mailbox.** Its id is the unpadded base64url of `HKDF(r, empty
 *   salt, "reconcile/v1/recovery-mailbox", 32)`, and every blob in it is
 *   sealed (`seal.ts`) under `HKDF(r, empty salt, "reconcile/v1/recovery-seal",
 *   32)`, so the relay sees one padded blob per contact under an id it can
 *   tie to nothing.
 * - **The second number** (#398). Beside the check, the new device shows six
 *   more digits, `u32be(HKDF(E_R's secret key, empty salt,
 *   "reconcile/v1/recovery-number", 32)[0..4]) mod 10^6`, which the person
 *   reads out on the same call. They come from the secret key, which never
 *   leaves the device, so nobody holding only the code can work them out.
 *   Each contact types them, and their device seals them inside the release.
 * - **The release.** Inside each blob is a box (`box.ts`) to `E_R` under
 *   `reconcile/v1/recovery-release`, with the mailbox id as associated data,
 *   holding the UTF-8 JSON `{v: 2, split, t, n, share, number}`: the share
 *   as `shares.ts` writes it, and the second number the contact typed. Only
 *   the new device, which alone holds `E_R`'s secret, opens it, and it takes
 *   a share only when the number is its own (`recovery/request.ts`). A
 *   release from before #398 has no `v` and no number, and opens to nothing.
 * - **The alert.** When a contact approves, their device posts a box to the
 *   person's encryption key in the share's group under
 *   `reconcile/v1/recovery-alert`, with the group id ‖ the person's key as
 *   associated data, holding `{v: 1, split, tag}`. `tag` is 16 random bytes:
 *   the person's devices name the alert by it when they cancel, so a cancel
 *   tells nobody else which alert it answers.
 *
 * `vectors/recovery.json` pins the code, the check, the second number, the
 * mailbox, a release of each format and an alert, computed outside @noble.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url, canonicalBytes, fromBase64url } from './base64url';
import { isUsableKxKey, KX_KEY_BYTES, kxPublicKeyOf, newKxKey, openBox, sealTo } from './box';
import { hkdf32 } from './hkdf';
import { objectIn } from './json';
import { decodeShare, encodeShare, isSplitId, type RecoveryShare } from './shares';
import { sixDigits } from './sixDigits';

/** What every recovery code starts with: the format's name and version. */
export const RECOVERY_CODE_PREFIX = 'RR1.';

/** A recovery seed's length in bytes. */
export const RECOVERY_SEED_BYTES = 16;

/** The tag the check number hashes ahead of the code. */
export const RECOVERY_CHECK_TAG = 'reconcile/v1/recovery-check';

/** The HKDF label of the request mailbox's id. */
export const RECOVERY_MAILBOX_INFO = 'reconcile/v1/recovery-mailbox';

/** The HKDF label of the key the request mailbox's blobs are sealed under. */
export const RECOVERY_SEAL_INFO = 'reconcile/v1/recovery-seal';

/** The HKDF label of a release's box. */
export const RECOVERY_RELEASE_INFO = 'reconcile/v1/recovery-release';

/** The HKDF label of the second number (#398). */
export const RECOVERY_NUMBER_INFO = 'reconcile/v1/recovery-number';

/** The release plaintext version this file seals and opens (#398): the first had no `v`. */
const RELEASE_VERSION = 2;

/** A second number as a release carries it: exactly six ASCII digits. */
const SIX_DIGITS = /^[0-9]{6}$/;

/** The HKDF label of an alert's box. */
export const RECOVERY_ALERT_INFO = 'reconcile/v1/recovery-alert';

/** An alert's tag's length in bytes. */
export const ALERT_TAG_BYTES = 16;

/** The one alert plaintext version this file seals and opens. */
const ALERT_VERSION = 1;

/** A code's body, wherever it sits in pasted text: 48 bytes in 64 base64url characters. */
const CODE = /RR1\.([A-Za-z0-9_-]{64})(?![A-Za-z0-9_-])/;

/** The bytes the check number hashes ahead of the code: its tag, then a zero byte. */
const CHECK_PREFIX = concatBytes(utf8ToBytes(RECOVERY_CHECK_TAG), new Uint8Array(1));

/** What a code carries: the seed, and the new device's X25519 public key. */
export interface RecoveryCodeParts {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** A code read from text: its parts, and the code itself as the new device wrote it. */
export interface ParsedRecoveryCode extends RecoveryCodeParts {
  readonly code: string;
}

/** The new device's side of a request: the seed and its one X25519 keypair. */
export interface RecoveryKeys extends RecoveryCodeParts {
  readonly secretKey: Uint8Array;
}

/** The request mailbox and the key its blobs are sealed under. */
export interface RecoveryChannel {
  readonly mailbox: string;
  readonly key: Uint8Array<ArrayBuffer>;
}

/** What an alert says to the person: the split being recovered, and the tag a cancel names. */
export interface RecoveryAlert {
  readonly split: string;
  readonly tag: string;
}

/** Where an alert's box belongs: the share's group, and the person it was posted for. */
export interface AlertPlace {
  readonly groupId: string;
  /** The person's key in the group, as events name members. */
  readonly person: string;
}

/** A fresh request: a 16-byte seed and an X25519 keypair from the platform's CSPRNG. */
export function newRecoveryKeys(): RecoveryKeys {
  const secretKey = newKxKey();
  return {
    seed: Uint8Array.from(randomBytes(RECOVERY_SEED_BYTES)),
    secretKey,
    publicKey: kxPublicKeyOf(secretKey),
  };
}

/** The code for `parts`: `RR1.` and the unpadded base64url of the seed ‖ the public key. */
export function recoveryCode({ seed, publicKey }: RecoveryCodeParts): string {
  return RECOVERY_CODE_PREFIX + base64url(concatBytes(seed, publicKey));
}

/**
 * The first recovery code in `text`, wherever it sits in what was pasted, or
 * null when there is none or its key is one no box can be sealed to.
 */
export function parseRecoveryCode(text: string): ParsedRecoveryCode | null {
  const body = CODE.exec(text)?.[1];
  if (body === undefined) return null;
  const bytes = fromBase64url(body);
  const seed = bytes.slice(0, RECOVERY_SEED_BYTES);
  const publicKey = bytes.slice(RECOVERY_SEED_BYTES, RECOVERY_SEED_BYTES + KX_KEY_BYTES);
  return isUsableKxKey(publicKey) ? { seed, publicKey, code: RECOVERY_CODE_PREFIX + body } : null;
}

/** The six digits read out on the call for `code`, as the new device writes it. */
export function recoveryCheck(code: string): string {
  const digest = sha256(concatBytes(CHECK_PREFIX, utf8ToBytes(code)));
  return sixDigits(digest.subarray(0, 4));
}

/**
 * The second number (#398) the new device shows beside the check, from its
 * X25519 `secretKey`: six digits, the same for the request's whole life.
 */
export function recoveryNumber(secretKey: Uint8Array): string {
  const derived = hkdf32(secretKey, RECOVERY_NUMBER_INFO);
  try {
    return sixDigits(derived.subarray(0, 4));
  } finally {
    derived.fill(0);
  }
}

/** The request mailbox's id and seal key, both derived from the seed alone. */
export function recoveryChannel(seed: Uint8Array): RecoveryChannel {
  return {
    mailbox: base64url(hkdf32(seed, RECOVERY_MAILBOX_INFO)),
    key: hkdf32(seed, RECOVERY_SEAL_INFO),
  };
}

/**
 * `share` and the second `number` the contact typed, sealed to the new
 * device's `publicKey` for `mailbox` (#398): the box a contact's device puts,
 * sealed again under the mailbox's key, in the request mailbox.
 *
 * @throws {RangeError} when the share isn't well shaped, the number isn't six
 *   digits, or the key can't take a box.
 */
export function sealRelease(
  publicKey: Uint8Array,
  mailbox: string,
  share: RecoveryShare,
  number: string,
): Uint8Array<ArrayBuffer> {
  if (!SIX_DIGITS.test(number)) throw new RangeError('A second number is six digits.');
  // Checks the share, and gives its fields as a release writes them.
  const fields = encodeShare(share);
  const shape = objectIn(fields) ?? {};
  fields.fill(0);
  const body = { v: RELEASE_VERSION, ...shape, number };
  const plaintext = utf8ToBytes(JSON.stringify(body));
  try {
    return sealTo(publicKey, plaintext, RECOVERY_RELEASE_INFO, utf8ToBytes(mailbox));
  } finally {
    plaintext.fill(0);
  }
}

/**
 * The share and second number in a release `box` for the holder of
 * `secretKey`, or null when it doesn't open for this mailbox (another key,
 * mailbox or any changed byte) or opens to anything but version 2: a
 * well-shaped share and six digits. Whether the number is the device's own is
 * the caller's to check (`recovery/request.ts`).
 */
export function openRelease(
  secretKey: Uint8Array,
  mailbox: string,
  box: Uint8Array,
): Release | null {
  const plaintext = openBox(secretKey, box, RECOVERY_RELEASE_INFO, utf8ToBytes(mailbox));
  if (plaintext === null) return null;
  try {
    const body = objectIn(plaintext);
    const { number } = body ?? {};
    if (body?.v !== RELEASE_VERSION || typeof number !== 'string' || !SIX_DIGITS.test(number)) {
      return null;
    }
    const share = decodeShare(plaintext);
    return share === null ? null : { share, number };
  } finally {
    plaintext.fill(0);
  }
}

/** A fresh alert tag: 16 random bytes in unpadded base64url, 22 characters. */
export function newAlertTag(): string {
  return base64url(randomBytes(ALERT_TAG_BYTES));
}

/** Whether `tag` is 16 bytes in canonical unpadded base64url. */
function isAlertTag(tag: unknown): tag is string {
  return canonicalBytes(tag)?.length === ALERT_TAG_BYTES;
}

/** What a release opens to (#398): the share, and the second number the contact typed. */
export interface Release {
  readonly share: RecoveryShare;
  readonly number: string;
}

/** An alert's associated data: the group id ‖ the person's key, in UTF-8. */
function alertAad({ groupId, person }: AlertPlace): Uint8Array {
  return concatBytes(utf8ToBytes(groupId), utf8ToBytes(person));
}

/**
 * `alert` sealed to the person's encryption key `kx` at `place`, as the
 * unpadded base64url a `recovery-alert` event carries.
 *
 * @throws {RangeError} when the split or tag isn't 16 bytes, or `kx` can't take a box.
 */
export function sealAlert(place: AlertPlace & { readonly kx: Uint8Array }, alert: RecoveryAlert) {
  if (!isSplitId(alert.split) || !isAlertTag(alert.tag)) {
    throw new RangeError('That isn’t a recovery alert.');
  }
  const body = { v: ALERT_VERSION, split: alert.split, tag: alert.tag };
  return base64url(
    sealTo(place.kx, utf8ToBytes(JSON.stringify(body)), RECOVERY_ALERT_INFO, alertAad(place)),
  );
}

/**
 * The alert in `box` for the holder of the person's X25519 secret key
 * `kxKey` at `place`, or null when it doesn't open there (another person or
 * group, or any changed byte) or opens to anything but a version-1 alert.
 */
export function openAlert(
  place: AlertPlace & { readonly kxKey: Uint8Array; readonly box: string },
): RecoveryAlert | null {
  const box = canonicalBytes(place.box);
  if (box === null) return null;
  const plaintext = openBox(place.kxKey, box, RECOVERY_ALERT_INFO, alertAad(place));
  if (plaintext === null) return null;
  const body = objectIn(plaintext);
  plaintext.fill(0);
  if (body?.v !== ALERT_VERSION || !isSplitId(body.split) || !isAlertTag(body.tag)) return null;
  return { split: body.split, tag: body.tag };
}
