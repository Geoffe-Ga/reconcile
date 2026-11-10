/**
 * The sealed blob every event travels in (ADR-0019, spec §3 "Seal").
 *
 * A blob is a 24-byte random nonce, then the XChaCha20-Poly1305 ciphertext of
 * a body, then its 16-byte tag. The body is a 4-byte big-endian payload
 * length, the payload, then zeros, so that the whole blob is exactly one of
 * four sizes and the relay learns nothing from it but which size. The
 * mailbox id is the associated data, so a blob copied into another mailbox
 * never opens. The author, the signature and every word of the event sit
 * inside the ciphertext.
 *
 * `open` authenticates before it reads a byte of the body, and answers `null`
 * for every failure alike, so a damaged or forged blob teaches its sender
 * nothing about why it failed.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** A blob's possible sizes in bytes: 1, 4, 16 and 64 KiB, smallest first. */
export const BLOB_SIZES = [1024, 4096, 16384, 65536] as const;

/** One of {@link BLOB_SIZES}. */
export type BlobSize = (typeof BLOB_SIZES)[number];

/** Bytes before the body: XChaCha20's 24-byte nonce. */
export const NONCE_BYTES = 24;

/** Bytes after the body: Poly1305's 16-byte tag. */
export const TAG_BYTES = 16;

/** Bytes at the start of the body that hold the plaintext's length. */
const LENGTH_BYTES = 4;

/** Everything in a blob that isn't plaintext or padding. */
const OVERHEAD = NONCE_BYTES + LENGTH_BYTES + TAG_BYTES;

/** The largest plaintext a blob can carry: 65,536 − 44 = 65,492 bytes. */
export const MAX_PLAINTEXT_BYTES = 65536 - OVERHEAD;

/**
 * Seals plaintext for one mailbox under a 32-byte key, and opens what was
 * sealed for it. {@link xchachaSeal} is the app's; tests also have a stub
 * that frames the same way without encrypting (`src/test/stubSeal.ts`).
 */
export interface Seal {
  /** Seal `plaintext` into a blob of exactly one of {@link BLOB_SIZES}. */
  seal(mailbox: string, key: Uint8Array, plaintext: Uint8Array): Uint8Array<ArrayBuffer>;
  /** The plaintext inside `blob`, or `null` when it doesn't open. */
  open(mailbox: string, key: Uint8Array, blob: Uint8Array): Uint8Array | null;
}

/** Thrown when a plaintext is too large for even the largest blob. */
export class PayloadTooLarge extends Error {
  /** The refused plaintext's length in bytes. */
  readonly size: number;
  /** The largest plaintext a blob can carry. */
  readonly limit = MAX_PLAINTEXT_BYTES;

  /** Refuse a plaintext of `size` bytes. */
  constructor(size: number) {
    super(`A blob carries at most ${String(MAX_PLAINTEXT_BYTES)} bytes, not ${String(size)}.`);
    this.name = 'PayloadTooLarge';
    this.size = size;
  }
}

/** Whether `length` is exactly one of {@link BLOB_SIZES}. */
export function isBlobSize(length: number): length is BlobSize {
  return BLOB_SIZES.some((size) => size === length);
}

/**
 * The size of the smallest blob that fits a plaintext of `plaintextLength`
 * bytes.
 *
 * @throws {PayloadTooLarge} when it is over {@link MAX_PLAINTEXT_BYTES}.
 */
export function bucketFor(plaintextLength: number): BlobSize {
  const size = BLOB_SIZES.find((candidate) => plaintextLength + OVERHEAD <= candidate);
  if (size === undefined) {
    throw new PayloadTooLarge(plaintextLength);
  }
  return size;
}

/**
 * The body for `plaintext`: its 4-byte big-endian length, the plaintext,
 * then zeros up to the bucket's size less the nonce and tag slots.
 *
 * @throws {PayloadTooLarge} when the plaintext is too large for any blob.
 */
export function frameBody(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(bucketFor(plaintext.length) - NONCE_BYTES - TAG_BYTES);
  new DataView(body.buffer).setUint32(0, plaintext.length);
  body.set(plaintext, LENGTH_BYTES);
  return body;
}

/**
 * The plaintext inside a framed `body`, or `null` when the length runs past
 * the body or the padding after the plaintext isn't all zeros.
 */
export function unframeBody(body: Uint8Array): Uint8Array | null {
  if (body.length < LENGTH_BYTES) {
    return null;
  }
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  const end = LENGTH_BYTES + length;
  if (end > body.length || !isZero(body.subarray(end))) {
    return null;
  }
  return body.slice(LENGTH_BYTES, end);
}

/** Whether every byte of `bytes` is zero. */
export function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

/**
 * Seals `plaintext` for `mailbox` under the 32-byte `key`: a fresh random
 * nonce, then XChaCha20-Poly1305 over the framed body with the mailbox id's
 * UTF-8 as associated data. A random 24-byte nonce never repeats in practice,
 * so no counter is kept.
 *
 * @throws {PayloadTooLarge} when the plaintext is too large for any blob.
 */
export function seal(
  mailbox: string,
  key: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const body = frameBody(plaintext);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, utf8ToBytes(mailbox)).encrypt(body);
  return Uint8Array.from(concatBytes(nonce, sealed));
}

/**
 * The plaintext sealed in `blob` for `mailbox` under `key`, or `null` when
 * the blob isn't one of the four sizes, fails authentication (another key,
 * another mailbox, any changed byte) or holds a frame that doesn't parse.
 */
export function open(mailbox: string, key: Uint8Array, blob: Uint8Array): Uint8Array | null {
  if (!isBlobSize(blob.length)) {
    return null;
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  let body: Uint8Array;
  try {
    body = xchacha20poly1305(key, nonce, utf8ToBytes(mailbox)).decrypt(blob.subarray(NONCE_BYTES));
  } catch {
    return null;
  }
  return unframeBody(body);
}

/** The real seal, as the {@link Seal} the sync loop and Join take. */
export const xchachaSeal: Seal = { seal, open };
