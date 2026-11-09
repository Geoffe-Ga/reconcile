/**
 * The sealed blob every event travels in (ADR-0019, spec §3 "Seal").
 *
 * A blob is a nonce slot, then a body, then a tag slot. The body is a 4-byte
 * big-endian plaintext length, the plaintext, then zeros, so that the whole
 * blob is exactly one of four sizes and the relay learns nothing from it but
 * which size. The real seal (#71) encrypts the body with XChaCha20-Poly1305,
 * binding the mailbox id as associated data; the stub (`stubSeal.ts`) frames
 * and pads exactly the same way without encrypting.
 */

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
 * Seals plaintext for one mailbox, and opens what was sealed for it.
 *
 * #71's real seal keeps this shape: it binds `mailbox` as associated data, so
 * a blob copied into another mailbox fails to open.
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
