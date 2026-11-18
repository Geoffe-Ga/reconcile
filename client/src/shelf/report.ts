/**
 * Reports and appeals to the steward (#490; ADR-0081; docs/spec/listed-doors.md
 * §6.3), from a reader's or a member's device.
 *
 * - **A report** is `{address, id, clause, note?}` as compact UTF-8 JSON: the
 *   listing's address, the entry's id, the covenant clause and, when the
 *   reader wrote one, a note of up to {@link NOTE_MAX} code points. Nothing
 *   about the reader, and no reply path: the steward can't answer it, and no
 *   one can tie it to who sent it but by the IP address any request comes
 *   from.
 * - **An appeal** is `{address, id?, note}`, signed with the listed door's
 *   key under the appeal tag (`crypto/shelf.ts`): the signature, then the
 *   JSON. The door's key is what the group already signs its public records
 *   with, so an appeal says no more than the listing does about who sent it.
 *
 * Each goes to the steward's inbox, derived from the steward's pinned box
 * key, as one padded box sealed to that key under a label of its own, kept
 * {@link STEWARD_TTL_DAYS} days with no `wake`, as a front door's
 * application is. Every one is {@link STEWARD_BLOB_SIZE} bytes, whatever its
 * note, so the relay, which reads neither, can't tell a report from an appeal
 * or a long note from none. With no steward pinned, nothing is sent.
 *
 * Neither hides or flags anything on any device: each only fills the
 * steward's queue (`inbox.ts`), and no device counts them.
 */
import { base64url, canonicalBytes, fromBase64url } from '../crypto/base64url';
import { doorKeysOf, sealPadded } from '../crypto/door';
import { objectIn } from '../crypto/json';
import { SIGNATURE_BYTES } from '../crypto/sign';
import {
  APPEAL_INFO,
  REPORT_INFO,
  signAppeal,
  stewardInboxOf,
  verifyAppeal,
} from '../crypto/shelf';
import { codePointLength } from '../engine/text';
import type { FrontDoor } from '../engine/optIns';
import type { Relay } from '../net/relay';
import type { Clause } from './record';
import { STEWARD_PINS, type StewardPins } from './steward';

/** The longest note a report carries, in code points. */
export const NOTE_MAX = 500;

/** The longest note an appeal carries, in code points: a report's. */
export const APPEAL_NOTE_MAX = NOTE_MAX;

/** How long the relay keeps a report or an appeal: a front door application's 30 days. */
export const STEWARD_TTL_DAYS = 30;

/**
 * The one size of every report and appeal's box, in bytes. The longest of
 * either, a note of 500 code points each escaped to six bytes, is under
 * 3,300 bytes, so every one fits; the smallest blob, 1,024, would let a
 * note's length show.
 */
export const STEWARD_BLOB_SIZE = 4096;

/** A 32-byte key or hash, in unpadded base64url: an address or an entry's id. */
const HASH_BYTES = 32;

const CLAUSES: ReadonlySet<unknown> = new Set<Clause>(['C1', 'C2', 'C3']);

/** What a reader reports: the entry, by its listing's address and its id, a clause and a note. */
export interface Report {
  readonly address: string;
  readonly id: string;
  readonly clause: Clause;
  readonly note?: string;
}

/** What a held or suspended group asks the steward: its address, maybe an entry, and why. */
export interface Appeal {
  readonly address: string;
  /** The held entry it's about, or none for the whole listing. */
  readonly id?: string;
  readonly note: string;
}

/** Where a report or an appeal goes: the relay, and the pinned keys (the app's unless a test says). */
export interface StewardSendServices {
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly pins?: StewardPins | null;
}

/** Whether `value` is a 32-byte key or hash in canonical unpadded base64url. */
const isHash = (value: unknown): value is string => canonicalBytes(value)?.length === HASH_BYTES;

/** Whether `value` is one of the covenant's clauses. */
const isClause = (value: unknown): value is Clause => CLAUSES.has(value);

/** Whether `value` is text of `min` to `max` code points. */
function isText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string') return false;
  const length = codePointLength(value);
  return length >= min && length <= max;
}

/** Whether `fields` holds exactly `keys`. */
function hasKeys(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Object.keys(fields);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(fields, key));
}

/** `value` as compact UTF-8 JSON. */
const jsonBytes = (value: unknown): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(JSON.stringify(value)));

/** A note as it's sent: trimmed and in NFC. */
const cleaned = (note: string): string => note.trim().normalize('NFC');

/** `report` as the bytes it's sealed as: its keys in a fixed order, `note` only when it has one. */
export function encodeReport(report: Report): Uint8Array<ArrayBuffer> {
  const { address, id, clause, note } = report;
  return jsonBytes({ address, id, clause, ...(note === undefined ? {} : { note }) });
}

