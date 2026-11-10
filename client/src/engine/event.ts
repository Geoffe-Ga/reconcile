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
import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { signRecord, verifyRecord } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';

export { base64url, fromBase64url } from '../crypto/base64url';

/** The only envelope version this engine understands. The fold ignores any other. */
export const EVENT_VERSION = 1;

/** A score on one version: 0 (strongly opposed) to 4 (strongly supportive). */
export type Score = 0 | 1 | 2 | 3 | 4;

/** The highest score, the top of the scale the consent meter's average bar spans. */
export const SCORE_MAX = 4;

/**
 * Founds a group with its first Document and its founding rules. Carries
 * `group: ""`, as it can't contain its own hash. `rules` is kept as written:
 * the fold checks it against `DEFAULT_RULES` (rules.ts), and a genesis without
 * it takes every default.
 */
export interface GenesisBody {
  readonly name: string;
  readonly chat?: string;
  readonly founder: string;
  readonly title: string;
  readonly atoms: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
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
 * Proposes new text for one Atom, with a title, a justification, an optional
 * discussion link and an optional voting window in whole days (#106). The
 * window is kept as written: the fold checks it against the bounds of the
 * Proposal's class, and a Proposal without one runs the class default.
 */
export interface ProposalBody {
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link?: string;
  readonly window?: number;
}

/**
 * A steward seat a Proposal fills or empties (ADR-0049, #102): its member is the
 * nominee, or null for a recall of whoever holds `seat`. The fold checks the
 * seat and the member.
 */
export interface StewardTarget {
  readonly kind: 'steward';
  readonly seat: number;
  readonly member: string | null;
}

/**
 * Elects or recalls a steward (#102): an ordinary Proposal with a title, a
 * justification and an optional discussion link, whose target is a seat. It
 * carries no text, so its ballot has one version, under the Proposal's id.
 */
export interface StewardProposalBody {
  readonly target: StewardTarget;
  readonly title: string;
  readonly why: string;
  readonly link?: string;
}

/** What a `proposal` event carries: new text for an Atom, or a steward seat (#102). */
export type ProposalEventBody = ProposalBody | StewardProposalBody;

/** True when a Proposal's body targets a steward seat rather than an Atom. */
export function isStewardProposal(body: ProposalEventBody): body is StewardProposalBody {
  return 'target' in body;
}

/**
 * Suspends a member at once, for the group's `suspensionDays` (ADR-0016,
 * #102), with an optional reason everyone in the group reads. The fold checks
 * that the author may suspend them.
 */
export interface SuspendBody {
  readonly member: string;
  readonly reason?: string;
}

/**
 * Adds a competing wording to an open Proposal's ballot (ADR-0004). Its id is
 * its event id; the Proposal's own text is version 1, under the Proposal's id.
 */
export interface VersionBody {
  readonly proposal: string;
  readonly text: string;
}

/**
 * Scores the versions of one Proposal, keyed by version id, with one optional
 * note. `salt` is 16 random bytes in base64url (#111), so nobody can test
 * guesses against a result's commitment once the ballots are gone. A ballot
 * cast before #111 has none, and enters the commitment with an empty salt.
 */
export interface VoteBody {
  readonly proposal: string;
  readonly scores: Readonly<Record<string, Score>>;
  readonly note?: string;
  readonly salt?: string;
}

/** How many ballots gave a version each score, from 0 to 4. */
export type ScoreCounts = readonly [number, number, number, number, number];

/** One version's line in a result: its id and its counts. */
export interface ResultVersion {
  readonly id: string;
  readonly counts: ScoreCounts;
}

/** A decided Proposal's outcome as its result names it, without the bar, which its class sets. */
export type RecordedOutcome =
  | { readonly kind: 'pass'; readonly version: string }
  | { readonly kind: 'fail' }
  | { readonly kind: 'lapse' };

/**
 * A decided Proposal's signed record (#111, ADR-0017): when it closed (the
 * early close's minute, or its deadline), the size of its eligible set, each
 * version's counts in ballot order, the outcome, and `commit`, a commitment
 * to the counted ballots (`commit.ts`) that never covers notes (ADR-0065).
 * Devices keep it, and only it, once they clear the ballots.
 */
export interface ResultBody {
  readonly proposal: string;
  readonly closedAt: number;
  readonly eligible: number;
  readonly versions: readonly ResultVersion[];
  readonly outcome: RecordedOutcome;
  readonly commit: string;
}

/** The body each event type carries. */
export interface EventBodies {
  readonly genesis: GenesisBody;
  readonly join: JoinBody;
  readonly proposal: ProposalEventBody;
  readonly version: VersionBody;
  readonly vote: VoteBody;
  readonly level: LevelBody;
  readonly suspend: SuspendBody;
  readonly result: ResultBody;
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

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isWholeNumber(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isScore(value: unknown): value is Score {
  return isWholeNumber(value) && value >= 0 && value <= SCORE_MAX;
}

/** A public key's 43 base64url characters. The record's key must also match it exactly. */
function isAuthor(value: unknown): value is string {
  return isString(value) && AUTHOR.test(value);
}

function isTimestamp(value: unknown): value is number {
  return isWholeNumber(value) && value >= 0;
}

function isOptionalObject(value: unknown): value is Json | undefined {
  return value === undefined || isObject(value);
}

function parseGenesis(body: Json): GenesisBody | null {
  const { name, chat, founder, title, atoms, rules } = body;
  if (!isString(name) || !isString(founder) || !isString(title)) return null;
  if (!isStringList(atoms) || !isOptionalString(chat) || !isOptionalObject(rules)) return null;
  return {
    name,
    founder,
    title,
    atoms,
    ...(chat === undefined ? {} : { chat }),
    ...(rules === undefined ? {} : { rules }),
  };
}

function parseJoin(body: Json): JoinBody | null {
  const { name, level } = body;
  if (!isString(name) || !isOptionalString(level)) return null;
  return { name, ...(level === undefined ? {} : { level }) };
}

function parseLevel(body: Json): LevelBody | null {
  return isString(body.level) ? { level: body.level } : null;
}

/** A steward target's kind, seat and member, or null for any other shape (#102). */
function parseStewardTarget(value: unknown): StewardTarget | null {
  if (!isObject(value) || value.kind !== 'steward') return null;
  const { seat, member } = value;
  if (!isWholeNumber(seat) || (member !== null && !isString(member))) return null;
  return { kind: 'steward', seat, member };
}

/** A steward Proposal carries `target` and no `atom`; any `text` or `window` is dropped (#102, #106). */
function parseStewardProposal(body: Json): StewardProposalBody | null {
  const { atom, target, title, why, link } = body;
  const parsed = parseStewardTarget(target);
  if (parsed === null || atom !== undefined || !isString(title) || !isString(why)) return null;
  if (!isOptionalString(link)) return null;
  return { target: parsed, title, why, ...(link === undefined ? {} : { link }) };
}

function parseProposal(body: Json): ProposalEventBody | null {
  if (body.target !== undefined) return parseStewardProposal(body);
  const { atom, title, why, text, link, window } = body;
  if (!isString(atom) || !isString(title) || !isString(why) || !isString(text)) return null;
  if (!isOptionalString(link) || !isOptionalNumber(window)) return null;
  return {
    atom,
    title,
    why,
    text,
    ...(link === undefined ? {} : { link }),
    ...(window === undefined ? {} : { window }),
  };
}

function parseSuspend(body: Json): SuspendBody | null {
  const { member, reason } = body;
  if (!isString(member) || !isOptionalString(reason)) return null;
  return { member, ...(reason === undefined ? {} : { reason }) };
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
  const { proposal, note, salt } = body;
  const scores = parseScores(body.scores);
  if (!isString(proposal) || scores === null || !isOptionalString(note)) return null;
  if (!isOptionalString(salt)) return null;
  return {
    proposal,
    scores,
    ...(note === undefined ? {} : { note }),
    ...(salt === undefined ? {} : { salt }),
  };
}

function isCount(value: unknown): value is number {
  return isWholeNumber(value) && value >= 0;
}

/** Five whole numbers of at least 0: how many ballots gave a version each score. */
function parseCounts(value: unknown): ScoreCounts | null {
  if (!Array.isArray(value) || value.length !== SCORE_MAX + 1) return null;
  const list: readonly unknown[] = value;
  const [n0, n1, n2, n3, n4] = list;
  const whole = isCount(n0) && isCount(n1) && isCount(n2) && isCount(n3) && isCount(n4);
  return whole ? [n0, n1, n2, n3, n4] : null;
}

function parseResultVersion(value: unknown): ResultVersion | null {
  if (!isObject(value) || !isString(value.id)) return null;
  const counts = parseCounts(value.counts);
  return counts === null ? null : { id: value.id, counts };
}

/** Every version a result lists, in order, or null when the list or any version is malformed. */
function parseResultVersions(value: unknown): ResultVersion[] | null {
  if (!Array.isArray(value)) return null;
  const list: readonly unknown[] = value;
  const versions: ResultVersion[] = [];
  for (const item of list) {
    const version = parseResultVersion(item);
    if (version === null) return null;
    versions.push(version);
  }
  return versions;
}

function parseOutcome(value: unknown): RecordedOutcome | null {
  if (!isObject(value)) return null;
  const { kind, version } = value;
  if (kind === 'pass') return isString(version) ? { kind, version } : null;
  return kind === 'fail' || kind === 'lapse' ? { kind } : null;
}

function parseResult(body: Json): ResultBody | null {
  const { proposal, closedAt, eligible, commit } = body;
  if (!isString(proposal) || !isTimestamp(closedAt) || !isCount(eligible)) return null;
  const versions = parseResultVersions(body.versions);
  const outcome = parseOutcome(body.outcome);
  if (versions === null || outcome === null || !isString(commit)) return null;
  return { proposal, closedAt, eligible, versions, outcome, commit };
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
    case 'suspend':
      return attach(parseSuspend(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'result':
      return attach(parseResult(body), (parsed) => ({ ...head, type, body: parsed }));
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
