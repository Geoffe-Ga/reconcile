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
 * The steward signs the fifth kind, a `notice` (#488, §6.1):
 * `{v, kind, act, address?, id?, clause?}`. A `release` names exactly the
 * address it releases. Every later act (`hold`, `uphold`, `suspend` and
 * `pause`) reads back as a stub, its fields checked but none required, and
 * the fold ignores it until #489 folds it.
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

/** The acts #489 folds: each parses now, and is ignored until then. */
export type LaterAct = 'hold' | 'uphold' | 'suspend' | 'pause';

/** A covenant clause a notice may name (§6.1). */
export type Clause = 'C1' | 'C2' | 'C3';

/** A later notice (#489): what it names, as far as it names it. */
export interface LaterNoticeBody {
  readonly v: typeof SHELF_VERSION;
  readonly kind: 'notice';
  readonly act: LaterAct;
  readonly address?: string;
  readonly id?: string;
  readonly clause?: Clause;
}

/** A record the steward signs. */
export type NoticeBody = ReleaseNoticeBody | LaterNoticeBody;

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
  return body.act === 'release'
    ? { v: body.v, kind: body.kind, act: body.act, address: body.address }
    : orderedLater(body);
}

/** A later notice with its keys in the spec's order, leaving out those it lacks. */
function orderedLater(body: LaterNoticeBody): LaterNoticeBody {
  const { v, kind, act, address, id, clause } = body;
  return {
    v,
    kind,
    act,
    ...(address === undefined ? {} : { address }),
    ...(id === undefined ? {} : { id }),
    ...(clause === undefined ? {} : { clause }),
  };
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
const NOTICE_KEYS: ReadonlySet<string> = new Set(['v', 'kind', 'act', 'address', 'id', 'clause']);
const LATER_ACTS: ReadonlySet<unknown> = new Set<LaterAct>(['hold', 'uphold', 'suspend', 'pause']);
const CLAUSES: ReadonlySet<unknown> = new Set<Clause>(['C1', 'C2', 'C3']);

/** Whether `value` is an act #489 folds. */
const isLaterAct = (value: unknown): value is LaterAct => LATER_ACTS.has(value);

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

/** A release's fields as its body, or null. */
function releaseOf(fields: Readonly<Record<string, unknown>>): ReleaseNoticeBody | null {
  const { address } = fields;
  return hasKeys(fields, RELEASE_KEYS) && isKey(address)
    ? { v: SHELF_VERSION, kind: 'notice', act: 'release', address }
    : null;
}

/** Whether `value` is absent, or passes `check`. */
const absentOr = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || check(value);

/**
 * A later notice's fields as its body, or null (#489's stub): an act it
 * knows, keys it knows, and each field it has well formed.
 */
function laterOf(fields: Readonly<Record<string, unknown>>): LaterNoticeBody | null {
  const { act, address, id, clause } = fields;
  const fits =
    Object.keys(fields).every((key) => NOTICE_KEYS.has(key)) &&
    absentOr(address, isKey) &&
    absentOr(id, isHash) &&
    absentOr(clause, isClause);
  if (!fits || !isLaterAct(act)) return null;
  return orderedLater({
    v: SHELF_VERSION,
    kind: 'notice',
    act,
    ...(typeof address === 'string' ? { address } : {}),
    ...(typeof id === 'string' ? { id } : {}),
    ...(isClause(clause) ? { clause } : {}),
  });
}

/** A notice's fields as its body: a release, a later act, or null. */
function noticeOf(fields: Readonly<Record<string, unknown>>): NoticeBody | null {
  return fields.act === 'release' ? releaseOf(fields) : laterOf(fields);
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
