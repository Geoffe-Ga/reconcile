/**
 * Group events: the envelope, its exact bytes and its id (docs/spec/phase-1-spec.md §4).
 *
 * An author serializes an event once with `JSON.stringify` to UTF-8. Those
 * exact bytes are what travels, and the id is the unpadded base64url SHA-256
 * of them, so nobody ever re-encodes an event (ADR-0073).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

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

/** Joins the group under a name fixed at join. */
export interface JoinBody {
  readonly name: string;
}

/** Proposes new text for one Atom, with a title, a justification and an optional discussion link. */
export interface ProposalBody {
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link?: string;
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
  readonly vote: VoteBody;
}

/** The event types this engine understands. */
export type EventType = keyof EventBodies;

/** What an author supplies to write an event; `createEvent` adds `v`. */
export type EventInput = {
  readonly [K in EventType]: {
    readonly type: K;
    readonly group: string;
    readonly author: string;
    readonly ts: number;
    readonly body: EventBodies[K];
  };
}[EventType];

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

type Json = Readonly<Record<string, unknown>>;

const encoder = new TextEncoder();
// fatal: invalid UTF-8 throws. ignoreBOM: a leading BOM is kept, so JSON.parse rejects it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The id of an event: the unpadded base64url SHA-256 of its exact bytes. */
export function eventId(bytes: Uint8Array): string {
  return base64url(sha256(bytes));
}

/** A random author id: 16 random bytes in base64url. */
// STUB(identity): #69 replaces this with the member's per-group Ed25519 public key.
export function stubAuthorId(): string {
  return base64url(randomBytes(16));
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

/** Stub author ids and #69's public keys are both non-empty base64url. */
function isAuthor(value: unknown): value is string {
  return isString(value) && BASE64URL.test(value);
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
  return isString(body.name) ? { name: body.name } : null;
}

function parseProposal(body: Json): ProposalBody | null {
  const { atom, title, why, text, link } = body;
  if (!isString(atom) || !isString(title) || !isString(why) || !isString(text)) return null;
  if (!isOptionalString(link)) return null;
  return { atom, title, why, text, ...(link === undefined ? {} : { link }) };
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

/** Attaches a validated body to the envelope fields, or returns null for an unknown type or bad body. */
function withBody(
  head: Omit<GroupEvent, 'type' | 'body'>,
  type: unknown,
  body: Json,
): GroupEvent | null {
  switch (type) {
    case 'genesis': {
      const parsed = parseGenesis(body);
      return parsed === null ? null : { ...head, type, body: parsed };
    }
    case 'join': {
      const parsed = parseJoin(body);
      return parsed === null ? null : { ...head, type, body: parsed };
    }
    case 'proposal': {
      const parsed = parseProposal(body);
      return parsed === null ? null : { ...head, type, body: parsed };
    }
    case 'vote': {
      const parsed = parseVote(body);
      return parsed === null ? null : { ...head, type, body: parsed };
    }
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
