/**
 * What a public shelf record says (#484; ADR-0081; docs/spec/listed-doors.md
 * §4.1): its body, written as compact UTF-8 JSON in a fixed key order, and
 * signed as `crypto/shelf.ts` says.
 *
 * Four kinds come from a listed door's `sign` key in this slice:
 *
 * - an open `listing`: the group's name (1 to 120 code points), its skeleton
 *   and the hash of the covenant it accepted;
 * - a final `listing`, once the door has closed;
 * - an `entry`: a Dispatch's id, title (1 to 80 code points) and text (at
 *   most 500), with no name, author, count or time of its own;
 * - a `withdraw`, naming an entry's id.
 *
 * The steward signs the fifth kind, a `notice` (#488, #489, §6.1):
 * `{v, kind, act, address?, id?, clause?, on?}`, naming exactly what its act
 * acts on:
 *
 * - `release`: the `address` it releases;
 * - `hold`: an `address` and a `clause`, and an entry's `id` when it holds
 *   one entry rather than the whole listing;
 * - `uphold`: an `address`, an entry's `id` and a `clause`;
 * - `suspend`: an `address` and a `clause`;
 * - `unsuspend` (#490): the `address` whose suspension it lifts, and no
 *   clause, since lifting one names no breach;
 * - `pause`: `on`, true to pause the shelf and false to end the pause. §6.1
 *   says a pause is "on or off" and §4.1 had no field for it, so #489 adds
 *   `on`, on a pause only.
 *
 * A body with any other key, or one missing, reads as none: a reader never
 * guesses at what a signer meant.
 */
import { canonicalBytes } from '../crypto/base64url';
import { objectIn } from '../crypto/json';
import { signShelfRecord } from '../crypto/shelf';
import type { SigningKeys } from '../crypto/sign';
import { DISPATCH_TEXT_MAX, DISPATCH_TITLE_MAX } from '../engine/dispatches';
import { codePointLength } from '../engine/text';

/** The record format this app writes and reads. */
export const SHELF_VERSION = 1;

/** The longest listed name, in code points. */
export const LISTING_NAME_MAX = 120;

/** The longest entry title, in code points: a Dispatch's. */
export const ENTRY_TITLE_MAX = DISPATCH_TITLE_MAX;

/** The longest entry text, in code points: a Dispatch's. */
export const ENTRY_TEXT_MAX = DISPATCH_TEXT_MAX;

/** The bytes in an id or a covenant hash: a SHA-256, in unpadded base64url. */
const HASH_BYTES = 32;

/** A listed door's record that it is listed: what readers show its entries under. */
export interface OpenListingBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'listing';
  readonly open: true;
  /** The group's name. */
  readonly name: string;
  /** The name reduced so that look-alikes compare equal (`skeleton.ts`); every fold checks it (#487). */
  readonly skeleton: string;
  /** The SHA-256 of the covenant text the group accepted, in unpadded base64url. */
  readonly covenant: string;
}

/** A listed door's last record, once the door has closed. */
export interface FinalListingBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'listing';
  readonly open: false;
  readonly final: true;
}

/** One published Dispatch. */
export interface EntryBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'entry';
  /** The Dispatch's id. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** A door's word that one of its entries comes down. */
export interface WithdrawBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'withdraw';
  /** The entry's id. */
  readonly id: string;
}

/** The steward's word that an address's held listing may show (§6.1). */
export interface ReleaseNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'release';
  /** The address it releases. */
  readonly address: string;
}

/** A covenant clause a notice may name (§6.1). */
export type Clause = 'C1' | 'C2' | 'C3';

/** The steward's word that an address's listing, or one of its entries, hides for a while (#489). */
export interface HoldNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'hold';
  /** The listing's address. */
  readonly address: string;
  /** The entry it holds; absent, it holds the whole listing. */
  readonly id?: string;
  readonly clause: Clause;
}

/** The steward's word that an entry broke a clause, and comes down (#489). */
export interface UpholdNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'uphold';
  readonly address: string;
  /** The entry it removes. */
  readonly id: string;
  readonly clause: Clause;
}

/** The steward's word that a listing broke a clause, and comes down with its entries (#489). */
export interface SuspendNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'suspend';
  readonly address: string;
  readonly clause: Clause;
}

/**
 * The steward's word that an address's suspension ends (#490): it may list
 * again, its next listing held until a fresh release.
 */
export interface UnsuspendNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'unsuspend';
  readonly address: string;
}

