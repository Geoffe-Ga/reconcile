/**
 * The relay backup's key, id and seal (spec §3 "Relay backup"; #97;
 * ADR-0043 §3 as ADR-0074 and ADR-0075 §4 revised it).
 *
 * A device that keeps a relay backup holds one random 32-byte backup key,
 * device-wide and in no group. Everything the relay sees derives from it
 * with the app's one HKDF (`hkdf.ts`), each under a label of its own:
 *
 * - the backup's id, `reconcile/v1/backup-id`, in unpadded base64url: 43
 *   characters, as unrelated to any mailbox id as two HKDF labels make it;
 * - the seal key, `reconcile/v1/backup-seal`.
 *
 * A blob is exactly one of five sizes, so the relay learns only which:
 *
 * ```
 * offset  bytes  field
 * 0       4      magic "RCR1"
 * 4       24     nonce
 * 28      …      XChaCha20-Poly1305 of (4-byte big-endian length ‖ plaintext ‖ zeros) ‖ 16-byte tag
 *                AAD = "RCR1" ‖ UTF-8 of the backup id
 * ```
 *
 * `openRelayBackup` authenticates before it reads a byte of the body, and
 * answers `null` alike for a wrong size, magic, key or any changed byte, or a
 * frame that doesn't parse. `vectors/relayBackup.json` pins the derivations
 * and one blob, computed outside @noble, so a backup the relay holds today
 * opens on the device that recovers it later.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { hkdf32 } from './hkdf';
import { unframeBody } from './seal';

/** A backup key's length in bytes. */
export const BACKUP_KEY_BYTES = 32;

/** The HKDF label of a backup's id at the relay. */
export const BACKUP_ID_INFO = 'reconcile/v1/backup-id';

/** The HKDF label of the key a backup is sealed under. */
export const BACKUP_SEAL_INFO = 'reconcile/v1/backup-seal';

/** A backup blob's sizes in bytes, smallest first: 64 KiB, 256 KiB, 1 MiB, 4 MiB and 16 MiB. */
export const RELAY_BACKUP_SIZES = [65536, 262144, 1048576, 4194304, 16777216] as const;

/** One of {@link RELAY_BACKUP_SIZES}. */
export type RelayBackupSize = (typeof RELAY_BACKUP_SIZES)[number];

const MAGIC = utf8ToBytes('RCR1');
const NONCE_BYTES = 24;
const LENGTH_BYTES = 4;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;

/** Everything in a blob that isn't plaintext or padding: 48 bytes. */
const OVERHEAD = HEADER_BYTES + LENGTH_BYTES + TAG_BYTES;

/** The largest plaintext a relay backup carries: 16 MiB less 48 bytes. */
export const MAX_RELAY_BACKUP_PLAINTEXT = 16777216 - OVERHEAD;

/** Thrown when a plaintext is too large for even the largest backup. */
export class RelayBackupTooLarge extends Error {
  /** Refuse a plaintext of `size` bytes. */
  constructor(readonly size: number) {
    super(`A relay backup carries at most ${String(MAX_RELAY_BACKUP_PLAINTEXT)} bytes.`);
    this.name = 'RelayBackupTooLarge';
  }
}

/** A new backup key: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newBackupKey(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(BACKUP_KEY_BYTES));
}

/** HKDF-SHA-256 of `key` under `info`, after checking the key's length. */
function derive(key: Uint8Array, info: string): Uint8Array<ArrayBuffer> {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new RangeError('A backup key is 32 bytes.');
  }
  return hkdf32(key, info);
}

/**
 * The backup's id at the relay: the unpadded base64url of HKDF-SHA-256 of
 * `key` under `reconcile/v1/backup-id`, 43 characters.
 *
 * @throws {RangeError} when `key` isn't 32 bytes.
 */
export function backupIdFor(key: Uint8Array): string {
  return base64url(derive(key, BACKUP_ID_INFO));
}

/** The smallest backup size that holds a plaintext of `length` bytes, or null when none does. */
export function relayBackupSize(length: number): RelayBackupSize | null {
  return RELAY_BACKUP_SIZES.find((size) => length + OVERHEAD <= size) ?? null;
}

/** The associated data: the magic, then the id's UTF-8. */
function associatedData(id: string): Uint8Array {
  return concatBytes(MAGIC, utf8ToBytes(id));
}

/**
 * Seals `plaintext` under `key` into one blob of the smallest size that holds
 * it: the magic, a fresh random nonce, then XChaCha20-Poly1305 of the framed
 * body under the derived seal key, with the magic and the id as associated
 * data.
 *
 * @throws {RangeError} when `key` isn't 32 bytes.
 * @throws {RelayBackupTooLarge} when the plaintext is over
 *   {@link MAX_RELAY_BACKUP_PLAINTEXT} bytes.
 */
export function sealRelayBackup(key: Uint8Array, plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const id = backupIdFor(key);
  const size = relayBackupSize(plaintext.length);
  if (size === null) throw new RelayBackupTooLarge(plaintext.length);
  const body = new Uint8Array(size - HEADER_BYTES - TAG_BYTES);
  new DataView(body.buffer).setUint32(0, plaintext.length);
  body.set(plaintext, LENGTH_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const sealKey = derive(key, BACKUP_SEAL_INFO);
  try {
    const sealed = xchacha20poly1305(sealKey, nonce, associatedData(id)).encrypt(body);
    return Uint8Array.from(concatBytes(MAGIC, nonce, sealed));
  } finally {
    sealKey.fill(0);
    body.fill(0);
  }
}

/** Whether `blob` is one of the five sizes and starts with the magic. */
function isFramed(blob: Uint8Array): boolean {
  return (
    RELAY_BACKUP_SIZES.some((size) => size === blob.length) &&
    MAGIC.every((byte, i) => blob[i] === byte)
  );
}

/**
 * The plaintext sealed in `blob` under `key`, or `null` when the blob isn't
 * one of the five sizes, has another magic, fails authentication (another
 * key, any changed byte) or holds a frame that doesn't parse.
 *
 * @throws {RangeError} when `key` isn't 32 bytes.
 */
export function openRelayBackup(key: Uint8Array, blob: Uint8Array): Uint8Array | null {
  const id = backupIdFor(key);
  if (!isFramed(blob)) return null;
  const nonce = blob.subarray(MAGIC.length, HEADER_BYTES);
  const sealKey = derive(key, BACKUP_SEAL_INFO);
  let body: Uint8Array;
  try {
    body = xchacha20poly1305(sealKey, nonce, associatedData(id)).decrypt(
      blob.subarray(HEADER_BYTES),
    );
  } catch {
    return null;
  } finally {
    sealKey.fill(0);
  }
  const plaintext = unframeBody(body);
  body.fill(0);
  return plaintext;
}
