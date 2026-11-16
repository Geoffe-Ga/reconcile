/**
 * Follow links (spec §4 Coalitions, "Following"; ADR-0003, ADR-0053,
 * ADR-0075 §5; #124): how a coalition's participant lets someone read it
 * without joining any member group.
 *
 * A follow link is `${origin}/#follow/${seed}`: 32 random bytes in 43
 * base64url characters, after `#`, which browsers never send to a server.
 * The follow mailbox id and the key its envelope is sealed under derive from
 * the seed (`crypto/follow.ts`). The envelope is M2-03's: a header blob, then
 * the chunks of the coalition's log, each sealed with the `Seal` a group's
 * blobs use, so each is padded to one of four sizes, and the relay keeps it
 * 1 day, which it rounds up to 24–48 hours. Anyone who opens the link in
 * that time can read the coalition from then on (ADR-0053).
 *
 * - The header is JSON `{secret, preview: {name, groups, excerpt},
 *   chunkCount}`, exactly those keys: the coalition secret, 32 bytes in
 *   base64url, from which its mailboxes and seal key derive; the coalition's
 *   name, its member groups' names, and its first section as plain text,
 *   each cut as an invite's preview is; and how many chunks follow. Never
 *   `inner` or a seat secret, which followers never get (#100): a header
 *   holding any other key reads as damaged, so a follower's device never
 *   keeps one.
 * - The chunks pack the coalition's relay-accepted log as an invite packs a
 *   group's (`invite/envelope.ts`), at least its genesis, so a follower reads
 *   the coalition whatever the relay has dropped since. No entry is marked
 *   kept (#269): a coalition's own log takes no result, so it keeps none,
 *   and a link with a marked entry reads as damaged, as a card's does.
 *
 * Opening is all or nothing, as an invite's is: anything wrong reads as one
 * expired or damaged link. Everything here is pure: the caller does the
 * relay's PUTs and GETs.
 */
import { base64url } from '../crypto/base64url';
import type { InviteChannel } from '../crypto/invite';
import { MAX_PLAINTEXT_BYTES, type Seal } from '../crypto/seal';
import type { LogRecord } from '../engine/fold';
import { codePointLength } from '../engine/text';
import {
  clip,
  EXCERPT_MAX,
  isObject,
  type Json,
  NAME_MAX,
  openChunked,
  packEntries,
  parseJson,
  parseSecret,
  sealChunked,
  textUpTo,
  unmarked,
} from '../invite/envelope';

/** What a follow link's opener sees before following: plain text, never Markdown or HTML. */
export interface FollowPreview {
  /** The coalition's name, cut to {@link NAME_MAX} code points. */
  readonly name: string;
  /** Its member groups' names, in seat order, each cut likewise. */
  readonly groups: readonly string[];
  /** Its first section as plain text, cut to {@link EXCERPT_MAX} code points. */
  readonly excerpt: string;
}

/** What a follow link carries. */
export interface Follow {
  /** The 32-byte coalition secret, from which its mailboxes and seal key derive. */
  readonly secret: Uint8Array;
  /** The preview the Follow screen shows. */
  readonly preview: FollowPreview;
  /** The coalition's relay-accepted log, in seq order. */
  readonly entries: readonly LogRecord[];
}

/** A follow link's first blob: everything but the entries, and how many chunks hold them. */
interface FollowHeader extends Omit<Follow, 'entries'> {
  readonly chunkCount: number;
}

/** How long the relay keeps a follow link's envelope: 1 day, rounded up, so it lives 24–48 hours. */
export const FOLLOW_TTL_DAYS = 1;

/** A follow link's form: `#follow/{seed}`, with no slash after `#`. */
export const FOLLOW_PREFIX = '#follow/';

/** The header's keys, in the order it writes them: nothing else may ride along. */
const HEADER_KEYS = ['secret', 'preview', 'chunkCount'];

/** The preview's keys, in the order it writes them. */
const PREVIEW_KEYS = ['name', 'groups', 'excerpt'];

/** Thrown when a follow link's header would be too large for a blob. */
export class FollowTooLarge extends Error {
  /** Say the preview is too large. */
  constructor() {
    super('This coalition’s follow link is too large to send.');
    this.name = 'FollowTooLarge';
  }
}

const encoder = new TextEncoder();

