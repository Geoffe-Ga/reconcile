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
 * The steward's `notice` comes with #488; until then it reads as no record,
 * so the fold ignores it. A body with any other key, or one missing, reads as
 * none either: a reader never guesses at what a signer meant.
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
  /** The name reduced so that look-alikes compare equal; checked from #487. */
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

/** Any record a door signs. */
export type ShelfBody = OpenListingBody | FinalListingBody | EntryBody | WithdrawBody;

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

/** Whether `fields` holds exactly `keys`, in any order. */
function hasKeys(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Object.keys(fields);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(fields, key));
}

const OPEN_KEYS = ['v', 'kind', 'open', 'name', 'skeleton', 'covenant'];
const FINAL_KEYS = ['v', 'kind', 'open', 'final'];
const ENTRY_KEYS = ['v', 'kind', 'id', 'title', 'text'];
const WITHDRAW_KEYS = ['v', 'kind', 'id'];

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

/**
 * The body in a verified record's message, or null for anything but exactly
 * one of the four kinds, in this version, with every field in bounds.
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
    default:
      return null;
  }
}
