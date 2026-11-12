/**
 * The invite envelope (spec §7, "Joining with full history"; #73): what Copy
 * invite link posts to the invite mailbox, and what opening the link reads.
 *
 * An envelope is a header blob, then one blob per chunk, each sealed under the
 * invite key (`crypto/invite.ts`) with the `Seal` the group's own blobs use.
 *
 * - The header is JSON `{groupSecret, epoch, preview, token, chunkCount}`:
 *   the group's current secret in base64url and its epoch (#98), the preview
 *   a joiner sees before choosing a name (ADR-0052), the inviter's token, and
 *   how many chunks follow. Every field has a limit, so the header stays a
 *   few kilobytes at most, however long the group has run (#269).
 * - Each chunk packs log entries, `seq (8 bytes) ‖ received (8) ‖ epoch (4) ‖
 *   kept (1) ‖ length (4) ‖ record`, big-endian, up to the 65,492 bytes a blob
 *   carries. `received` travels with each record because vote deadlines run
 *   on it, and `epoch`, the epoch of the mailbox it was read from, because the
 *   fold ignores a record read from an epoch's mailbox after its key changed
 *   (#98). An invite made before #98 has no epoch, and reads as damaged.
 * - `kept` is 1 for the one `result` a Proposal whose ballots the inviter's
 *   device has cleared keeps (#111), and 0 for every other entry. The joiner
 *   takes the Proposals those results name as its own `cleared`, so it folds
 *   their outcomes from their results, as the inviter does. The marks replace
 *   the header's list of ids, which grew by one per cleared Proposal until a
 *   long-lived group's header could outgrow a blob (#269). A header that
 *   still has `cleared`, from an invite made before #269, reads as damaged.
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
import { expiryKeyOf } from '../engine/expiry';
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
  /** The 32-byte group secret, from which the joiner derives the group's weekly mailboxes and seal key. */
  readonly groupSecret: Uint8Array;
  /** The epoch of that secret (#98): 0 until the group's key first changes. */
  readonly epoch: number;
  /** The preview the Join screen shows. */
  readonly preview: InvitePreview;
  /** The inviter's token, which the joiner carries in their `join`. */
  readonly token: InviteToken;
  /** The relay-accepted log, in seq order. */
  readonly entries: readonly LogRecord[];
  /**
   * The Proposals whose ballots the inviter's device has cleared (#111), which
   * the joiner keeps. Sealing marks the one result each keeps in `entries`,
   * and opening reads them back from those marks, in log order, once each
   * (#269). So an id that no result in `entries` names doesn't come back: a
   * device clears a Proposal only by a result it keeps in its log
   * (`clearExpiredBallots`, `store/expiry.ts`), and an id no record names
   * changes no fold.
   */
  readonly cleared: readonly string[];
}

/** An envelope's first blob: everything but the entries and their marks, and how many chunks hold them. */
export interface InviteHeader extends Omit<Envelope, 'entries' | 'cleared'> {
  /** How many chunk blobs follow the header: at least 1, since the log holds genesis. */
  readonly chunkCount: number;
}

