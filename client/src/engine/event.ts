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
import { base64url, fromBase64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { signRecord, verifyRecord } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';

export { base64url, fromBase64url } from '../crypto/base64url';

/** The only envelope version this engine understands. The fold ignores any other. */
export const EVENT_VERSION = 1;

/** A score on one version: 0 (strongly opposed) to 4 (strongly supportive). */
export type Score = 0 | 1 | 2 | 3 | 4;

/** The lowest score, which needs a reason; the guide (#91) reads the scale's ends from here. */
export const SCORE_MIN = 0;

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
  /** The founder's X25519 public key in base64url (#98), when the genesis carries a well-shaped one. */
  readonly kx?: string;
}

/** One member group's seat in a coalition (#100): its name there, and its public seat key in base64url. */
export interface SeatEntry {
  readonly name: string;
  readonly key: string;
}

/**
 * Founds a coalition (#100): a group genesis body, rules included, with no
 * founder, since its author isn't a participant, plus the seats of the groups
 * that reconcile. Carries `group: ""` like a group's genesis. The fold checks
 * that the seats hold two or more distinct keys.
 */
export interface CoalitionGenesisBody {
  readonly kind: 'coalition';
  readonly name: string;
  readonly chat?: string;
  readonly title: string;
  readonly atoms: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly seats: readonly SeatEntry[];
}

/** True when a genesis founds a coalition rather than a group (#100). */
export function isCoalitionGenesis(
  body: GenesisBody | CoalitionGenesisBody,
): body is CoalitionGenesisBody {
  return 'kind' in body;
}

/**
 * Joins the group under a name fixed at join, at an involvement level. The
 * level is kept as written: the fold reads a missing one as Collaborator and
 * ignores a join that names a level it doesn't know. A coalition's join (#100)
 * names the seat its author comes from and carries the seat's proof instead,
 * and the fold reads neither level, token nor kx there.
 */
export interface JoinBody {
  readonly name: string;
  readonly level?: string;
  /** The inviter's token from the invite link (#73), when the join carries a well-shaped one. */
  readonly token?: InviteToken;
  /** The joiner's X25519 public key in base64url (#98), when the join carries a well-shaped one. */
  readonly kx?: string;
  /** A coalition's seat key in base64url (#100), when the join carries a well-shaped one. */
  readonly seat?: string;
  /** That seat's proof for the joiner's key in base64url (#100, `crypto/seat.ts`), when well-shaped. */
  readonly proof?: string;
}

/**
 * An inviter's token (#73): their public key and their signature over the
 * group id's UTF-8 under the invite-token tag, both in unpadded base64url. The
 * fold names the inviter only when it verifies and `by` joined first; a token
 * that doesn't never invalidates the join.
 */
export interface InviteToken {
  readonly by: string;
  readonly sig: string;
}

/** Sets the author's own involvement level (ADR-0021: self-selected). The fold checks the id. */
export interface LevelBody {
  readonly level: string;
}

/**
 * The Dispatch a Proposal carries (#112): a title and a short text, kept as
 * written. The fold checks their lengths, and sends it to the whole group when
 * the Proposal's pass is final.
 */
export interface CarriedDispatch {
  readonly title: string;
  readonly text: string;
}

/**
 * Proposes new text for one Atom, with a title, a justification, an optional
 * discussion link, an optional voting window in whole days (#106) and an
 * optional Dispatch to send if it passes (#112). Empty text proposes removing
 * the Atom (#75). The window is kept as written: the fold checks it against
 * the bounds of the Proposal's class, and a Proposal without one runs the
 * class default.
 */
export interface ProposalBody {
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link?: string;
  readonly window?: number;
  readonly dispatch?: CarriedDispatch;
}

/**
 * Where an add puts its new section (#75): right after the Atom `after`, or
 * first when it's null. The new Atom's id is the Proposal's own id.
 */
export interface AddTarget {
  readonly kind: 'add';
  readonly after: string | null;
}

/**
 * Proposes a new section (#75): it carries `target` in place of an Atom, its
 * text, and, like an edit, an optional voting window in whole days (#106) and
 * an optional Dispatch to send if it passes (#112).
 */