/** The header's JSON bytes, each preview field cut to its limit. */
function encodeHeader({ secret, preview, chunkCount }: FollowHeader): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      secret: base64url(secret),
      preview: {
        name: clip(preview.name, NAME_MAX),
        groups: preview.groups.map((group) => clip(group, NAME_MAX)),
        excerpt: clip(preview.excerpt, EXCERPT_MAX),
      },
      chunkCount,
    }),
  );
}

/** Whether `value` holds exactly `keys`, in any order. */
function hasExactly(value: Json, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** A name of 1 to {@link NAME_MAX} code points, plus a "…" once cut, or null. */
function nameText(value: unknown): string | null {
  const text = textUpTo(value, NAME_MAX);
  return text === null || codePointLength(text) === 0 ? null : text;
}

/** One or more group names, each as {@link nameText} reads it, or null. */
function groupNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = value.map(nameText);
  return names.every((name): name is string => name !== null) ? names : null;
}

/** The preview in `value`, exactly its three fields, or null. */
function parsePreview(value: unknown): FollowPreview | null {
  if (!isObject(value) || !hasExactly(value, PREVIEW_KEYS)) return null;
  const name = nameText(value.name);
  const groups = groupNames(value.groups);
  const excerpt = textUpTo(value.excerpt, EXCERPT_MAX);
  if (name === null || groups === null || excerpt === null) return null;
  return { name, groups, excerpt };
}

/** The header in `bytes`, exactly its three fields and at least one chunk, or null. */
function decodeHeader(bytes: Uint8Array): FollowHeader | null {
  const raw = parseJson(bytes);
  if (!isObject(raw) || !hasExactly(raw, HEADER_KEYS)) return null;
  const secret = parseSecret(raw.secret);
  const preview = parsePreview(raw.preview);
  const { chunkCount } = raw;
  if (secret === null || preview === null) return null;
  if (typeof chunkCount !== 'number' || !Number.isSafeInteger(chunkCount) || chunkCount < 1) {
    return null;
  }
  return { secret, preview, chunkCount };
}

/**
 * The follow link's blobs, in the order they're posted: the header, then
 * each chunk of the coalition's log.
 *
 * @throws {FollowTooLarge} when the header won't fit one blob.
 */
export function sealFollow(
  seal: Seal,
  channel: InviteChannel,
  follow: Follow,
): Uint8Array<ArrayBuffer>[] {
  const chunks = packEntries(follow.entries);
  const header = encodeHeader({ ...follow, chunkCount: chunks.length });
  if (header.length > MAX_PLAINTEXT_BYTES) throw new FollowTooLarge();
  return sealChunked(seal, channel, header, chunks);
}

/**
 * What the link in `blobs`, its mailbox's records in relay order, carries,
 * or null unless every blob opens, the first is a header of exactly its
 * three fields, and exactly its chunk count of chunks follow, each holding
 * whole entries, none marked kept (#269).
 */
export function openFollow(
  seal: Seal,
  channel: InviteChannel,
  blobs: readonly Uint8Array[],
): Follow | null {
  const opened = openChunked(seal, channel, blobs, decodeHeader);
  if (opened === null) return null;
  const entries = unmarked(opened.entries);
  if (entries === null) return null;
  const { secret, preview } = opened.header;
  return { secret, preview, entries };
}

/** The link to send: the app's origin, then the seed after `#follow/`. */
export function followLink(origin: string, seed: Uint8Array): string {
  return `${origin}/${FOLLOW_PREFIX}${base64url(seed)}`;
}

/** 43 base64url characters as the 32-byte seed, or null for anything else. */
export function parseFollowPayload(payload: string): Uint8Array | null {
  return parseSecret(payload);
}

/** The fragment of `text` when it's an absolute URL, else null. */
function fragmentOf(text: string): string | null {
  try {
    return new URL(text).hash;
  } catch {
    return null;
  }
}

/**
 * The 32-byte seed in a pasted follow link, from any origin, or null. A bare
 * seed is an invite's (`parseInviteLink`), so only a whole link reads as a
 * follow link. The link bar reads its kind and payload through `linkKind`.
 */
export function parseFollowLink(text: string): Uint8Array | null {
  const hash = fragmentOf(text.trim());
  if (hash?.startsWith(FOLLOW_PREFIX) !== true) return null;
  return parseFollowPayload(hash.slice(FOLLOW_PREFIX.length));
}