/** The steward's word that the whole shelf hides (`on`), or shows again (#489). */
export interface PauseNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: 'pause';
  readonly on: boolean;
}

/** A record the steward signs. */
export type NoticeBody =
  | ReleaseNoticeBody
  | HoldNoticeBody
  | UpholdNoticeBody
  | SuspendNoticeBody
  | UnsuspendNoticeBody
  | PauseNoticeBody;

/** Any record a door, or the steward, signs. */
export type ShelfBody = OpenListingBody | FinalListingBody | EntryBody | WithdrawBody | NoticeBody;

/** The body as an object whose keys are in the spec's order, so JSON keeps it. */
function ordered(body: ShelfBody): ShelfBody {
  const { v, kind } = body;
  switch (kind) {
    case 'listing':
      return body.open
        ? { v, kind, open: true, name: body.name, skeleton: body.skeleton, covenant: body.covenant }
        : { v, kind, open: false, final: true };
    case 'entry':
      return { v, kind, id: body.id, title: body.title, text: body.text };
    case 'withdraw':
      return { v, kind, id: body.id };
    case 'notice':
      return orderedNotice(body);
  }
}

/** A notice with its keys in the spec's order, leaving out those it lacks. */
function orderedNotice(body: NoticeBody): NoticeBody {
  const { v, kind } = body;
  switch (body.act) {
    case 'release':
    case 'unsuspend':
      return { v, kind, act: body.act, address: body.address };
    case 'hold': {
      const { address, id, clause } = body;
      return { v, kind, act: body.act, address, ...(id === undefined ? {} : { id }), clause };
    }
    case 'uphold':
      return { v, kind, act: body.act, address: body.address, id: body.id, clause: body.clause };
    case 'suspend':
      return { v, kind, act: body.act, address: body.address, clause: body.clause };
    case 'pause':
      return { v, kind, act: body.act, on: body.on };
  }
}

/** `body` as the bytes a door signs: compact JSON, keys in the spec's order, in UTF-8. */
export function encodeShelfBody(body: ShelfBody): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(ordered(body)));
}

/** `body` signed with `keys`, ready to PUT under their address. */
export function signShelfBody(keys: SigningKeys, body: ShelfBody): Uint8Array<ArrayBuffer> {
  return signShelfRecord(keys, encodeShelfBody(body));
}

/** Whether `value` is text of `min` to `max` code points. */
function isText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string') return false;
  const length = codePointLength(value);
  return length >= min && length <= max;
}

/** Whether `value` is a SHA-256 in canonical unpadded base64url. */
function isHash(value: unknown): value is string {
  return canonicalBytes(value)?.length === HASH_BYTES;
}

/** Whether `value` is a key in canonical unpadded base64url: 32 bytes, as a hash is. */
const isKey = isHash;

/** Whether `fields` holds exactly `keys`, in any order. */
function hasKeys(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Object.keys(fields);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(fields, key));
}

const OPEN_KEYS = ['v', 'kind', 'open', 'name', 'skeleton', 'covenant'];
const FINAL_KEYS = ['v', 'kind', 'open', 'final'];
const ENTRY_KEYS = ['v', 'kind', 'id', 'title', 'text'];
const WITHDRAW_KEYS = ['v', 'kind', 'id'];
const RELEASE_KEYS = ['v', 'kind', 'act', 'address'];
const ENTRY_HOLD_KEYS = ['v', 'kind', 'act', 'address', 'id', 'clause'];
const ADDRESS_HOLD_KEYS = ['v', 'kind', 'act', 'address', 'clause'];
const PAUSE_KEYS = ['v', 'kind', 'act', 'on'];
const CLAUSES: ReadonlySet<unknown> = new Set<Clause>(['C1', 'C2', 'C3']);

/** Whether `value` is one of the covenant's clauses. */
const isClause = (value: unknown): value is Clause => CLAUSES.has(value);

/** A listing's fields as its body, open or final, or null. */
function listingOf(fields: Readonly<Record<string, unknown>>): ShelfBody | null {
  const { open, name, skeleton, covenant } = fields;
  if (open === false) {
    return hasKeys(fields, FINAL_KEYS) && fields.final === true
      ? { v: SHELF_VERSION, kind: 'listing', open: false, final: true }
      : null;
  }
  const fits =
    open === true &&
    hasKeys(fields, OPEN_KEYS) &&
    isText(name, 1, LISTING_NAME_MAX) &&
    typeof skeleton === 'string' &&
    isHash(covenant);
  return fits ? { v: SHELF_VERSION, kind: 'listing', open, name, skeleton, covenant } : null;
}

