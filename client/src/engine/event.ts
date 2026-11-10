/**
 * Group events: the envelope, its exact bytes, its id and its signed record
 * (docs/spec/phase-1-spec.md §3–§4).
 *
 * An author serializes an event once with `JSON.stringify` to UTF-8. Those
 * exact bytes are what is signed and travels, and the id is the unpadded
 * base64url SHA-256 of them, so nobody ever re-encodes an event (ADR-0073).
 * They travel inside a record, `publicKey ‖ signature ‖ event bytes`, and a
 * reader trusts an event only once its record verifies and its `author` is the
 * key that signed it (ADR-0006).
 */
import { sha256 } from '../crypto/hash';
import { signRecord, verifyRecord } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';

/** The only envelope version this engine understands. The fold ignores any other. */
export const EVENT_VERSION = 1;

/** A score on one version: 0 (strongly opposed) to 4 (strongly supportive). */
export type Score = 0 | 1 | 2 | 3 | 4;

/** Founds a group with its first Document. Carries `group: ""`, as it can't contain its own hash. */
export interface GenesisBody {
  readonly name: string;
  readonly chat?: string;
  readonly founder: string;
  readonly title: string;
  readonly atoms: readonly string[];
}

/**
 * Joins the group under a name fixed at join, at an involvement level. The
 * level is kept as written: the fold reads a missing one as Collaborator and
 * ignores a join that names a level it doesn't know.
 */
export interface JoinBody {
  readonly name: string;
  readonly level?: string;
}

/** Sets the author's own involvement level (ADR-0021: self-selected). The fold checks the id. */
export interface LevelBody {
  readonly level: string;
}

/**
 * Where an add puts its new section (#75): right after the Atom `after`, or
 * first when it's null. The new Atom's id is the Proposal's own id.
 */
export interface AddTarget {
  readonly kind: 'add';
  readonly after: string | null;
}

/** What a Proposal changes: one Atom's text, where `""` removes the Atom, or a new section (#75). */
export type ProposalTarget = { readonly kind: 'edit' } | AddTarget;

/** What every Proposal says: a title, a justification, its text and an optional discussion link. */
interface ProposalFields {
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link?: string;
}

/** Proposes new text for one Atom. An empty text proposes removing it (#75). */
export interface EditProposalBody extends ProposalFields {
  readonly atom: string;
}

/** Proposes a new section, which carries `target` in place of an Atom (#75). */
export interface AddProposalBody extends ProposalFields {
  readonly target: AddTarget;
}

/** A Proposal: an edit of one Atom, or an add. */
export type ProposalBody = EditProposalBody | AddProposalBody;

/** What a Proposal's body targets: the Atom it edits, or where its new section goes. */
export function targetOf(body: ProposalBody): ProposalTarget {
  return 'target' in body ? body.target : { kind: 'edit' };
}

/**
 * Adds a competing wording to an open Proposal's ballot (ADR-0004). Its id is
 * its event id; the Proposal's own text is version 1, under the Proposal's id.
 */
export interface VersionBody {
  readonly proposal: string;
  readonly text: string;
}

/** Scores the versions of one Proposal, keyed by version id, with one optional note. */
export interface VoteBody {
  readonly proposal: string;
  readonly scores: Readonly<Record<string, Score>>;
  readonly note?: string;
}

/** The body each event type carries. */
export interface EventBodies {
  readonly genesis: GenesisBody;
  readonly join: JoinBody;
  readonly proposal: ProposalBody;
  readonly version: VersionBody;
  readonly vote: VoteBody;
  readonly level: LevelBody;
}

/** The event types this engine understands. */
export type EventType = keyof EventBodies;

/** What an author supplies to sign an event; `signEvent` adds `author` from the key, and `v`. */
export type EventDraft = {
  readonly [K in EventType]: {
    readonly type: K;
    readonly group: string;
    readonly ts: number;
    readonly body: EventBodies[K];
  };
}[EventType];

/** What an author supplies to write an event's bytes; `createEvent` adds `v`. */
export type EventInput = EventDraft & { readonly author: string };

/** A well-shaped event as read from its bytes. `ts` is the author's clock in ms, for display only. */
export type GroupEvent = EventInput & { readonly v: number };

/** An event's exact bytes and their id. */
export interface EncodedEvent {
  readonly bytes: Uint8Array;
  readonly id: string;
}

/** An event read back from bytes, with the id of those bytes. */
export interface ParsedEvent {
  readonly event: GroupEvent;
  readonly id: string;
}

/** A signed event: its exact bytes and id, and the record that carries them. */
export interface SignedEvent extends EncodedEvent {
  /** What a device posts and keeps: the author's public key ‖ signature ‖ the event bytes. */
  readonly record: Uint8Array<ArrayBuffer>;
}

type Json = Readonly<Record<string, unknown>>;

const encoder = new TextEncoder();
// fatal: invalid UTF-8 throws. ignoreBOM: a leading BOM is kept, so JSON.parse rejects it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** An author: a 32-byte Ed25519 public key in unpadded base64url. */
const AUTHOR = /^[A-Za-z0-9_-]{43}$/;

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url, with or without padding, to bytes. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The id of an event: the unpadded base64url SHA-256 of its exact bytes. */
export function eventId(bytes: Uint8Array): string {
  return base64url(sha256(bytes));
}

/** Returns `value` with every string inside it, however deeply nested, normalized to NFC. */
function nfcDeep(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(nfcDeep);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nfcDeep(item)]));
  }
  return value;
}

