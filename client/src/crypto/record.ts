/**
 * Records (spec §3, "Records"): what a device posts and keeps for each event.
 *
 * A record is the author's 32-byte public key, their 64-byte signature, then
 * the event's exact bytes. The signature covers those bytes under the event
 * context tag (`sign.ts`). Nothing reads an event until its record verifies,
 * so bytes a member didn't sign never reach the parser or claim an event id.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';

import {
  EVENT_CONTEXT,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  type SignContext,
  type SigningKeys,
  sign,
  verify,
} from './sign';

/** The bytes before a record's event: the public key, then the signature. */
export const RECORD_HEADER_BYTES = PUBLIC_KEY_BYTES + SIGNATURE_BYTES;

/**
 * The largest record a device queues: 64,000 bytes (spec §2), counted in
 * bytes, never characters. It sits below the 65,492 a blob carries so #73 can
 * put any record, with its seq and receipt time, in one invite chunk.
 */
export const MAX_RECORD_BYTES = 64_000;

/** Thrown when a record is over {@link MAX_RECORD_BYTES}. */
export class RecordTooLarge extends Error {
  /** The refused record's length in bytes. */
  readonly size: number;
  /** The largest record a device queues. */
  readonly limit = MAX_RECORD_BYTES;

  /** Refuse a record of `size` bytes. */
  constructor(size: number) {
    super(`A record is at most ${String(MAX_RECORD_BYTES)} bytes, not ${String(size)}.`);
    this.name = 'RecordTooLarge';
    this.size = size;
  }
}

/** A record whose signature verified. */
export interface VerifiedRecord {
  /** The key that signed it. */
  readonly publicKey: Uint8Array;
  /** The event's exact bytes, as signed. */
  readonly eventBytes: Uint8Array;
}

/**
 * The SHA-256 hex of every record that has verified in this page's life.
 *
 * A re-fold reads the same records again, and Ed25519 verification costs a
 * millisecond or more each, so a verdict is kept per record. Keying by a
 * collision-resistant hash of the whole record means only identical bytes
 * share a verdict. Only passes are kept, and the set holds one entry per
 * valid record the device has folded, a small fraction of the logs it
 * already holds in memory.
 */
const verified = new Set<string>();

/**
 * The record for `eventBytes`, signed with `keys`: public key ‖ signature ‖
 * event bytes. A public key that isn't the secret key's own makes a record
 * that never verifies.
 */
export function signRecord(keys: SigningKeys, eventBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const signature = sign(EVENT_CONTEXT, keys.secretKey, eventBytes);
  return Uint8Array.from(concatBytes(keys.publicKey, signature, eventBytes));
}

/**
 * A record framed as an event's is, signed under `ctx` instead: public key ‖
 * signature ‖ message. A shared Document's copy (#105) and a front door's
 * page (#121) travel this way, each under its own tag, so neither is ever an
 * event nor the other.
 */
export function signTagged(
  ctx: SignContext,
  keys: SigningKeys,
  message: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(concatBytes(keys.publicKey, sign(ctx, keys.secretKey, message), message));
}

/**
 * The message inside a {@link signTagged} record when its key is exactly
 * `publicKey` and its signature verifies under `ctx`; otherwise `null`, for
 * bytes too short to hold a key and a signature as for any other key or any
 * changed byte. The message comes back in bytes of its own.
 */
export function openTagged(
  ctx: SignContext,
  record: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array | null {
  if (record.length < RECORD_HEADER_BYTES || publicKey.length !== PUBLIC_KEY_BYTES) return null;
  const key = record.subarray(0, PUBLIC_KEY_BYTES);
  if (!key.every((byte, i) => byte === publicKey[i])) return null;
  const signature = record.subarray(PUBLIC_KEY_BYTES, RECORD_HEADER_BYTES);
  const message = record.subarray(RECORD_HEADER_BYTES);
  return verify(ctx, publicKey, signature, message) ? message.slice() : null;
}

/**
 * The key and event bytes of a record whose signature verifies, or `null` for
 * bytes too short to hold a key and a signature, or any signature that fails.
 */
export function verifyRecord(record: Uint8Array): VerifiedRecord | null {
  if (record.length < RECORD_HEADER_BYTES) return null;
  const publicKey = record.subarray(0, PUBLIC_KEY_BYTES);
  const signature = record.subarray(PUBLIC_KEY_BYTES, RECORD_HEADER_BYTES);
  const eventBytes = record.subarray(RECORD_HEADER_BYTES);
  const digest = bytesToHex(sha256(record));
  if (!verified.has(digest)) {
    if (!verify(EVENT_CONTEXT, publicKey, signature, eventBytes)) return null;
    verified.add(digest);
  }
  return { publicKey, eventBytes };
}
