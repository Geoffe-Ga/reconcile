/**
 * What a shared personal Document's copies say (spec §11 "Share link"; #105).
 *
 * A copy is UTF-8 JSON: the Document's latest version, `{v: 1, n, title,
 * text}`, with the text normalized as Preview shows it, or a tombstone,
 * `{v: 1, n, stopped: true}`, which ends the share. `n` counts the owner's
 * posts, so the copy with the highest `n` is the latest. Each copy is signed
 * under the share's own key and sealed for its mailbox (`crypto/share.ts`);
 * a reader parses only copies whose signature verified, and parses them
 * strictly, so nothing beside these fields reaches a screen.
 */
import { MAX_RECORD_BYTES, RECORD_HEADER_BYTES } from '../crypto/record';
import { isPersonalTitle } from '../store/personal';

/** The copy format this app writes and reads. */
export const COPY_VERSION = 1;

/** A Document's latest version, as its link shows it. */
export interface VersionCopy {
  readonly v: typeof COPY_VERSION;
  /** One more than the highest `n` the owner's device found in the mailbox. */
  readonly n: number;
  /** The Document's title: 1 to 120 code points, trimmed. */
  readonly title: string;
  /** The Document's Markdown text, normalized. */
  readonly text: string;
}

/** The last copy of a share that was stopped: every reader then shows the not-shared line. */
export interface StoppedCopy {
  readonly v: typeof COPY_VERSION;
  readonly n: number;
  readonly stopped: true;
}

/** One copy in a share's mailbox. */
export type ShareCopy = VersionCopy | StoppedCopy;

/** A copy's words, before its `n` is known. */
export interface CopyWords {
  readonly title: string;
  readonly text: string;
}

/** `copy` as the bytes a record signs: compact JSON, its keys in a fixed order. */
export function encodeCopy(copy: ShareCopy): Uint8Array<ArrayBuffer> {
  const json =
    'stopped' in copy
      ? { v: copy.v, n: copy.n, stopped: true }
      : { v: copy.v, n: copy.n, title: copy.title, text: copy.text };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/**
 * Whether a Document of these words can be shared: its record, at the
 * largest `n` a copy can carry, is at most 64,000 bytes (spec §2), counted in
 * bytes as JSON spells them, never characters.
 */
export function fitsShare(words: CopyWords): boolean {
  const copy = encodeCopy({ v: COPY_VERSION, n: Number.MAX_SAFE_INTEGER, ...words });
  return RECORD_HEADER_BYTES + copy.length <= MAX_RECORD_BYTES;
}

/** The keys of a version copy, and of a tombstone, sorted. */
const VERSION_KEYS = 'n,text,title,v';
const STOPPED_KEYS = 'n,stopped,v';

/** Whether `value` is a post count: a whole number from 1 to 2^53 − 1. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** The JSON object `bytes` spell in UTF-8, or null when they spell anything else. */
function objectIn(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The copy `bytes` spell, or null: anything but exactly a version's four
 * fields or a tombstone's three, of format 1, a whole `n` from 1, a title
 * the editor accepts and a text, is refused.
 */
export function parseCopy(bytes: Uint8Array): ShareCopy | null {
  const json = objectIn(bytes);
  if (json === null || json.v !== COPY_VERSION || !isCount(json.n)) return null;
  const keys = Object.keys(json).sort().join();
  if (keys === STOPPED_KEYS) {
    return json.stopped === true ? { v: COPY_VERSION, n: json.n, stopped: true } : null;
  }
  const { title, text } = json;
  const shaped = keys === VERSION_KEYS;
  return shaped && isPersonalTitle(title) && typeof text === 'string'
    ? { v: COPY_VERSION, n: json.n, title, text }
    : null;
}