/** Writes an event: NFC-normalizes the body's text, serializes once, and returns the bytes and id. */
export function createEvent(input: EventInput): EncodedEvent {
  const { type, group, author, ts, body } = input;
  const json = JSON.stringify({ v: EVENT_VERSION, type, group, author, ts, body: nfcDeep(body) });
  const bytes = encoder.encode(json);
  return { bytes, id: eventId(bytes) };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isWholeNumber(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isScore(value: unknown): value is Score {
  return isWholeNumber(value) && value >= 0 && value <= 4;
}

/** A public key's 43 base64url characters. The record's key must also match it exactly. */
function isAuthor(value: unknown): value is string {
  return isString(value) && AUTHOR.test(value);
}

function isTimestamp(value: unknown): value is number {
  return isWholeNumber(value) && value >= 0;
}

function parseGenesis(body: Json): GenesisBody | null {
  const { name, chat, founder, title, atoms } = body;
  if (!isString(name) || !isString(founder) || !isString(title)) return null;
  if (!isStringList(atoms) || !isOptionalString(chat)) return null;
  return { name, founder, title, atoms, ...(chat === undefined ? {} : { chat }) };
}

function parseJoin(body: Json): JoinBody | null {
  const { name, level } = body;
  if (!isString(name) || !isOptionalString(level)) return null;
  return { name, ...(level === undefined ? {} : { level }) };
}

function parseLevel(body: Json): LevelBody | null {
  return isString(body.level) ? { level: body.level } : null;
}

/** An add's target, keeping only its kind and anchor, or null for any other shape. */
function parseAddTarget(value: unknown): AddTarget | null {
  if (!isObject(value) || value.kind !== 'add') return null;
  const { after } = value;
  return after === null || isString(after) ? { kind: 'add', after } : null;
}

/** An edit names an `atom`; an add carries `target` instead, never both. */
function parseProposal(body: Json): ProposalBody | null {
  const { atom, target, title, why, text, link } = body;
  if (!isString(title) || !isString(why) || !isString(text)) return null;
  if (!isOptionalString(link)) return null;
  const fields = { title, why, text, ...(link === undefined ? {} : { link }) };
  if (target === undefined) return isString(atom) ? { atom, ...fields } : null;
  const add = parseAddTarget(target);
  return add === null || atom !== undefined ? null : { target: add, ...fields };
}

function parseVersion(body: Json): VersionBody | null {
  const { proposal, text } = body;
  return isString(proposal) && isString(text) ? { proposal, text } : null;
}

function parseScores(value: unknown): Record<string, Score> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  const scores: [string, Score][] = [];
  for (const [version, score] of entries) {
    if (!isScore(score)) return null;
    scores.push([version, score]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays plain data.
  return Object.fromEntries(scores);
}

function parseVote(body: Json): VoteBody | null {
  const { proposal, note } = body;
  const scores = parseScores(body.scores);
  if (!isString(proposal) || scores === null || !isOptionalString(note)) return null;
  return { proposal, scores, ...(note === undefined ? {} : { note }) };
}

/** The event a parsed body makes, or null when the body didn't parse. */
function attach<B>(body: B | null, make: (body: B) => GroupEvent): GroupEvent | null {
  return body === null ? null : make(body);
}

/** Attaches a validated body to the envelope fields, or returns null for an unknown type or bad body. */
function withBody(
  head: Omit<GroupEvent, 'type' | 'body'>,
  type: unknown,
  body: Json,
): GroupEvent | null {
  switch (type) {
    case 'genesis':
      return attach(parseGenesis(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'join':
      return attach(parseJoin(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'proposal':
      return attach(parseProposal(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'version':
      return attach(parseVersion(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'vote':
      return attach(parseVote(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'level':
      return attach(parseLevel(body), (parsed) => ({ ...head, type, body: parsed }));
    default:
      return null;
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value;
  } catch {
    return undefined;
  }
}

/** Reads an event from its bytes, or returns null for bad UTF-8, bad JSON or a bad shape. */
export function decodeEvent(bytes: Uint8Array): GroupEvent | null {
  const raw = parseJson(bytes);
  if (!isObject(raw)) return null;
  const { v, type, group, author, ts, body } = raw;
  if (!isWholeNumber(v) || !isString(group) || !isAuthor(author)) return null;
  if (!isTimestamp(ts) || !isObject(body)) return null;
  return withBody({ v, group, author, ts }, type, body);
}

/** Reads an event and its id from bytes, or returns null for bad UTF-8, bad JSON or a bad shape. */
export function parseEvent(bytes: Uint8Array): ParsedEvent | null {
  const event = decodeEvent(bytes);
  return event === null ? null : { event, id: eventId(bytes) };
}

/**
 * Signs an event with one membership's secret key: its `author` is that key's
 * public half in base64url, and the record carries the exact bytes signed.
 */
export function signEvent(secretKey: Uint8Array, draft: EventDraft): SignedEvent {
  const publicKey = publicKeyOf(secretKey);
  const { bytes, id } = createEvent({ ...draft, author: base64url(publicKey) });
  return { bytes, id, record: signRecord({ publicKey, secretKey }, bytes) };
}

/**
 * Reads a signed record: verifies its signature before parsing anything, then
 * requires the event's `author` to be the key that signed it. Returns null for
 * anything else, so bytes a member didn't sign never claim an event id.
 */
export function parseRecord(record: Uint8Array): ParsedEvent | null {
  const verified = verifyRecord(record);
  if (verified === null) return null;
  const parsed = parseEvent(verified.eventBytes);
  return parsed?.event.author === base64url(verified.publicKey) ? parsed : null;
}