/** A log entry as a chunk carries it: marked `kept` when it's the result a cleared Proposal keeps (#269). */
export interface ChunkEntry extends LogRecord {
  /** True for the one result a Proposal whose ballots the inviter cleared keeps; absent for any other entry. */
  readonly kept?: true;
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

/** The bytes before each record in a chunk: seq (8), received (8), epoch (4), kept (1) and length (4). */
export const ENTRY_HEADER_BYTES = 25;

/** The largest epoch: a u32 carries it. */
const MAX_EPOCH = 0xffff_ffff;

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

/** One entry's bytes: seq ‖ received ‖ epoch ‖ kept ‖ length ‖ record. */
function entryBytes({ seq, received, bytes, epoch = 0, kept }: ChunkEntry): Uint8Array {
  const out = new Uint8Array(ENTRY_HEADER_BYTES + bytes.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(seq));
  view.setBigUint64(8, BigInt(received));
  view.setUint32(16, epoch);
  view.setUint8(20, kept === true ? 1 : 0);
  view.setUint32(21, bytes.length);
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
export function packEntries(entries: readonly ChunkEntry[]): Uint8Array[] {
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
function readEntry(chunk: Uint8Array, at: number): { entry: ChunkEntry; next: number } | null {
  if (chunk.length - at < ENTRY_HEADER_BYTES) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset + at, ENTRY_HEADER_BYTES);
  const seq = safe(view.getBigUint64(0));
  const received = safe(view.getBigUint64(8));
  const epoch = view.getUint32(16);
  const kept = view.getUint8(20);
  const length = view.getUint32(21);
  const start = at + ENTRY_HEADER_BYTES;
  const next = start + length;
  if (seq === null || seq < 1 || received === null || kept > 1) return null;
  if (length < 1 || next > chunk.length) return null;
  // The log keeps epoch 0 as no epoch at all, as it always has, and an entry not kept carries no mark.
  const bytes = chunk.slice(start, next);
  const marks = {
    ...(epoch === 0 ? {} : { epoch }),
    ...(kept === 1 ? { kept: true as const } : {}),
  };
  return { entry: { seq, received, bytes, ...marks }, next };
}

/** The entries packed in `chunk`, or null when it is empty or any entry doesn't parse. */
export function unpackChunk(chunk: Uint8Array): ChunkEntry[] | null {
  const entries: ChunkEntry[] = [];
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
  const { groupSecret, epoch, preview, token, chunkCount } = header;
  return encoder.encode(
    JSON.stringify({
      groupSecret: base64url(groupSecret),
      epoch,
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

/**
 * The header in `bytes`, or null for anything that isn't exactly a
 * well-formed one, such as a header from before #269, which lists `cleared`
 * and whose chunks have no kept byte.
 */
export function decodeHeader(bytes: Uint8Array): InviteHeader | null {
  const raw = parseJson(bytes);
  if (!isObject(raw) || 'cleared' in raw) return null;
  const groupSecret = parseSecret(raw.groupSecret);
  const preview = parsePreview(raw.preview);
  const token = parseToken(raw.token);
  const { chunkCount, epoch } = raw;
  if (groupSecret === null || preview === null || token === null || !isEpoch(epoch)) return null;
  if (!Number.isSafeInteger(chunkCount) || typeof chunkCount !== 'number' || chunkCount < 1) {
    return null;
  }
  return { groupSecret, epoch, preview, token, chunkCount };
}

/** Whether `value` is an epoch: a whole number a u32 holds. */
function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_EPOCH;
}

/**
 * `entries`, each signed `result` for a Proposal in `cleared` marked kept:
 * the one result a device keeps for each Proposal whose ballots it has
 * cleared (#111, #269). Checking a record's signature again costs nothing,
 * since its verdict is kept per page load.
 */
function markKept(
  entries: readonly LogRecord[],
  cleared: readonly string[],
): readonly ChunkEntry[] {
  if (cleared.length === 0) return entries;
  const ids = new Set(cleared);
  return entries.map((entry): ChunkEntry => {
    const key = expiryKeyOf(entry.bytes);
    return key?.result === true && ids.has(key.proposal) ? { ...entry, kept: true } : entry;
  });
}

/**
 * The Proposals the kept entries' results name, in log order, once each
 * (#269), or null when an entry marked kept isn't a signed result, which no
 * inviter marks.
 */
function keptProposals(entries: readonly ChunkEntry[]): string[] | null {
  const cleared = new Set<string>();
  for (const entry of entries) {
    if (entry.kept !== true) continue;
    const key = expiryKeyOf(entry.bytes);
    if (key?.result !== true) return null;
    cleared.add(key.proposal);
  }
  return [...cleared];
}

/** `entry` as the log keeps it: without a kept mark. */
function logRecordOf({ seq, received, bytes, epoch }: ChunkEntry): LogRecord {
  return { seq, received, bytes, ...(epoch === undefined ? {} : { epoch }) };
}

/** The envelope's blobs, in the order they're posted: the header, then each chunk. */
export function sealEnvelope(
  seal: Seal,
  { mailbox, key }: InviteChannel,
  envelope: Envelope,
): Uint8Array<ArrayBuffer>[] {
  const chunks = packEntries(markKept(envelope.entries, envelope.cleared));
  const header = encodeHeader({ ...envelope, chunkCount: chunks.length });
  return [header, ...chunks].map((plaintext) => seal.seal(mailbox, key, plaintext));
}

/**
 * The envelope in `blobs`, the invite mailbox's records in relay order, or
 * null unless every blob opens, the first is a header, and exactly its
 * chunk count of chunks follow, each holding whole entries, every one marked
 * kept a signed result.
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
  const entries: ChunkEntry[] = [];
  for (const chunk of chunks) {
    const read = unpackChunk(chunk);
    if (read === null) return null;
    entries.push(...read);
  }
  const cleared = keptProposals(entries);
  if (cleared === null) return null;
  const { groupSecret, epoch, preview, token } = header;
  return { groupSecret, epoch, preview, token, entries: entries.map(logRecordOf), cleared };
}