/** An entry's fields as its body, or null. */
function entryOf(fields: Readonly<Record<string, unknown>>): EntryBody | null {
  const { id, title, text } = fields;
  const fits =
    hasKeys(fields, ENTRY_KEYS) &&
    isHash(id) &&
    isText(title, 1, ENTRY_TITLE_MAX) &&
    isText(text, 0, ENTRY_TEXT_MAX);
  return fits ? { v: SHELF_VERSION, kind: 'entry', id, title, text } : null;
}

/** A withdraw's fields as its body, or null. */
function withdrawOf(fields: Readonly<Record<string, unknown>>): WithdrawBody | null {
  const { id } = fields;
  return hasKeys(fields, WITHDRAW_KEYS) && isHash(id)
    ? { v: SHELF_VERSION, kind: 'withdraw', id }
    : null;
}

/** A release's or an unsuspend's fields as its body, or null: each names an address alone. */
function addressOnlyOf(
  fields: Readonly<Record<string, unknown>>,
  act: 'release' | 'unsuspend',
): ReleaseNoticeBody | UnsuspendNoticeBody | null {
  const { address } = fields;
  return hasKeys(fields, RELEASE_KEYS) && isKey(address)
    ? { v: SHELF_VERSION, kind: 'notice', act, address }
    : null;
}

/** A pause's fields as its body, or null. */
function pauseOf(fields: Readonly<Record<string, unknown>>): PauseNoticeBody | null {
  const { on } = fields;
  return hasKeys(fields, PAUSE_KEYS) && typeof on === 'boolean'
    ? { v: SHELF_VERSION, kind: 'notice', act: 'pause', on }
    : null;
}

/** A hold's fields as its body, of an entry or a whole listing, or null. */
function holdOf(fields: Readonly<Record<string, unknown>>): HoldNoticeBody | null {
  const { address, id, clause } = fields;
  if (!isKey(address) || !isClause(clause)) return null;
  if (hasKeys(fields, ADDRESS_HOLD_KEYS)) {
    return { v: SHELF_VERSION, kind: 'notice', act: 'hold', address, clause };
  }
  return hasKeys(fields, ENTRY_HOLD_KEYS) && isHash(id)
    ? { v: SHELF_VERSION, kind: 'notice', act: 'hold', address, id, clause }
    : null;
}

/** An uphold's fields as its body, or null. */
function upholdOf(fields: Readonly<Record<string, unknown>>): UpholdNoticeBody | null {
  const { address, id, clause } = fields;
  const fits = hasKeys(fields, ENTRY_HOLD_KEYS) && isKey(address) && isHash(id) && isClause(clause);
  return fits ? { v: SHELF_VERSION, kind: 'notice', act: 'uphold', address, id, clause } : null;
}

/** A suspend's fields as its body, or null. */
function suspendOf(fields: Readonly<Record<string, unknown>>): SuspendNoticeBody | null {
  const { address, clause } = fields;
  const fits = hasKeys(fields, ADDRESS_HOLD_KEYS) && isKey(address) && isClause(clause);
  return fits ? { v: SHELF_VERSION, kind: 'notice', act: 'suspend', address, clause } : null;
}

/** A notice's fields as its body, by its act, or null for an act it doesn't know. */
function noticeOf(fields: Readonly<Record<string, unknown>>): NoticeBody | null {
  switch (fields.act) {
    case 'release':
    case 'unsuspend':
      return addressOnlyOf(fields, fields.act);
    case 'hold':
      return holdOf(fields);
    case 'uphold':
      return upholdOf(fields);
    case 'suspend':
      return suspendOf(fields);
    case 'pause':
      return pauseOf(fields);
    default:
      return null;
  }
}

/**
 * The body in a verified record's message, or null for anything but exactly
 * one of the five kinds, in this version, with every field in bounds.
 */
export function parseShelfBody(message: Uint8Array): ShelfBody | null {
  const fields = objectIn(message);
  if (fields?.v !== SHELF_VERSION) return null;
  switch (fields.kind) {
    case 'listing':
      return listingOf(fields);
    case 'entry':
      return entryOf(fields);
    case 'withdraw':
      return withdrawOf(fields);
    case 'notice':
      return noticeOf(fields);
    default:
      return null;
  }
}
