/**
 * The invite envelope (spec §7, "Joining with full history"; #73): what Copy
 * invite link posts to the invite mailbox, and what opening the link reads.
 *
 * An envelope is a header blob, then one blob per chunk, each sealed under the
 * invite key (`crypto/invite.ts`) with the `Seal` the group's own blobs use.
 *
 * - The header is JSON `{groupSecret, preview, token, chunkCount}`: the group
 *   secret in base64url, the preview a joiner sees before choosing a name
 *   (ADR-0052), the inviter's token, and how many chunks follow. Every preview
 *   field is cut to a limit, so the header always fits one small blob.
 * - Each chunk packs log entries, `seq (8 bytes) ‖ received (8) ‖ length (4) ‖
 *   record`, big-endian, up to the 65,492 bytes a blob carries. `received`
 *   travels with each record because vote deadlines run on it.
 *
 * Opening is all or nothing: an empty mailbox, a missing or extra blob, a blob
 * that won't open, or a header or chunk that doesn't parse all read as one
 * damaged invite, which teaches a sender nothing about why. Everything here is
 * pure: the caller does the relay's PUTs and GETs.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { GROUP_SECRET_BYTES } from '../crypto/groupKeys';
import type { InviteChannel } from '../crypto/invite';
import { MAX_PLAINTEXT_BYTES, type Seal } from '../crypto/seal';
import type { InviteToken } from '../engine/event';
import type { LogRecord } from '../engine/fold';
import { codePointLength } from '../engine/text';

/** What a joiner sees before choosing a name: plain text, never Markdown or HTML. */
export interface InvitePreview {
  /** The group's name, cut to {@link NAME_MAX} code points. */
  readonly groupName: string;
  /** The inviter's name in the group, cut likewise. */
  readonly inviterName: string;
  /** The Document's title, cut likewise. */
  readonly documentTitle: string;
  /** The first Atom as plain text, cut to {@link EXCERPT_MAX} code points. */
  readonly excerpt: string;
}

/** What an envelope carries. */
export interface Envelope {
  /** The 32-byte group secret, from which the joiner derives the group's mailbox and seal key. */
  readonly groupSecret: Uint8Array;
  /** The preview the Join screen shows. */
  readonly preview: InvitePreview;
  /** The inviter's token, which the joiner carries in their `join`. */
  readonly token: InviteToken;
  /** The relay-accepted log, in seq order. */
  readonly entries: readonly LogRecord[];
}

/** An envelope's first blob: everything but the entries, and how many chunks hold them. */
export interface InviteHeader extends Omit<Envelope, 'entries'> {
  /** How many chunk blobs follow the header: at least 1, since the log holds genesis. */
  readonly chunkCount: number;
}

/**
 * How long the relay keeps an envelope: 1 day, which the relay rounds up to
 * the end of the next UTC day, so a link lives 24–48 hours and "the next 2
 * days" stays true (spec §2, ADR-0073). The relay's TTL is the only expiry.
 */
export const INVITE_TTL_DAYS = 1;

/** The longest group name, inviter name or Document title a preview carries, in code points. */
export const NAME_MAX = 120;

/** The longest excerpt a preview carries, in code points, before its "…". */
export const EXCERPT_MAX = 280;

/** What a cut field ends with. */
export const ELLIPSIS = '…';

/** The bytes before each record in a chunk: seq (8), received (8) and length (4). */
export const ENTRY_HEADER_BYTES = 20;

/** The largest record a chunk can carry beside its entry header. Every record a device makes fits. */
const MAX_ENTRY_RECORD = MAX_PLAINTEXT_BYTES - ENTRY_HEADER_BYTES;

