/**
 * The link bundle (#96; spec §3 "Second device"): what the existing device
 * posts once the person confirms, and what the new device reads back.
 *
 * The bundle is a snapshot's plaintext (`store/snapshot.ts`, the same JSON a
 * backup file holds, without the passphrase layer), sealed under the link's
 * key K in the bundle mailbox that derives from K. It travels as a header
 * blob, JSON `{chunks, sha256}`, then `chunks` blobs of at most 65,492
 * bytes each, in order. The new device reads the header, waits until every
 * chunk is there, joins them, and checks the hash before it reads a byte of
 * them, so a chunk lost, repeated or reordered reads as damaged.
 *
 * Only the two devices hold K, but the relay, or anyone who saw the bundle
 * mailbox id in a request, could post junk there, so a blob that doesn't
 * open is skipped. Everything here is pure: the caller does the PUTs and GETs.
 */
import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import type { LinkChannel } from '../crypto/link';
import { MAX_PLAINTEXT_BYTES, type Seal } from '../crypto/seal';
import { MAX_BACKUP_BYTES } from '../store/snapshot';

/** The most chunks a bundle may have: enough for the largest snapshot a restore reads. */
export const MAX_BUNDLE_CHUNKS = Math.ceil(MAX_BACKUP_BYTES / MAX_PLAINTEXT_BYTES);

/** A SHA-256 digest in unpadded base64url: 43 characters. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/** What the new device found in the bundle mailbox. */
export type OpenedBundle =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'ready'; readonly plaintext: Uint8Array<ArrayBuffer> };

/** The header's two fields: how many chunks follow, and the whole plaintext's hash. */
interface Header {
  readonly chunks: number;
  readonly sha256: string;
}

const encoder = new TextEncoder();
// fatal: bytes that aren't UTF-8 throw, so they read as a damaged header.
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `plaintext` cut into slices of at most 65,492 bytes, in order: at least one. */
function chunksOf(plaintext: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < plaintext.length; at += MAX_PLAINTEXT_BYTES) {
    chunks.push(plaintext.subarray(at, at + MAX_PLAINTEXT_BYTES));
  }
  return chunks.length > 0 ? chunks : [plaintext];
}

/** The bundle's blobs, in the order they're posted: the header, then each chunk. */
export function sealBundle(
  seal: Seal,
  { mailbox, key }: LinkChannel,
  plaintext: Uint8Array,
): Uint8Array<ArrayBuffer>[] {
  const chunks = chunksOf(plaintext);
  const header: Header = { chunks: chunks.length, sha256: base64url(sha256(plaintext)) };
  const parts = [encoder.encode(JSON.stringify(header)), ...chunks];
  return parts.map((part) => seal.seal(mailbox, key, part));
}

/** The JSON object `bytes` spell in UTF-8, or null when they spell anything else. */
function objectIn(bytes: Uint8Array): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** Whether `value` is a whole number of chunks, from 1 to {@link MAX_BUNDLE_CHUNKS}. */
function isChunkCount(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_BUNDLE_CHUNKS
  );
}

/** The header in `bytes`, or null for anything that isn't exactly a well-formed one. */
function headerIn(bytes: Uint8Array): Header | null {
  const raw = objectIn(bytes);
  if (raw === null || !isChunkCount(raw.chunks)) return null;
  const digest = raw.sha256;
  return typeof digest === 'string' && DIGEST.test(digest)
    ? { chunks: raw.chunks, sha256: digest }
    : null;
}

/** `parts` joined end to end. */
function joined(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The bundle in `blobs`, the bundle mailbox's records in relay order: still
 * waiting while the header or any chunk it counts is missing, damaged when
 * the header doesn't parse or the joined chunks don't hash to it, and ready
 * otherwise. Blobs that don't open are skipped, and anything after the
 * counted chunks is ignored.
 */
export function openBundle(
  seal: Seal,
  { mailbox, key }: LinkChannel,
  blobs: readonly Uint8Array[],
): OpenedBundle {
  const parts = blobs.map((blob) => seal.open(mailbox, key, blob)).filter((part) => part !== null);
  const [first, ...rest] = parts;
  if (first === undefined) return { kind: 'waiting' };
  const header = headerIn(first);
  if (header === null) return { kind: 'damaged' };
  if (rest.length < header.chunks) return { kind: 'waiting' };
  const plaintext = joined(rest.slice(0, header.chunks));
  if (base64url(sha256(plaintext)) !== header.sha256) return { kind: 'damaged' };
  return { kind: 'ready', plaintext };
}
