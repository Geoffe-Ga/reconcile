/**
 * A front door's page (#121; ADR-0038; docs/spec/phase-1-spec.md §4, Opt-ins).
 *
 * A group that opens its front door by Proposal gets a link it can post
 * anywhere: `${origin}/#door/${address}`, where the address is the door's
 * 43-character Ed25519 public key (`crypto/door.ts`). Whoever opens it reads
 * the page from its mailbox: UTF-8 JSON, `{v: 1, open: true, name, excerpt,
 * count?, box}`, or `{v: 1, open: false}` once the door closes, and `{v: 1,
 * open: false, final: true}` once it has closed for good (#288). `name` is the
 * group's name, `excerpt` the first section of its Document as plain text, cut
 * to 280 code points and "…", `count` how many people are in the group only
 * when the group chose to show it, and `box` the X25519 key applications are
 * sealed to. Never a member's name, key or anything else of the group.
 *
 * Each copy is signed with the door's key, sealed and padded with the app's
 * `Seal` under the page key, and kept 30 days. Readers take the last copy
 * whose signature verifies and whose page parses, so a copy anyone else
 * seals into the mailbox, or a damaged blob, changes nothing. A final copy
 * outranks every other, wherever it sits ({@link latestCopy}): once a door
 * has closed for good, as it does when a membership ends, an open copy
 * posted after it, forged by someone who left and still holds the door's
 * key or replayed from before (#277), changes nothing either. Members'
 * devices post a fresh copy when what the page says changes, and when the
 * newest is {@link REFRESH_MINUTES} old, in relay time (`door/keeper.ts`);
 * a final copy too, so one stays while the group goes on.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import {
  doorChannelsOf,
  doorKeysOf,
  newDoorSecrets,
  openDoorRecord,
  signDoorRecord,
} from '../crypto/door';
import type { Seal } from '../crypto/seal';
import { publicKeyOf } from '../crypto/sign';
import { DAY_MINUTES } from '../engine/rules';
import type { GroupState } from '../engine/fold';
import type { FrontDoor } from '../engine/optIns';
import { codePointLength } from '../engine/text';
import { clip, EXCERPT_MAX, NAME_MAX } from '../invite/envelope';
import type { Relay } from '../net/relay';

/** The page format this app writes and reads. */
export const PAGE_VERSION = 1;

/** How long the relay keeps each copy of a page: its 30-day blob retention (ADR-0057). */
export const PAGE_TTL_DAYS = 30;

/** A copy this many relay minutes old is posted again: 7 days, well inside {@link PAGE_TTL_DAYS}. */
export const REFRESH_MINUTES = 7 * DAY_MINUTES;

/** A door link's own form: `#door/`, with no slash after `#`, as an invite's `#join/` (spec §3). */
export const DOOR_PREFIX = '#door/';

/** A door that is open: what anyone with the link reads. */
export interface OpenPage {
  readonly v: typeof PAGE_VERSION;
  readonly open: true;
  /** The group's name, cut to 120 code points and "…". */
  readonly name: string;
  /** The first section of the group's Document as plain text, cut to 280 code points and "…". */
  readonly excerpt: string;
  /** How many people are in the group, only when the group chose to show it. */
  readonly count?: number;
  /** The X25519 key applications are sealed to, in unpadded base64url. */
  readonly box: string;
}

/**
 * A door that has closed. A final one has closed for good (#288): its keys
 * never open it again, so readers let no copy after it reopen it.
 */
export interface ClosedPage {
  readonly v: typeof PAGE_VERSION;
  readonly open: false;
  /** Present, and true, only on a page that closes its door for good. */
  readonly final?: true;
}

/** One copy of a door's page. */
export type DoorPage = OpenPage | ClosedPage;

/** The page of a door closed for good (#288): every door that stood and can't open again shows it. */
export const FINAL: ClosedPage = { v: PAGE_VERSION, open: false, final: true };

/** True for a page that closes its door for good. */
export function isFinal(page: DoorPage): boolean {
  return !page.open && page.final === true;
}

/** What a door link shows: the page, or that the door is closed. */
export type DoorView =
  { readonly kind: 'open'; readonly page: OpenPage } | { readonly kind: 'closed' };

/** What reading a door needs: the relay and the seal, and nothing of the group's. */
export interface DoorReader {
  readonly relay: Pick<Relay, 'getBlobs'>;
  readonly seal: Seal;
}

/** What posting a page needs, too: the relay's PUT. */
export interface DoorPublisher {
  readonly relay: Pick<Relay, 'getBlobs' | 'putBlob'>;
  readonly seal: Seal;
}

