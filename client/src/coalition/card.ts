/**
 * Reconcile cards (spec §4 Coalitions; ADR-0036, ADR-0074; #114): how one
 * group offers to reconcile with another, privately, group to group.
 *
 * A card link is `${origin}/#reconcile/${seed}`: 32 random bytes in 43
 * base64url characters, after `#`, which browsers never send to a server.
 * The card mailbox id and the key its envelope is sealed under derive from
 * the seed (`crypto/card.ts`). The envelope is M2-03's: a header blob, then
 * the chunks of a log, each sealed with the `Seal` a group's blobs use, so
 * each is padded to one of four sizes, and the relay keeps it 1 day, which it
 * rounds up to 24–48 hours.
 *
 * - The header is JSON `{secret, inner, seat, name, title, atoms,
 *   chunkCount}`: the coalition secret and `inner`, each 32 bytes in
 *   base64url, the maker's seat (their group's name there and its public
 *   seat key, never its seat secret, which stays in the group's own sealed
 *   log), and the coalition's name and statement.
 * - A card for a coalition still to form carries no log. A card from a
 *   formed coalition (admitting a group) carries the coalition's log, packed
 *   as an invite packs a group's (`invite/envelope.ts`), so the device that
 *   brings it reads the coalition whatever the relay has dropped since.
 *
 * Opening is all or nothing, as an invite's is: anything wrong reads as one
 * expired or damaged card. Everything here is pure: the caller does the
 * relay's PUTs and GETs.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { GROUP_SECRET_BYTES } from '../crypto/groupKeys';
import type { InviteChannel } from '../crypto/invite';
import { MAX_PLAINTEXT_BYTES, type Seal } from '../crypto/seal';
import type { SeatEntry } from '../engine/event';
import type { LogRecord } from '../engine/fold';
import { codePointLength } from '../engine/text';
import { NAME_MAX, openChunked, packEntries, sealChunked } from '../invite/envelope';

/** What a card carries. */
export interface Card {
  /** The 32-byte coalition secret, from which the coalition's mailboxes and seal key derive. */
  readonly secret: Uint8Array;
  /** The coalition's 32 `inner` bytes, which followers never get (#100). */
  readonly inner: Uint8Array;
  /** The maker's seat: their group's name in the coalition and its public seat key. */
  readonly seat: SeatEntry;
  /** The coalition's name, 1–120 code points. */
  readonly name: string;
  /** The title of its statement. */
  readonly title: string;
  /** Its statement's Atoms. */
  readonly atoms: readonly string[];
  /** The coalition's log, for a card from a formed coalition; none for one still to form. */
  readonly entries: readonly LogRecord[];
}

/** A card's first blob: everything but the entries, and how many chunks hold them. */
interface CardHeader extends Omit<Card, 'entries'> {
  readonly chunkCount: number;
}

/** How long the relay keeps a card: 1 day, rounded up by the relay, so it lives 24–48 hours. */
export const CARD_TTL_DAYS = 1;

/** A card link's form: `#reconcile/{seed}`, with no slash after `#`. */
export const CARD_PREFIX = '#reconcile/';

/** Thrown when a card's header would be too large for a blob. */
export class CardTooLarge extends Error {
  /** Say the card is too large. */
  constructor() {
    super('This card is too large to send.');
    this.name = 'CardTooLarge';
  }
}

const KEY = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();
// fatal: bytes that aren't UTF-8 throw, so they read as a damaged card.
const decoder = new TextDecoder('utf-8', { fatal: true });

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 43 base64url characters that encode exactly 32 bytes, as written, or null. */
function key32(value: unknown): string | null {
  if (typeof value !== 'string' || !KEY.test(value)) return null;
  const bytes = fromBase64url(value);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return bytes.length === GROUP_SECRET_BYTES && base64url(bytes) === value ? value : null;
}

/** Text of 1 to `max` code points, {@link NAME_MAX} unless given, or null. */
function nameText(value: unknown, max = NAME_MAX): string | null {
  if (typeof value !== 'string') return null;
  const length = codePointLength(value);
  return length >= 1 && length <= max ? value : null;
}

