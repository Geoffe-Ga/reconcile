/**
 * The backup file's seal (spec §3 "Backup file"; #78; ADR-0043 and ADR-0044
 * as cut by ADR-0073).
 *
 * One file holds every group's keys, secret and log, so it is the most
 * sensitive thing the app makes. It is sealed under a key derived from a
 * passphrase only its owner knows, and nothing in it is readable without one:
 *
 * ```
 * offset  bytes  field
 * 0       4      magic "RCB1"
 * 4       1      log2 N (17)
 * 5       1      r (8)
 * 6       1      p (1)
 * 7       16     salt
 * 23      24     nonce
 * 47      …      XChaCha20-Poly1305 ciphertext ‖ 16-byte tag; AAD = bytes 0–46
 * ```
 *
 * The key is scrypt (RFC 7914) over the passphrase's NFC form as UTF-8, with
 * a random salt, from `@noble/hashes`; the seal is `@noble/ciphers`'
 * XChaCha20-Poly1305 under a random nonce. The whole header is associated
 * data, so changing any byte of it fails the tag as surely as changing the
 * body does. `vectors/backup.json` pins the format with a file sealed outside
 * @noble, so a backup saved today opens tomorrow.
 *
 * `openBackup` refuses everything alike, with {@link BackupUnreadable}: a
 * wrong passphrase, a damaged file, or a header this version doesn't write.
 * It refuses a cost above log2 N 20 before deriving anything, so a crafted
 * file can't make a device spend a gigabyte and many seconds on it. A header
 * it refuses fails at once rather than after a derivation, which tells the
 * person holding the file only what they could read from its first bytes.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** The file's first four bytes. */
const MAGIC = utf8ToBytes('RCB1');

/** scrypt's cost for every new backup, as log2 N: N = 2^17, about 128 MiB and a second. */
export const BACKUP_LOG2_N = 17;

/** The highest cost a backup may ask for: log2 N 20, 1 GiB. */
export const MAX_LOG2_N = 20;

/** scrypt's block size and parallelism, the only ones this version writes or reads. */
const R = 8;
const P = 1;

const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Where each header field starts. */
const LOG2_N_AT = 4;
const R_AT = 5;
const P_AT = 6;
const SALT_AT = 7;
const NONCE_AT = SALT_AT + SALT_BYTES;

/** The header: magic, cost, salt and nonce, 47 bytes, all of it associated data. */
export const BACKUP_HEADER_BYTES = NONCE_AT + NONCE_BYTES;

/**
 * The one way a backup fails to open: a wrong passphrase, a damaged file and
 * a header this version doesn't write all read the same.
 */
export class BackupUnreadable extends Error {
  /** Refuse a backup, saying nothing of why. */
  constructor() {
    super('This backup doesn’t open with that passphrase, or the file is damaged.');
    this.name = 'BackupUnreadable';
  }
}

/** Whether `log2N` is a cost this version derives with: a whole number from 1 to 20. */
function isCost(log2N: number): boolean {
  return Number.isInteger(log2N) && log2N >= 1 && log2N <= MAX_LOG2_N;
}

/** The 32-byte key for `passphrase` under `salt` at cost `log2N`. */
function deriveKey(passphrase: string, salt: Uint8Array, log2N: number): Promise<Uint8Array> {
  const secret = utf8ToBytes(passphrase.normalize('NFC'));
  return scryptAsync(secret, salt, { N: 2 ** log2N, r: R, p: P, dkLen: KEY_BYTES }).finally(() => {
    secret.fill(0);
  });
}

/**
 * Seals `plaintext` under `passphrase`: a fresh salt and nonce, the key from
 * scrypt at `log2N` (17 unless a test asks for less), and XChaCha20-Poly1305
 * with the header as associated data.
 *
 * @throws {RangeError} when `log2N` isn't a whole number from 1 to 20.
 */
export async function sealBackup(
  plaintext: Uint8Array,
  passphrase: string,
  log2N = BACKUP_LOG2_N,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isCost(log2N)) {
    throw new RangeError('A backup’s log2 N is a whole number from 1 to 20.');
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = concatBytes(MAGIC, Uint8Array.of(log2N, R, P), salt, nonce);
  const key = await deriveKey(passphrase, salt, log2N);
  try {
    const sealed = xchacha20poly1305(key, nonce, header).encrypt(plaintext);
    return Uint8Array.from(concatBytes(header, sealed));
  } finally {
    key.fill(0);
  }
}

/** Whether `file` starts with a header this version writes, long enough to hold a tag. */
function readableHeader(file: Uint8Array): boolean {
  return (
    file.length >= BACKUP_HEADER_BYTES + TAG_BYTES &&
    MAGIC.every((byte, i) => file[i] === byte) &&
    isCost(file[LOG2_N_AT] ?? 0) &&
    file[R_AT] === R &&
    file[P_AT] === P
  );
}

/**
 * The plaintext sealed in `file` under `passphrase`.
 *
 * @throws {BackupUnreadable} for a wrong passphrase, any changed byte, a cut
 *   file, another magic, or a cost or block size this version doesn't read.
 */
export async function openBackup(file: Uint8Array, passphrase: string): Promise<Uint8Array> {
  if (!readableHeader(file)) throw new BackupUnreadable();
  const header = file.subarray(0, BACKUP_HEADER_BYTES);
  const salt = file.subarray(SALT_AT, NONCE_AT);
  const nonce = file.subarray(NONCE_AT, BACKUP_HEADER_BYTES);
  const key = await deriveKey(passphrase, salt, file[LOG2_N_AT] ?? 0);
  try {
    return xchacha20poly1305(key, nonce, header).decrypt(file.subarray(BACKUP_HEADER_BYTES));
  } catch {
    throw new BackupUnreadable();
  } finally {
    key.fill(0);
  }
}