/** 32 bytes in 43 unpadded base64url characters. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** The 32 bytes `text` spells in canonical unpadded base64url, or null. */
export function keyIn(text: string): Uint8Array | null {
  if (!KEY_TEXT.test(text)) return null;
  const bytes = fromBase64url(text);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return base64url(bytes) === text ? bytes : null;
}

/**
 * A new front door, as the opt-in composer proposes it: two fresh secrets
 * made on this device, which travel only inside the group's sealed log.
 */
export function newFrontDoor(showCount: boolean): FrontDoor {
  const { sign, box } = newDoorSecrets();
  return { sign: base64url(sign), box: base64url(box), showCount };
}

/** The door's address, its Ed25519 public key, which its `sign` secret makes. */
export function addressOf(door: Pick<FrontDoor, 'sign'>): Uint8Array {
  return publicKeyOf(fromBase64url(door.sign));
}

/** The link to post: the app's origin, then the door's address after `#door/`. */
export function doorLinkOf(origin: string, address: Uint8Array): string {
  return `${origin}/${DOOR_PREFIX}${base64url(address)}`;
}

/** What follows `#door/`, as the door's 32-byte address, or null for anything else. */
export function parseDoorPayload(payload: string): Uint8Array | null {
  return keyIn(payload);
}

/** The fragment of `text` when it's an absolute URL, else null. */
export function fragmentOf(text: string): string | null {
  try {
    return new URL(text).hash;
  } catch {
    return null;
  }
}

/**
 * The door a pasted or opened link names, or null: the whole link from any
 * origin, its fragment alone, or the bare 43-character address.
 */
export function parseDoorLink(text: string): Uint8Array | null {
  const trimmed = text.trim();
  const fragment = fragmentOf(trimmed) ?? trimmed;
  if (!fragment.startsWith('#')) return parseDoorPayload(fragment);
  return fragment.startsWith(DOOR_PREFIX)
    ? parseDoorPayload(fragment.slice(DOOR_PREFIX.length))
    : null;
}

/** `plain`, or its first 280 code points, then "…". */
export function excerptOf(plain: string): string {
  return clip(plain, EXCERPT_MAX);
}

/**
 * The page `door` shows for `state`: the group's name, its first section as
 * plain text (`plainText` turns its Markdown into words, as the invite
 * preview does), the box key, and the member count only when `showCount`.
 */
export function pageFor(
  state: Pick<GroupState, 'name' | 'atoms' | 'members'>,
  door: FrontDoor,
  plainText: (markdown: string) => string,
): OpenPage {
  const { boxPublic } = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box));
  return {
    v: PAGE_VERSION,
    open: true,
    name: clip(state.name, NAME_MAX),
    excerpt: excerptOf(plainText(state.atoms[0]?.text ?? '')),
    ...(door.showCount ? { count: state.members.length } : {}),
    box: base64url(boxPublic),
  };
}

/** A closed page's fields, in the order a copy writes them. */
function closedJson(page: ClosedPage) {
  return page.final === true ? { v: page.v, open: false, final: true } : { v: page.v, open: false };
}