/** The header's JSON bytes. */
function encodeHeader(header: CardHeader): Uint8Array {
  const { secret, inner, seat, name, title, atoms, chunkCount } = header;
  return encoder.encode(
    JSON.stringify({
      secret: base64url(secret),
      inner: base64url(inner),
      seat: { name: seat.name, key: seat.key },
      name,
      title,
      atoms,
      chunkCount,
    }),
  );
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
 * The maker's seat: a group name of 1–120 code points, or 120 and the "…"
 * a longer one is cut to (`clip`), and a public seat key; or null.
 */
function parseSeat(value: unknown): SeatEntry | null {
  if (!isObject(value)) return null;
  const name = nameText(value.name, NAME_MAX + 1);
  const key = key32(value.key);
  return name === null || key === null ? null : { name, key };
}

/** A list of strings, or null. */
function parseAtoms(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const atoms: unknown[] = value;
  return atoms.every((atom) => typeof atom === 'string') ? atoms : null;
}

/** The secrets in a header, as bytes, or null. */
function parseSecrets(raw: Json): Pick<Card, 'secret' | 'inner'> | null {
  const secret = key32(raw.secret);
  const inner = key32(raw.inner);
  if (secret === null || inner === null) return null;
  return { secret: fromBase64url(secret), inner: fromBase64url(inner) };
}

/** A title of at most {@link NAME_MAX} code points, or null. */
function titleText(value: unknown): string | null {
  return typeof value === 'string' && codePointLength(value) <= NAME_MAX ? value : null;
}

/** A whole number of chunks, 0 or more, or null. */
function chunkCountOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The header in `bytes`, or null for anything that isn't exactly a well-formed one. */
function decodeHeader(bytes: Uint8Array): CardHeader | null {
  const raw = parseJson(bytes);
  if (!isObject(raw)) return null;
  const secrets = parseSecrets(raw);
  const seat = parseSeat(raw.seat);
  const name = nameText(raw.name);
  const title = titleText(raw.title);
  const atoms = parseAtoms(raw.atoms);
  const chunkCount = chunkCountOf(raw.chunkCount);
  if (secrets === null || seat === null || name === null || title === null) return null;
  if (atoms === null || chunkCount === null) return null;
  return { ...secrets, seat, name, title, atoms, chunkCount };
}

/**
 * The card's blobs, in the order they're posted: the header, then each chunk
 * of its entries.
 *
 * @throws {CardTooLarge} when the header won't fit one blob.
 */
export function sealCard(
  seal: Seal,
  channel: InviteChannel,
  card: Card,
): Uint8Array<ArrayBuffer>[] {
  const chunks = packEntries(card.entries);
  const header = encodeHeader({ ...card, chunkCount: chunks.length });
  if (header.length > MAX_PLAINTEXT_BYTES) throw new CardTooLarge();
  return sealChunked(seal, channel, header, chunks);
}

/**
 * The card in `blobs`, its mailbox's records in relay order, or null unless
 * every blob opens, the first is a header, and exactly its chunk count of
 * chunks follow, each holding whole entries.
 */
export function openCard(
  seal: Seal,
  channel: InviteChannel,
  blobs: readonly Uint8Array[],
): Card | null {
  const opened = openChunked(seal, channel, blobs, decodeHeader);
  if (opened === null) return null;
  const { secret, inner, seat, name, title, atoms } = opened.header;
  return { secret, inner, seat, name, title, atoms, entries: opened.entries };
}

/** The link to send: the app's origin, then the seed after `#reconcile/`. */
export function cardLink(origin: string, seed: Uint8Array): string {
  return `${origin}/${CARD_PREFIX}${base64url(seed)}`;
}

/** 43 base64url characters as the 32-byte seed, or null for anything else. */
export function parseCardPayload(payload: string): Uint8Array | null {
  const seed = key32(payload);
  return seed === null ? null : fromBase64url(seed);
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
 * The 32-byte seed in a pasted card link, from any origin, or null. Start's
 * paste field and the Bring screen read cards through it. A bare seed is an
 * invite's (`parseInviteLink`), so only a whole link reads as a card.
 */
export function parseCardLink(text: string): Uint8Array | null {
  const hash = fragmentOf(text.trim());
  if (hash?.startsWith(CARD_PREFIX) !== true) return null;
  return parseCardPayload(hash.slice(CARD_PREFIX.length));
}