export interface AddProposalBody {
  readonly target: AddTarget;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link?: string;
  readonly window?: number;
  readonly dispatch?: CarriedDispatch;
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
 * justification, an optional discussion link and an optional Dispatch to send
 * if it passes (#112), whose target is a seat. It carries no text, so its
 * ballot has one version, under the Proposal's id.
 */
export interface StewardProposalBody {
  readonly target: StewardTarget;
  readonly title: string;
  readonly why: string;
  readonly link?: string;
  readonly dispatch?: CarriedDispatch;
}

/**
 * An opt-in a rules Proposal sets (ADR-0040, #117), and the value it would
 * set. Both are kept as written: the fold checks the opt-in and runs its
 * validator on the value (optIns.ts).
 */
export interface RulesTarget {
  readonly kind: 'rules';
  readonly optIn: string;
  readonly value: unknown;
}

/**
 * Turns an opt-in on or off, or replaces the chat bot's webhook (#117): a
 * Proposal with a title, a justification, an optional discussion link and an
 * optional voting window in whole days (#106), whose target is an opt-in.
 * Like a steward Proposal, it carries no text, so its ballot has one version,
 * under the Proposal's id.
 */
export interface RulesProposalBody {
  readonly target: RulesTarget;
  readonly title: string;
  readonly why: string;
  readonly link?: string;
  readonly window?: number;
  /** A Dispatch to send if it passes (#112). */
  readonly dispatch?: CarriedDispatch;
}

/**
 * Dissolving the group (ADR-0051, ADR-0072 §10, #108): `wipe` is true when
 * the vote also asks every device to erase its copy, a week after the dissolve.
 */
export interface DissolveTarget {
  readonly kind: 'dissolve';
  readonly wipe: boolean;
}

/**
 * Proposes dissolving the group (#108): an entrenched Proposal with a title,
 * a justification, an optional discussion link and an optional voting window
 * in whole days, whose target says whether to wipe. It carries no text, so
 * its ballot has one version, under the Proposal's id.
 */
export interface DissolveProposalBody {
  readonly target: DissolveTarget;
  readonly title: string;
  readonly why: string;
  readonly link?: string;
  readonly window?: number;
  /** A Dispatch to send if it passes (#112). */
  readonly dispatch?: CarriedDispatch;
}

/**
 * Reconciling with other groups into a coalition (#100; ADR-0036): the
 * coalition secret its mailbox derives from; `inner`, 32 random bytes that
 * followers never get, which #125's room and #122's higher seats derive from;
 * this group's 32-byte Ed25519 seat secret; and the coalition's proposed name
 * and founding statement. Each secret is 32 bytes in canonical base64url, and
 * lives only in this group's sealed log.
 */
export interface ReconcileTarget {
  readonly kind: 'reconcile';
  readonly secret: string;
  readonly inner: string;
  readonly seat: string;
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
}

/**
 * Proposes reconciling into a coalition (#100): an ordinary Proposal with a
 * title, a justification, an optional discussion link and an optional voting
 * window in whole days, whose target carries the coalition's secrets and
 * statement. It carries no text, so its ballot has one version, under the
 * Proposal's id. Like any of the group's own Proposals, it may carry a
 * Dispatch to the group if it passes (#112).
 */
export interface ReconcileProposalBody {
  readonly target: ReconcileTarget;
  readonly title: string;
  readonly why: string;
  readonly link?: string;
  readonly window?: number;
  /** A Dispatch to send if it passes (#112). */
  readonly dispatch?: CarriedDispatch;
}

/**
 * What a `proposal` event carries: new text for an Atom, a new section (#75),
 * a steward seat (#102), an opt-in (#117), dissolving the group (#108), or
 * reconciling into a coalition (#100).
 */
export type ProposalEventBody =
  | ProposalBody
  | AddProposalBody
  | StewardProposalBody
  | RulesProposalBody
  | DissolveProposalBody
  | ReconcileProposalBody;

/** True when a Proposal's body targets a steward seat rather than an Atom or an opt-in. */
export function isStewardProposal(body: ProposalEventBody): body is StewardProposalBody {
  return 'target' in body && body.target.kind === 'steward';
}

/** True when a Proposal's body adds a new section (#75). */
export function isAddProposal(body: ProposalEventBody): body is AddProposalBody {
  return 'target' in body && body.target.kind === 'add';
}

/** True when a Proposal's body targets an opt-in (#117). */
export function isRulesProposal(body: ProposalEventBody): body is RulesProposalBody {
  return 'target' in body && body.target.kind === 'rules';
}

/** True when a Proposal's body proposes dissolving the group (#108). */
export function isDissolveProposal(body: ProposalEventBody): body is DissolveProposalBody {
  return 'target' in body && body.target.kind === 'dissolve';
}

/** True when a Proposal's body proposes reconciling into a coalition (#100). */
export function isReconcileProposal(body: ProposalEventBody): body is ReconcileProposalBody {
  return 'target' in body && body.target.kind === 'reconcile';
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
 * Turns an opt-in off at once (ADR-0040, ADR-0075 §3, #117), beside the
 * author's own open off-Proposal for it, until that Proposal closes. The fold
 * checks that the author is a steward who may narrow it (stewards.ts).
 */
export interface NarrowBody {
  readonly optIn: string;
  readonly proposal: string;
}

/**
 * Vouches for a newcomer (ADR-0014, #101): the author says they've met or
 * talked with the member it names. Everyone in the group sees it. The fold checks that
 * the author may vouch, and for whom.
 */
export interface VouchBody {
  readonly member: string;
}

/**
 * Claims one notice of the chat bot (#119): `moment` of `proposal`, which the
 * author's device will post to the group's Discord webhook if its claim is
 * the first. Both are kept as written: the fold checks them (chatPosts.ts).
 * `nonce` is random, so two devices holding one key (#78) never sign the same
 * bytes, and each can tell its own claim by its id. The fold doesn't read it.
 */
export interface ChatPostedBody {
  readonly proposal: string;
  readonly moment: string;
  readonly nonce?: string;
}

/**
 * Records that the author sent an invite to someone who asked to join at the
 * group's front door (#121; ADR-0038): `application` is the SHA-256, in
 * unpadded base64url, of the sealed application blob the relay holds, so
 * everyone sees who invited them and nobody sends a second. Kept as written:
 * the fold checks it (frontDoor.ts).
 */
export interface DoorInvitedBody {
  readonly application: string;
}

/**
 * Records a Proposal's Discord thread (#123): `url` is the link to the
 * forum thread the author's device opened with the Proposal's first notice.
 * Both are kept as written: the fold checks them (chatPosts.ts).
 */
export interface ChatThreadBody {
  readonly proposal: string;
  readonly url: string;
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

/**
 * Ends the group once a dissolve Proposal's pass is final (#108): any member's
 * device that folds that pass posts one. The fold takes the first valid one,
 * and ignores every event after it.
 */
export interface DissolveBody {
  readonly proposal: string;
}

/**
 * Leaves the group (ADR-0010: exit is always possible). It carries nothing:
 * the author is the one who leaves, and the fold reads any object as `{}`.
 */
export type LeaveBody = Readonly<Record<string, never>>;

/**
 * A Dispatch a Co-Creator sends to the whole group (#112): a title, a short
 * text and, optionally, the id of a Document it points to. All are kept as
 * written: the fold checks the sender, the lengths and the Document.
 */
export interface DispatchBody {
  readonly title: string;
  readonly text: string;
  readonly doc?: string;
}

/**
 * Gives a member who has none an encryption key (#98): the X25519 public key,
 * in base64url, that the group's new secrets are wrapped to. A device that
 * joined before #98 posts it once; the fold keeps the first per member.
 */
export interface KxBody {
  readonly kx: string;
}

/**
 * A new group key (#98; ADR-0072 item 11): epoch `epoch`'s commit, and its
 * secret wrapped to each member who has an encryption key, by their `author`
 * (`crypto/epoch.ts`). The fold keeps the first valid one per epoch.
 */
export interface KeyRotateBody {
  readonly epoch: number;
  readonly commit: string;
  readonly wraps: Readonly<Record<string, string>>;
}

/** A member group's decision on a coalition motion, the one thing that crosses group lines (ADR-0036). */
export type GroupResultValue = 'pass' | 'fail';

/**
 * A member group's result on a coalition motion, or on the coalition's
 * genesis (#100): exactly the motion's id, the seat key and `pass` or
 * `fail`. A body with any other key is a bad shape, so no ballot, score,
 * count, note or name can ride along.
 */
export interface GroupResultBody {
  readonly motion: string;
  readonly seat: string;
  readonly result: GroupResultValue;
}

/** The body each event type carries. */
export interface EventBodies {
  readonly genesis: GenesisBody | CoalitionGenesisBody;
  readonly join: JoinBody;
  readonly proposal: ProposalEventBody;
  readonly version: VersionBody;
  readonly vote: VoteBody;
  readonly level: LevelBody;
  readonly leave: LeaveBody;
  readonly suspend: SuspendBody;
  readonly narrow: NarrowBody;
  readonly result: ResultBody;
  readonly dissolve: DissolveBody;
  readonly vouch: VouchBody;
  readonly 'chat-posted': ChatPostedBody;
  readonly 'chat-thread': ChatThreadBody;
  readonly dispatch: DispatchBody;
  readonly kx: KxBody;
  readonly 'key-rotate': KeyRotateBody;
  readonly 'door-invited': DoorInvitedBody;
  readonly 'group-result': GroupResultBody;
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

/** A 64-byte Ed25519 signature in unpadded base64url. */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

/** Unpadded base64url of at least one byte: a wrap's text. */
const BASE64URL = /^[A-Za-z0-9_-]{2,}$/;

/** The largest epoch a key change names: a big-endian u32 carries it (#98). */
const MAX_EPOCH = 0xffff_ffff;

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
  return isWholeNumber(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

/** A public key's 43 base64url characters. The record's key must also match it exactly. */
function isAuthor(value: unknown): value is string {
  return isString(value) && AUTHOR.test(value);
}

/**
 * 32 bytes in canonical unpadded base64url: an X25519 key or a SHA-256 digest
 * (#98). The last character's spare bits must be zero, so each key has one spelling.
 */
function isKey32(value: unknown): value is string {
  return isAuthor(value) && base64url(fromBase64url(value)) === value;
}

function isTimestamp(value: unknown): value is number {
  return isWholeNumber(value) && value >= 0;
}

function isOptionalObject(value: unknown): value is Json | undefined {
  return value === undefined || isObject(value);
}

/** A well-shaped `kx` field as `{kx}`, or nothing: a bad key never sinks the event that carries it (#98). */
function kxField(value: unknown): { readonly kx?: string } {
  return isKey32(value) ? { kx: value } : {};
}

/** A seat's name and key, or null for any other shape (#100). */
function parseSeat(value: unknown): SeatEntry | null {
  if (!isObject(value)) return null;
  const { name, key } = value;
  return isString(name) && isKey32(key) ? { name, key } : null;
}

/** A list of well-shaped seats, or null when it isn't a list or any seat is badly shaped (#100). */
function parseSeats(value: unknown): SeatEntry[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parseSeat);
  return parsed.every((seat) => seat !== null) ? parsed : null;
}

/** A coalition genesis: a group genesis body without its founder, plus its seats (#100). */
function parseCoalitionGenesis(body: Json): CoalitionGenesisBody | null {
  const { kind, name, chat, title, atoms, rules } = body;
  const seats = parseSeats(body.seats);
  if (kind !== 'coalition' || !isString(name) || !isString(title) || !isStringList(atoms)) {
    return null;
  }
  if (!isOptionalString(chat) || !isOptionalObject(rules) || seats === null) return null;
  return {
    kind,
    name,
    title,
    atoms,
    seats,
    ...(chat === undefined ? {} : { chat }),
    ...(rules === undefined ? {} : { rules }),
  };
}

function parseGenesis(body: Json): GenesisBody | CoalitionGenesisBody | null {
  if (body.kind !== undefined) return parseCoalitionGenesis(body);
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
    ...kxField(body.kx),
  };
}

/** A well-shaped invite token, or undefined for none or anything else: a bad token never sinks a join. */
function parseToken(value: unknown): InviteToken | undefined {
  if (!isObject(value)) return undefined;
  const { by, sig } = value;
  return isAuthor(by) && isString(sig) && SIGNATURE.test(sig) ? { by, sig } : undefined;
}

/** A well-shaped seat and proof on a join, each as its own field, or nothing (#100). */
function seatFields(body: Json): { readonly seat?: string; readonly proof?: string } {
  const { seat, proof } = body;
  return {
    ...(isKey32(seat) ? { seat } : {}),
    ...(isString(proof) && SIGNATURE.test(proof) ? { proof } : {}),
  };
}

function parseJoin(body: Json): JoinBody | null {
  const { name, level } = body;
  if (!isString(name) || !isOptionalString(level)) return null;
  const token = parseToken(body.token);
  return {
    name,
    ...(level === undefined ? {} : { level }),
    ...(token === undefined ? {} : { token }),
    ...kxField(body.kx),
    ...seatFields(body),
  };
}

function parseLevel(body: Json): LevelBody | null {
  return isString(body.level) ? { level: body.level } : null;
}

/** An add's target, keeping only its kind and anchor, or null for any other shape (#75). */
function parseAddTarget(value: unknown): AddTarget | null {
  if (!isObject(value) || value.kind !== 'add') return null;
  const { after } = value;
  return after === null || isString(after) ? { kind: 'add', after } : null;
}

/** An add carries `target` in place of `atom`, never both, its text, and any window (#75, #106). */
function parseAddProposal(body: Json): AddProposalBody | null {
  const { atom, target, title, why, text } = body;
  const parsed = parseAddTarget(target);
  if (parsed === null || atom !== undefined || !isString(text)) return null;
  if (!isString(title) || !isString(why)) return null;
  const options = editOptions(body);
  return options === null ? null : { target: parsed, title, why, text, ...options };
}

/** A steward target's kind, seat and member, or null for any other shape (#102). */
function parseStewardTarget(value: unknown): StewardTarget | null {
  if (!isObject(value) || value.kind !== 'steward') return null;
  const { seat, member } = value;
  if (!isWholeNumber(seat) || (member !== null && !isString(member))) return null;
  return { kind: 'steward', seat, member };
}

/** A rules target's kind, opt-in and value, the value kept as written, or null for any other shape (#117). */
function parseRulesTarget(value: unknown): RulesTarget | null {
  if (!isObject(value) || value.kind !== 'rules' || !isString(value.optIn)) return null;
  // JSON has no undefined, so a value that is undefined was left out.
  return value.value === undefined
    ? null
    : { kind: 'rules', optIn: value.optIn, value: value.value };
}

/**
 * A Proposal's `dispatch` (#112) as `{dispatch}`: its title and text, any
 * other key dropped. `{}` when there is none, and null for any other shape,
 * which makes the whole Proposal a bad shape.
 */
function dispatchField(value: unknown): { readonly dispatch?: CarriedDispatch } | null {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const { title, text } = value;
  return isString(title) && isString(text) ? { dispatch: { title, text } } : null;
}

/**
 * What every targeted Proposal carries beside its target: a title, a why, an
 * optional link and an optional Dispatch (#112), and no `atom`.
 */
function parseTargetedFields(body: Json): Omit<StewardProposalBody, 'target'> | null {
  const { atom, title, why, link } = body;
  const carried = dispatchField(body.dispatch);
  if (atom !== undefined || !isString(title) || !isString(why) || !isOptionalString(link)) {
    return null;
  }
  return carried === null
    ? null
    : { title, why, ...(link === undefined ? {} : { link }), ...carried };
}

/** A dissolve target's kind and wipe, which must be true or false (#108). */
function parseDissolveTarget(value: unknown): DissolveTarget | null {
  if (!isObject(value) || value.kind !== 'dissolve') return null;
  return typeof value.wipe === 'boolean' ? { kind: 'dissolve', wipe: value.wipe } : null;
}

/**
 * A rules (#117) or dissolve (#108) Proposal: its target and fields, and the
 * window its proposer chose, if any (#106).
 */
function withWindow<T>(target: T | null, body: Json, fields: Omit<StewardProposalBody, 'target'>) {
  const { window } = body;
  if (target === null || !isOptionalNumber(window)) return null;
  return { ...fields, target, ...(window === undefined ? {} : { window }) };
}

/** A reconcile target's kind, secrets, name, title and Atoms, or null for any other shape (#100). */
function parseReconcileTarget(value: unknown): ReconcileTarget | null {
  if (!isObject(value) || value.kind !== 'reconcile') return null;
  const { secret, inner, seat, name, title, atoms } = value;
  if (!isKey32(secret) || !isKey32(inner) || !isKey32(seat)) return null;
  if (!isString(name) || !isString(title) || !isStringList(atoms)) return null;
  return { kind: 'reconcile', secret, inner, seat, name, title, atoms };
}

/**
 * The target a Proposal names other than a steward seat: an opt-in (#117),
 * dissolving (#108), or reconciling (#100).
 */
function parseWindowedProposal(
  body: Json,
  fields: Omit<StewardProposalBody, 'target'>,
): RulesProposalBody | DissolveProposalBody | ReconcileProposalBody | null {
  const dissolve = parseDissolveTarget(body.target);
  if (dissolve !== null) return withWindow(dissolve, body, fields);
  const reconcile = parseReconcileTarget(body.target);
  if (reconcile !== null) return withWindow(reconcile, body, fields);
  return withWindow(parseRulesTarget(body.target), body, fields);
}

/**
 * A steward (#102), rules (#117), dissolve (#108) or reconcile (#100)
 * Proposal carries `target` and no `atom`; any `text` is dropped, and so is a
 * steward Proposal's `window` (#106).
 */
function parseTargetedProposal(body: Json): Exclude<ProposalEventBody, ProposalBody> | null {
  const fields = parseTargetedFields(body);
  if (fields === null) return null;
  const steward = parseStewardTarget(body.target);
  return steward === null ? parseWindowedProposal(body, fields) : { ...fields, target: steward };
}

/**
 * A Proposal with a `target` in place of an Atom: an add (#75), a steward
 * seat (#102), an opt-in (#117) or dissolving the group (#108).
 */
function parseTargeted(body: Json): ProposalEventBody | null {
  return isObject(body.target) && body.target.kind === 'add'
    ? parseAddProposal(body)
    : parseTargetedProposal(body);
}

/**
 * An edit's or an add's optional fields (#75): a discussion link, a voting
 * window (#106) and a Dispatch (#112), each kept when present, or null when
 * one is a bad shape.
 */
function editOptions(body: Json): Pick<ProposalBody, 'link' | 'window' | 'dispatch'> | null {
  const { link, window } = body;
  const carried = dispatchField(body.dispatch);
  if (!isOptionalString(link) || !isOptionalNumber(window) || carried === null) return null;
  return {
    ...(link === undefined ? {} : { link }),
    ...(window === undefined ? {} : { window }),
    ...carried,
  };
}

function parseProposal(body: Json): ProposalEventBody | null {
  if (body.target !== undefined) return parseTargeted(body);
  const { atom, title, why, text } = body;
  if (!isString(atom) || !isString(title) || !isString(why) || !isString(text)) return null;
  const options = editOptions(body);
  return options === null ? null : { atom, title, why, text, ...options };
}

function parseSuspend(body: Json): SuspendBody | null {
  const { member, reason } = body;
  if (!isString(member) || !isOptionalString(reason)) return null;
  return { member, ...(reason === undefined ? {} : { reason }) };
}

function parseDissolve(body: Json): DissolveBody | null {
  return isString(body.proposal) ? { proposal: body.proposal } : null;
}

function parseNarrow(body: Json): NarrowBody | null {
  const { optIn, proposal } = body;
  return isString(optIn) && isString(proposal) ? { optIn, proposal } : null;
}

function parseVouch(body: Json): VouchBody | null {
  return isString(body.member) ? { member: body.member } : null;
}

function parseChatPosted(body: Json): ChatPostedBody | null {
  const { proposal, moment, nonce } = body;
  if (!isString(proposal) || !isString(moment) || !isOptionalString(nonce)) return null;
  return { proposal, moment, ...(nonce === undefined ? {} : { nonce }) };
}

function parseChatThread(body: Json): ChatThreadBody | null {
  const { proposal, url } = body;
  return isString(proposal) && isString(url) ? { proposal, url } : null;
}

function parseDispatch(body: Json): DispatchBody | null {
  const { title, text, doc } = body;
  if (!isString(title) || !isString(text) || !isOptionalString(doc)) return null;
  return { title, text, ...(doc === undefined ? {} : { doc }) };
}

function parseKx(body: Json): KxBody | null {
  return isKey32(body.kx) ? { kx: body.kx } : null;
}

/** A key change's wraps: an object from member keys to base64url wraps, or null. */
function parseWraps(value: unknown): Record<string, string> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  const valid = entries.every(
    ([key, wrap]) => isAuthor(key) && isString(wrap) && BASE64URL.test(wrap),
  );
  // fromEntries defines own properties, so no key can reach a prototype.
  return valid ? Object.fromEntries(entries as [string, string][]) : null;
}

function parseKeyRotate(body: Json): KeyRotateBody | null {
  const { epoch, commit } = body;
  const wraps = parseWraps(body.wraps);
  if (!isWholeNumber(epoch) || epoch < 1 || epoch > MAX_EPOCH) return null;
  return isKey32(commit) && wraps !== null ? { epoch, commit, wraps } : null;
}

function parseDoorInvited(body: Json): DoorInvitedBody | null {
  return isString(body.application) ? { application: body.application } : null;
}

/** The only keys a group-result may carry, so nothing else crosses group lines (#100). */
const RESULT_KEYS = ['motion', 'result', 'seat'];

/** A group-result with exactly a motion, a seat key and `pass` or `fail`, or null (#100). */
function parseGroupResult(body: Json): GroupResultBody | null {
  const { motion, seat, result } = body;
  const exact = Object.keys(body).sort().join() === RESULT_KEYS.join();
  if (!exact || !isString(motion) || !isKey32(seat)) return null;
  return result === 'pass' || result === 'fail' ? { motion, seat, result } : null;
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

/** An event's envelope fields, apart from its type and body. */
type Head = Omit<GroupEvent, 'type' | 'body'>;

/** Attaches a validated body to the envelope fields, or returns null for an unknown type or bad body. */
function withBody(head: Head, type: unknown, body: Json): GroupEvent | null {
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
    case 'leave':
      return { ...head, type, body: {} };
    default:
      return withLaterBody(head, type, body);
  }
}

/**
 * {@link withBody} for the types the restored features added: `suspend`
 * (#102), `narrow` (#117), `dissolve` (#108), `vouch` (#101), `chat-posted`
 * (#119), `chat-thread` (#123) and `dispatch` (#112).
 */
function withLaterBody(head: Head, type: unknown, body: Json): GroupEvent | null {
  switch (type) {
    case 'suspend':
      return attach(parseSuspend(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'narrow':
      return attach(parseNarrow(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'dissolve':
      return attach(parseDissolve(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'vouch':
      return attach(parseVouch(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'chat-posted':
      return attach(parseChatPosted(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'chat-thread':
      return attach(parseChatThread(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'dispatch':
      return attach(parseDispatch(body), (parsed) => ({ ...head, type, body: parsed }));
    default:
      return withKeyBody(head, type, body);
  }
}

/**
 * {@link withBody} for #98's types, `kx` and `key-rotate`, #100's
 * `group-result`, #111's `result`, and #121's `door-invited`.
 */
function withKeyBody(head: Head, type: unknown, body: Json): GroupEvent | null {
  switch (type) {
    case 'kx':
      return attach(parseKx(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'key-rotate':
      return attach(parseKeyRotate(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'group-result':
      return attach(parseGroupResult(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'result':
      return attach(parseResult(body), (parsed) => ({ ...head, type, body: parsed }));
    case 'door-invited':
      return attach(parseDoorInvited(body), (parsed) => ({ ...head, type, body: parsed }));
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