const TOKEN_KEY = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_SIG = /^[A-Za-z0-9_-]{86}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();
// fatal: bytes that aren't UTF-8 throw, so they read as a damaged header.
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `text`, or its first `max` code points, trailing spaces dropped, then "…". */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join('').trimEnd()}${ELLIPSIS}`;
}

/** One entry's bytes: seq ‖ received ‖ length ‖ record. */
function entryBytes({ seq, received, bytes }: LogRecord): Uint8Array {
  const out = new Uint8Array(ENTRY_HEADER_BYTES + bytes.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(seq));
  view.setBigUint64(8, BigInt(received));
  view.setUint32(16, bytes.length);
  out.set(bytes, ENTRY_HEADER_BYTES);
  return out;
}

/** `parts` joined end to end. */
function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The log's entries packed in order into chunks of at most 65,492 bytes, each
 * starting a new chunk only when the next entry wouldn't fit. A record too
 * large for any blob, which no device makes (the cap is 64,000 bytes), is
 * left out rather than failing the whole invite.
 */
export function packEntries(entries: readonly LogRecord[]): Uint8Array[] {
  const chunks: Uint8Array[][] = [];
  let current: Uint8Array[] = [];
  let size = 0;
  for (const entry of entries) {
    if (entry.bytes.length > MAX_ENTRY_RECORD) continue;
    const bytes = entryBytes(entry);
    if (size + bytes.length > MAX_PLAINTEXT_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(bytes);
    size += bytes.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map(joined);
}

/** A whole number a chunk can carry: at most 2^53 − 1, or null. */
function safe(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** The entry at `at` in `chunk` and where the next starts, or null when it doesn't parse. */
function readEntry(chunk: Uint8Array, at: number): { entry: LogRecord; next: number } | null {
  if (chunk.length - at < ENTRY_HEADER_BYTES) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset + at, ENTRY_HEADER_BYTES);
  const seq = safe(view.getBigUint64(0));
  const received = safe(view.getBigUint64(8));
  const length = view.getUint32(16);
  const start = at + ENTRY_HEADER_BYTES;
  const next = start + length;
  if (seq === null || seq < 1 || received === null || length < 1 || next > chunk.length) {
    return null;
  }
  return { entry: { seq, received, bytes: chunk.slice(start, next) }, next };
}

/** The entries packed in `chunk`, or null when it is empty or any entry doesn't parse. */
export function unpackChunk(chunk: Uint8Array): LogRecord[] | null {
  const entries: LogRecord[] = [];
  let at = 0;
  while (at < chunk.length) {
    const read = readEntry(chunk, at);
    if (read === null) return null;
    entries.push(read.entry);
    at = read.next;
  }
  return entries.length > 0 ? entries : null;
}

/** The header's JSON bytes, each preview field cut to its limit. */
export function encodeHeader(header: InviteHeader): Uint8Array {
  const { groupSecret, preview, token, chunkCount } = header;
  return encoder.encode(
    JSON.stringify({
      groupSecret: base64url(groupSecret),
      preview: {
        groupName: clip(preview.groupName, NAME_MAX),
        inviterName: clip(preview.inviterName, NAME_MAX),
        documentTitle: clip(preview.documentTitle, NAME_MAX),
        excerpt: clip(preview.excerpt, EXCERPT_MAX),
      },
      token: { by: token.by, sig: token.sig },
      chunkCount,
    }),
  );
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of at most `max` code points plus a "…", or null. */
function textUpTo(value: unknown, max: number): string | null {
  return typeof value === 'string' && codePointLength(value) <= max + 1 ? value : null;
}

/** 43 base64url characters that encode exactly 32 bytes, or null. */
function parseSecret(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !SECRET.test(value)) return null;
  const bytes = fromBase64url(value);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return bytes.length === GROUP_SECRET_BYTES && base64url(bytes) === value ? bytes : null;
}

function parsePreview(value: unknown): InvitePreview | null {
  if (!isObject(value)) return null;
  const groupName = textUpTo(value.groupName, NAME_MAX);
  const inviterName = textUpTo(value.inviterName, NAME_MAX);
  const documentTitle = textUpTo(value.documentTitle, NAME_MAX);
  const excerpt = textUpTo(value.excerpt, EXCERPT_MAX);
  if (groupName === null || inviterName === null || documentTitle === null || excerpt === null) {
    return null;
  }
  return { groupName, inviterName, documentTitle, excerpt };
}

function parseToken(value: unknown): InviteToken | null {
  if (!isObject(value)) return null;
  const { by, sig } = value;
  if (typeof by !== 'string' || typeof sig !== 'string') return null;
  return TOKEN_KEY.test(by) && TOKEN_SIG.test(sig) ? { by, sig } : null;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value;
  } catch {
    return undefined;
  }
}

/** The header in `bytes`, or null for anything that isn't exactly a well-formed one. */
export function decodeHeader(bytes: Uint8Array): InviteHeader | null {
  const raw = parseJson(bytes);
  if (!isObject(raw)) return null;
  const groupSecret = parseSecret(raw.groupSecret);
  const preview = parsePreview(raw.preview);
  const token = parseToken(raw.token);
  const { chunkCount } = raw;
  if (groupSecret === null || preview === null || token === null) return null;
  if (!Number.isSafeInteger(chunkCount) || typeof chunkCount !== 'number' || chunkCount < 1) {
    return null;
  }
  return { groupSecret, preview, token, chunkCount };
}

/** The envelope's blobs, in the order they're posted: the header, then each chunk. */
export function sealEnvelope(
  seal: Seal,
  { mailbox, key }: InviteChannel,
  envelope: Envelope,
): Uint8Array<ArrayBuffer>[] {
  const chunks = packEntries(envelope.entries);
  const header = encodeHeader({ ...envelope, chunkCount: chunks.length });
  return [header, ...chunks].map((plaintext) => seal.seal(mailbox, key, plaintext));
}

/**
 * The envelope in `blobs`, the invite mailbox's records in relay order, or
 * null unless every blob opens, the first is a header, and exactly its
 * chunk count of chunks follow, each holding whole entries.
 */
export function openEnvelope(
  seal: Seal,
  { mailbox, key }: InviteChannel,
  blobs: readonly Uint8Array[],
): Envelope | null {
  const opened: Uint8Array[] = [];
  for (const blob of blobs) {
    const plaintext = seal.open(mailbox, key, blob);
    if (plaintext === null) return null;
    opened.push(plaintext);
  }
  const [first, ...chunks] = opened;
  const header = first === undefined ? null : decodeHeader(first);
  if (header === null || header.chunkCount !== chunks.length) return null;
  const entries: LogRecord[] = [];
  for (const chunk of chunks) {
    const read = unpackChunk(chunk);
    if (read === null) return null;
    entries.push(...read);
  }
  const { groupSecret, preview, token } = header;
  return { groupSecret, preview, token, entries };
}