/** `page` as the bytes a copy signs: compact JSON, its keys in a fixed order. */
export function encodePage(page: DoorPage): Uint8Array<ArrayBuffer> {
  const json = page.open
    ? {
        v: page.v,
        open: true,
        name: page.name,
        excerpt: page.excerpt,
        ...(page.count === undefined ? {} : { count: page.count }),
        box: page.box,
      }
    : closedJson(page);
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
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

/** Text of at most `max` code points and a "…". */
function textUpTo(value: unknown, max: number): value is string {
  return typeof value === 'string' && codePointLength(value) <= max + 1;
}

/** The keys of an open page, with and without its count, sorted. */
const OPEN_KEYS = 'box,excerpt,name,open,v';
const COUNTED_KEYS = 'box,count,excerpt,name,open,v';

/** Whether `value` is a count: a whole number from 0. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The open page `json` spells, or null. */
function openIn(json: Record<string, unknown>, keys: string): OpenPage | null {
  const { name, excerpt, count, box } = json;
  const counted = keys === COUNTED_KEYS;
  if (!counted && keys !== OPEN_KEYS) return null;
  if (!textUpTo(name, NAME_MAX) || !textUpTo(excerpt, EXCERPT_MAX)) return null;
  if (typeof box !== 'string' || keyIn(box) === null) return null;
  if (counted && !isCount(count)) return null;
  const page = { v: PAGE_VERSION, open: true, name, excerpt, box } as const;
  return counted ? { ...page, count: count as number } : page;
}

/** The closed page `json` spells: its two fields, or those and `final: true` (#288), or null. */
function closedIn(json: Record<string, unknown>, keys: string): ClosedPage | null {
  if (keys === 'open,v') return { v: PAGE_VERSION, open: false };
  return keys === 'final,open,v' && json.final === true ? { ...FINAL } : null;
}

/**
 * The page `bytes` spell, or null: anything but exactly an open page's
 * fields, with or without a count, or a closed page's two, with or without
 * `final: true`, of format 1, is refused, so nothing beside them reaches a
 * screen.
 */
export function parsePage(bytes: Uint8Array): DoorPage | null {
  const json = objectIn(bytes);
  if (json === null || json.v !== PAGE_VERSION) return null;
  const keys = Object.keys(json).sort().join();
  if (json.open === false) return closedIn(json, keys);
  return json.open === true ? openIn(json, keys) : null;
}

/** The page inside a sealed copy's record, when the door at `address` signed it and it parses. */
export function openPage(record: Uint8Array, address: Uint8Array): DoorPage | null {
  const bytes = openDoorRecord(record, address);
  return bytes === null ? null : parsePage(bytes);
}

/** One copy of a page, with the relay minute it arrived. */
export interface PageCopy {
  readonly seq: number;
  readonly received: number;
  readonly page: DoorPage;
}

/**
 * The copy readers go by, of those in the door's page mailbox that the door
 * signed and that parse: the newest final one, when any is, whatever comes
 * after it (#288); else the last in relay order; undefined for none. So
 * once a door has closed for good, no copy anyone posts later, a replay of
 * an old open one (#277) or one forged with the door's key by someone who
 * left, opens it again.
 *
 * @throws {Error} when the relay can't be reached or answers wrongly.
 */
export async function latestCopy(
  { relay, seal }: DoorReader,
  address: Uint8Array,
): Promise<PageCopy | undefined> {
  const { page: mailbox, pageKey } = doorChannelsOf(address);
  const { records } = await relay.getBlobs(mailbox, 0);
  let latest: PageCopy | undefined;
  let final: PageCopy | undefined;
  for (const { seq, received, data } of records) {
    const record = seal.open(mailbox, pageKey, data);
    const page = record && openPage(record, address);
    if (!page) continue;
    latest = { seq, received, page };
    if (isFinal(page)) final = latest;
  }
  return final ?? latest;
}

/**
 * What the door at `address` shows: its last valid copy's page while that
 * says open, and closed for a closed page or no valid copy at all.
 *
 * @throws {Error} when the relay can't be reached or answers wrongly.
 */
export async function readDoor(reader: DoorReader, address: Uint8Array): Promise<DoorView> {
  const page = (await latestCopy(reader, address))?.page;
  return page?.open === true ? { kind: 'open', page } : { kind: 'closed' };
}

/**
 * Whether `copy`, the one readers go by, already serves for `page` at relay
 * minute `now`: an open page it says, or a final one (#288), while under
 * {@link REFRESH_MINUTES} old, so a door closed for good stays so as long as
 * the group goes on; and for a plain closed page, any copy that doesn't say
 * open, none included, since a door with no copy reads as closed already.
 */
function isCurrent(copy: PageCopy | undefined, page: DoorPage, now: number): boolean {
  if (!page.open && !isFinal(page)) return copy?.page.open !== true;
  if (copy === undefined) return false;
  const same = base64url(encodePage(copy.page)) === base64url(encodePage(page));
  return same && now - copy.received < REFRESH_MINUTES;
}

/** How publishing went: posted now, or the copy found current, with the minute it arrived. */
export type PublishOutcome =
  { readonly kind: 'posted' } | { readonly kind: 'current'; readonly received: number };

/**
 * Posts `page` as the door's next copy, signed with its key, unless the
 * newest copy already serves for it at relay minute `now` (`isCurrent`).
 *
 * @throws {Error} when the relay can't be reached or refuses the post.
 */
export async function publishPage(
  publisher: DoorPublisher,
  door: FrontDoor,
  page: DoorPage,
  now: number,
): Promise<PublishOutcome> {
  const { signing } = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box));
  const copy = await latestCopy(publisher, signing.publicKey);
  if (isCurrent(copy, page, now)) return { kind: 'current', received: copy?.received ?? now };
  const { page: mailbox, pageKey } = doorChannelsOf(signing.publicKey);
  const record = signDoorRecord(signing, encodePage(page));
  const blob = publisher.seal.seal(mailbox, pageKey, record);
  await publisher.relay.putBlob(mailbox, blob, PAGE_TTL_DAYS);
  return { kind: 'posted' };
}