/** `appeal` as the bytes its door signs: its keys in a fixed order, `id` only when it names one. */
export function encodeAppeal(appeal: Appeal): Uint8Array<ArrayBuffer> {
  const { address, id, note } = appeal;
  return jsonBytes({ address, ...(id === undefined ? {} : { id }), note });
}

/**
 * The report `bytes` spell, or null for anything but exactly an address, an
 * entry id, a clause and, maybe, a note of at most 500 code points.
 */
export function parseReport(bytes: Uint8Array): Report | null {
  const fields = objectIn(bytes);
  if (fields === null) return null;
  const { address, id, clause, note } = fields;
  if (!isHash(address) || !isHash(id) || !isClause(clause)) return null;
  if (hasKeys(fields, ['address', 'id', 'clause'])) return { address, id, clause };
  const fits = hasKeys(fields, ['address', 'id', 'clause', 'note']) && isText(note, 0, NOTE_MAX);
  return fits ? { address, id, clause, note } : null;
}

/** The appeal a verified message spells, or null. */
function parseAppeal(bytes: Uint8Array): Appeal | null {
  const fields = objectIn(bytes);
  if (fields === null) return null;
  const { address, id, note } = fields;
  if (!isHash(address) || !isText(note, 1, APPEAL_NOTE_MAX)) return null;
  if (hasKeys(fields, ['address', 'note'])) return { address, note };
  return hasKeys(fields, ['address', 'id', 'note']) && isHash(id) ? { address, id, note } : null;
}

/** The address an appeal's message names, unverified, or null: what its signature is checked against. */
function claimedAddress(record: Uint8Array): string | null {
  const address = objectIn(record.subarray(SIGNATURE_BYTES))?.address;
  return isHash(address) ? address : null;
}

/**
 * The appeal in an opened box's plaintext, or null: anything but a signature
 * that verifies against the address the appeal itself names, over an appeal
 * in bounds, is dropped.
 */
export function openAppeal(plaintext: Uint8Array): Appeal | null {
  const address = claimedAddress(plaintext);
  const message = address === null ? null : verifyAppeal(plaintext, address);
  return message === null ? null : parseAppeal(message);
}

/** Seals `plaintext` under `info` to the steward and PUTs it to the inbox: sent, or failed. */
async function sendToSteward(
  services: StewardSendServices,
  plaintext: Uint8Array,
  info: string,
): Promise<'sent' | 'failed'> {
  const pins = services.pins === undefined ? STEWARD_PINS : services.pins;
  if (pins === null) return 'failed';
  try {
    const box = fromBase64url(pins.box);
    const inbox = stewardInboxOf(box);
    const blob = sealPadded(box, plaintext, info, inbox, STEWARD_BLOB_SIZE);
    await services.relay.putBlob(inbox, blob, STEWARD_TTL_DAYS);
    return 'sent';
  } catch {
    return 'failed';
  }
}

/**
 * Report this entry: sends `report`, its note trimmed and in NFC and left
 * out when blank. `failed`, with nothing sent, for a note past
 * {@link NOTE_MAX} code points or with no steward pinned, and when the relay
 * can't be reached.
 */
export function sendReport(
  services: StewardSendServices,
  report: Report,
): Promise<'sent' | 'failed'> {
  const note = cleaned(report.note ?? '');
  if (codePointLength(note) > NOTE_MAX) return Promise.resolve('failed');
  const { address, id, clause } = report;
  const plain = encodeReport({ address, id, clause, ...(note === '' ? {} : { note }) });
  return sendToSteward(services, plain, REPORT_INFO);
}

/**
 * Ask the steward to look again: sends an appeal about `door`'s listing, or
 * its entry `id`, signed with the door's key, its note trimmed and in NFC.
 * `failed`, with nothing sent, for a blank note or one past
 * {@link APPEAL_NOTE_MAX}, with no steward pinned, and when the relay can't
 * be reached. Who may appeal is the screen's to say (`app/appeal.ts`).
 */
export function sendAppeal(
  services: StewardSendServices,
  door: FrontDoor,
  values: { readonly id?: string; readonly note: string },
): Promise<'sent' | 'failed'> {
  const note = cleaned(values.note);
  if (!isText(note, 1, APPEAL_NOTE_MAX)) return Promise.resolve('failed');
  const keys = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box)).signing;
  const address = base64url(keys.publicKey);
  const appeal = { address, ...(values.id === undefined ? {} : { id: values.id }), note };
  return sendToSteward(services, signAppeal(keys, encodeAppeal(appeal)), APPEAL_INFO);
}
