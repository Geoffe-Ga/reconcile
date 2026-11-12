/**
 * The golden vectors in src/engine/vectors/, read and built into relay records
 * as any reader would: each file is read as text and parsed with `JSON.parse`,
 * because Vite's own JSON loader refuses the lone-surrogate escapes
 * atom-text.json needs. vectors.test.ts runs every one; other engine tests,
 * such as home.test.ts, fold one by name with {@link vector}.
 *
 * - keys.json, `{kind: "keys", seeds: {name: seed}}`, names the signing keys the fold vectors
 *   use, each from a fixed 32-byte seed in hex.
 * - A tally vector is `{name, eligible, bar?, versions, expect, rank?}`. `bar` names a class
 *   whose bar `DEFAULT_RULES` holds, `"ordinary"` when missing (#94), and the outcome must equal
 *   `expect` with that bar added. `rank`, when present, lists the ids `rank()` gives, best
 *   first (#107).
 * - A fold vector is `{name, cleared?, alsoCleared?, records, relayNow, expect, unchangedWithout?}`.
 *   `cleared` lists the Proposals (by `@seq`) whose ballots the device has cleared (#111), passed
 *   to `fold`. `alsoCleared` lists Proposals whose ballots the records still hold: vectors.test.ts
 *   also folds the log as a device that has cleared them would hold it ({@link clearedLog}), and
 *   `expect` must hold there too, the two states agreeing on everything but the ballots (#289).
 *   - Each record is `{seq, received, event | raw}`. An `event` is serialized with
 *     `JSON.stringify` as written, so a vector pins exact bytes; `raw` gives the bytes as text.
 *   - A string `"@3"` stands for the id of the record at seq 3, so `"@1.0"` is genesis's first
 *     Atom, and `"%ana"` stands for ana's public key in base64url. `"&ana"` stands for ana's
 *     X25519 encryption key (#98) in base64url: the public key of the secret key
 *     SHA-256("reconcile/vector-kx/" + name). `{"$base64url": [bytes]}`
 *     stands for those bytes in unpadded base64url, as invite.json's token signatures and
 *     a result's `commit` (#111) are written, so no high-entropy text sits in the repository.
 *   - The relay record is `publicKey ‖ signature ‖ event bytes` (spec §3), signed by the key
 *     `by` names, or else by the key the event's `"%name"` author names. `key` (hex, or
 *     `"%name"`) and `sig` (hex) replace those fields, and `flip: {in, at}` flips the low bit of
 *     byte `at` of the `key`, `signature` or `event`. `unsigned: true` sends the bare event
 *     bytes, as the stub era did. `elsewhere: true` makes a record of another mailbox: `@seq`
 *     can name it, but it isn't folded. `epoch: n` marks a record read from epoch n's mailbox
 *     (#98); a record without one was read from epoch 0's.
 *   - `expect` is matched as a subset of the folded state.
 *   - `unchangedWithout` lists seqs whose removal must leave the state, apart from `ignored`,
 *     deep-equal. `unchangedExcept` names any other fields left out of that comparison, as a
 *     `recovery-share` (#109) is kept in `recoveryShares` and changes nothing else.
 * - A coalition file (#100), `{kind: "coalition", vectors}`, holds vectors with several logs:
 *   `{name, logs: {coalition: [...], A: [...]}, relayNow, expect: {coalition, A}, report?,
 *   mismatches?, unchangedWithout?}`. Seqs are global, as the relay's one counter is, so `@n`
 *   names a record in any log. vectors.test.ts folds the coalition log, then each other log, a
 *   member group, with the motions its seat is owed (`motionsFor`), and matches `report` and
 *   `mismatches` against `resultsToReport` and `resultMismatches` for that group's seat.
 *   `unchangedWithout` lists, by log, the seqs whose removal must leave every state, apart from
 *   `ignored`, deep-equal. A coalition's references: `"^A"` is seat A's public key and `"!A"`
 *   its 32-byte secret in base64url, from SHA-256("reconcile/vector-seat/" + name); `"~name"` is
 *   32 bytes, SHA-256("reconcile/vector-secret/" + name), in base64url, for a coalition secret or
 *   `inner`; `"&^A"` is seat A's X25519 key, `seatKxOf` of `"!A"` (#313, `crypto/room.ts`); and
 *   `{"$seatProof": ["A", "@1", "%kim"]}` is seat A's proof for kim's key in the coalition whose
 *   genesis is seq 1 (`crypto/seat.ts`).
 * - A room file (#125), `{kind: "room", vectors}`, holds vectors with a coalition's log and its
 *   room's: `{name, logs: {coalition: [...], room: [...]}, relayNow, expect}`, built as a
 *   coalition file's are, so `@n` names a record of either. room.test.ts folds the coalition log,
 *   then `foldRoom` the room's, and matches `expect`, a list of messages, against what it gives.
 * - room-keys.json (#125), `{kind: "room-keys", ...}`, pins a room's derivations and one sealed
 *   message, computed outside @noble; crypto/room.test.ts runs it.
 * - invite.json (#73) is a fold file: joins carrying invite tokens, each signed outside @noble.
 * - atom-text.json pins `normalizeAtomText` and the genesis split; atomText.test.ts runs it.
 */
import { kxPublicKeyOf } from '../crypto/box';
import { sha256 } from '../crypto/hash';
import { seatKxOf } from '../crypto/room';
import { signSeatProof } from '../crypto/seat';
import { EVENT_CONTEXT, publicKeyOf, sign } from '../crypto/sign';
import { base64url, eventId, fromBase64url, parseRecord } from '../engine/event';
import { expiringProposal } from '../engine/expiry';
import type { GroupState, LogRecord } from '../engine/fold';
import type { ProposalClass } from '../engine/rules';
import type { TallyInput, TallyOutcome } from '../engine/tally';
import { concat, fromHex } from './bytes';

/** `Omit` applied to each member of a union, so each outcome kind keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One tally vector: a ballot's sizes and scores, and the outcome they must give. */
export interface TallyVector extends Omit<TallyInput, 'bar'> {
  readonly name: string;
  readonly bar?: ProposalClass;
  /** The outcome without its bar, which the runner adds. */
  readonly expect: DistributiveOmit<TallyOutcome, 'bar'>;
  /** The passing versions' ids, best first, as `rank()` gives them (#107). */
  readonly rank?: readonly string[];
}

/** How a vector record departs from a plain record signed by its author. */
interface RecordOptions {
  readonly by?: string;
  readonly key?: string;
  readonly sig?: string;
  readonly flip?: { readonly in: 'key' | 'signature' | 'event'; readonly at: number };
  readonly unsigned?: boolean;
  readonly elsewhere?: boolean;
  readonly epoch?: number;
}

type VectorRecord = RecordOptions &
  (
    | { readonly seq: number; readonly received: number; readonly event: unknown }
    | { readonly seq: number; readonly received: number; readonly raw: string }
  );

/** One fold vector: records in relay order, the relay's `now`, and the state they must fold to. */
export interface FoldVector {
  readonly name: string;
  readonly cleared?: readonly string[];
  readonly alsoCleared?: readonly string[];
  readonly records: readonly VectorRecord[];
  readonly relayNow: number | null;
  readonly expect: object;
  readonly unchangedWithout?: readonly number[];
  readonly unchangedExcept?: readonly string[];
}

/** One vector with several logs (#100): a coalition's and its member groups', by name. */
export interface LogsVector {
  readonly name: string;
  readonly logs: Readonly<Record<string, readonly VectorRecord[]>>;
  readonly relayNow: number | null;
  readonly expect: Readonly<Record<string, object>>;
  readonly report?: Readonly<Record<string, readonly unknown[]>>;
  readonly mismatches?: Readonly<Record<string, readonly unknown[]>>;
  readonly unchangedWithout?: Readonly<Record<string, readonly number[]>>;
}

/** One room vector (#125): a coalition's log and its room's, and the messages they must show. */
export interface RoomVector {
  readonly name: string;
  readonly logs: Readonly<Record<'coalition' | 'room', readonly VectorRecord[]>>;
  readonly relayNow: number | null;
  readonly expect: readonly object[];
}

/** One vector file, by its `kind`. */
export type VectorFile =
  | { readonly kind: 'tally'; readonly vectors: readonly TallyVector[] }
  | { readonly kind: 'fold'; readonly vectors: readonly FoldVector[] }
  | { readonly kind: 'coalition'; readonly vectors: readonly LogsVector[] }
  | { readonly kind: 'room'; readonly vectors: readonly RoomVector[] }
  | { readonly kind: 'room-keys'; readonly vectors: readonly { readonly name: string }[] }
  | { readonly kind: 'atom-text'; readonly vectors: readonly { readonly name: string }[] }
  | { readonly kind: 'keys'; readonly seeds: Readonly<Record<string, string>> };

const TEXTS = import.meta.glob<string>('../engine/vectors/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Every vector file, by its file name, such as `"fold.json"`. */
export const VECTOR_FILES: Readonly<Record<string, VectorFile>> = Object.fromEntries(
  Object.entries(TEXTS).map(([path, text]) => [
    path.slice(path.lastIndexOf('/') + 1),
    JSON.parse(text) as VectorFile,
  ]),
);

const encoder = new TextEncoder();

/** Each named key's 32-byte seed, in the order keys.json lists them. */
export const SEEDS: ReadonlyMap<string, Uint8Array> = new Map(
  Object.values(VECTOR_FILES).flatMap((file) =>
    file.kind === 'keys'
      ? Object.entries(file.seeds).map(([name, seed]) => [name, fromHex(seed)] as const)
      : [],
  ),
);

/** The seed of the key called `name`. */
function seedOf(name: string): Uint8Array {
  const seed = SEEDS.get(name);
  if (seed === undefined) throw new Error(`a vector names the unknown key "${name}"`);
  return seed;
}

/** The base64url public key of the key called `name`. */
export function publicKeyNamed(name: string): string {
  return base64url(publicKeyOf(seedOf(name)));
}

/** The base64url X25519 public key the vectors call `&name` (#98). */
export function kxNamed(name: string): string {
  return base64url(kxPublicKeyOf(sha256(encoder.encode(`reconcile/vector-kx/${name}`))));
}

/** The 32-byte seat secret the vectors call `!name` (#100). */
export function seatSecretNamed(name: string): Uint8Array {
  return sha256(encoder.encode(`reconcile/vector-seat/${name}`));
}

/** The base64url X25519 key the vectors call `&^name`: seat name's, from its seat secret (#313). */
export function seatKxNamed(name: string): string {
  return seatKxOf(seatSecretNamed(name));
}

/** The 32 bytes the vectors call `~name`: a coalition secret or `inner` (#100). */
function secretNamed(name: string): Uint8Array {
  return sha256(encoder.encode(`reconcile/vector-secret/${name}`));
}

/** The base64url text of the 32 bytes a seat or secret reference (`^`, `!` or `~`) names, or null. */
function seatRef(text: string): string | null {
  const match = /^([\^!~])(\w+)$/.exec(text);
  if (match === null) return null;
  const [, sigil, name = ''] = match;
  if (sigil === '~') return base64url(secretNamed(name));
  const secret = seatSecretNamed(name);
  return base64url(sigil === '!' ? secret : publicKeyOf(secret));
}

/**
 * Replaces `@n` (and `@n.i`) with the id of the record at seq n, `%name` with
 * name's key, `&name` with name's encryption key, `&^name` with seat name's
 * encryption key (#313), and a seat or secret reference with its bytes (#100).
 */
function resolveRef(text: string, ids: ReadonlyMap<number, string>): string {
  const key = /^%(\w+)$/.exec(text);
  if (key !== null) return publicKeyNamed(String(key[1]));
  const kx = /^&(\w+)$/.exec(text);
  if (kx !== null) return kxNamed(String(kx[1]));
  const seatKx = /^&\^(\w+)$/.exec(text);
  if (seatKx !== null) return seatKxNamed(String(seatKx[1]));
  const seat = seatRef(text);
  if (seat !== null) return seat;
  const match = /^@(\d+)(.*)$/.exec(text);
  if (match === null) return text;
  const id = ids.get(Number(match[1]));
  if (id === undefined)
    throw new Error(`a vector refers to seq ${String(match[1])} before it exists`);
  return id + String(match[2]);
}

/** The bytes of `{"$base64url": [bytes]}`, which stands for their unpadded base64url, or null. */
function base64urlBytes(value: object): number[] | null {
  const bytes: unknown =
    Object.entries(value).length === 1 ? Reflect.get(value, '$base64url') : null;
  return Array.isArray(bytes) && bytes.every((byte) => typeof byte === 'number') ? bytes : null;
}

/** The base64url seat proof `{"$seatProof": [seat, coalition, joiner]}` stands for, or null (#100). */
function seatProof(value: object, ids: ReadonlyMap<number, string>): string | null {
  const args: unknown =
    Object.entries(value).length === 1 ? Reflect.get(value, '$seatProof') : null;
  if (!Array.isArray(args) || args.length !== 3) return null;
  const [seat, coalition, joiner] = args.map((arg: unknown) => resolve(arg, ids));
  if (typeof seat !== 'string' || typeof coalition !== 'string' || typeof joiner !== 'string') {
    return null;
  }
  const proof = signSeatProof(seatSecretNamed(seat), coalition, fromBase64url(joiner));
  return base64url(proof);
}

/**
 * Resolves every `@n` and `%name` reference inside a JSON value, in keys as
 * well as values, and writes each `{"$base64url": [bytes]}` and
 * `{"$seatProof": [...]}` as its text.
 */
export function resolve(value: unknown, ids: ReadonlyMap<number, string>): unknown {
  if (typeof value === 'string') return resolveRef(value, ids);
  if (Array.isArray(value)) return value.map((item: unknown) => resolve(item, ids));
  if (typeof value === 'object' && value !== null) {
    const bytes = base64urlBytes(value);
    if (bytes !== null) return base64url(Uint8Array.from(bytes));
    const proof = seatProof(value, ids);
    if (proof !== null) return proof;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [resolveRef(key, ids), resolve(item, ids)]),
    );
  }
  return value;
}

/** The name of the key that signs `record`: `by`, or else the `%name` its event's author gives. */
function signerOf(record: VectorRecord): string {
  const author: unknown = 'event' in record ? (record.event as { author?: unknown }).author : null;
  const named = typeof author === 'string' ? /^%(\w+)$/.exec(author)?.[1] : undefined;
  const signer = record.by ?? named;
  if (signer === undefined)
    throw new Error(`the record at seq ${String(record.seq)} has no signer`);
  return signer;
}

/** A copy of `bytes` with the low bit of byte `at` flipped. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

/** The key field a record carries: its `key` override, or the signer's public key. */
function keyField(record: VectorRecord): Uint8Array {
  if (record.key === undefined) return publicKeyOf(seedOf(signerOf(record)));
  return record.key.startsWith('%')
    ? publicKeyOf(seedOf(record.key.slice(1)))
    : fromHex(record.key);
}

/** The relay record for a vector record's event bytes (spec §3), with any override applied. */
function relayBytes(record: VectorRecord, event: Uint8Array): Uint8Array {
  if (record.unsigned === true) return event;
  const parts = {
    key: keyField(record),
    signature:
      record.sig === undefined
        ? sign(EVENT_CONTEXT, seedOf(signerOf(record)), event)
        : fromHex(record.sig),
    event,
  };
  const { flip } = record;
  const at = flip === undefined ? parts : { ...parts, [flip.in]: flipped(parts[flip.in], flip.at) };
  return concat(at.key, at.signature, at.event);
}

/**
 * A fold vector's relay records, the id of each record by seq, its relay
 * `now`, its `cleared`, and the Proposals it also folds cleared.
 */
export interface VectorLog {
  readonly records: LogRecord[];
  readonly ids: ReadonlyMap<number, string>;
  readonly relayNow: number | null;
  readonly cleared: readonly string[];
  readonly alsoCleared: readonly string[];
}

/**
 * One vector record as a relay record, serialized once with `ids` so far, or
 * none for a record of another mailbox; its id joins `ids`.
 */
function buildRecord(record: VectorRecord, ids: Map<number, string>): LogRecord[] {
  const text = 'raw' in record ? record.raw : JSON.stringify(resolve(record.event, ids));
  const event = encoder.encode(text);
  ids.set(record.seq, eventId(event));
  const bytes = relayBytes(record, event);
  const { seq, received, epoch } = record;
  const read = { seq, received, bytes, ...(epoch === undefined ? {} : { epoch }) };
  return record.elsewhere === true ? [] : [read];
}

/** Turns a vector's records into relay records, serializing each event once, in seq order. */
export function buildRecords(vector: FoldVector): VectorLog {
  const ids = new Map<number, string>();
  const records = vector.records.flatMap((record) => buildRecord(record, ids));
  const cleared = (vector.cleared ?? []).map((ref) => resolveRef(ref, ids));
  const alsoCleared = (vector.alsoCleared ?? []).map((ref) => resolveRef(ref, ids));
  return { records, ids, relayNow: vector.relayNow, cleared, alsoCleared };
}

/**
 * The log as a device holds it once it has cleared `log.alsoCleared` (#111):
 * without the records that expire with each one's ballots, apart from the
 * result `held`, the fold of the full log, accepted for it, and with those
 * Proposals added to `cleared`. Every record left keeps its seq and receipt,
 * as clearing leaves them. Throws for a Proposal with no accepted result,
 * which no device would clear.
 */
export function clearedLog(
  log: VectorLog,
  held: GroupState,
): { records: LogRecord[]; cleared: string[] } {
  const kept = new Set(
    log.alsoCleared.map((id) => {
      const result = held.proposals.find((p) => p.id === id)?.result ?? null;
      if (result === null) throw new Error(`a vector clears ${id}, which has no result`);
      return result.id;
    }),
  );
  const records = log.records.filter((record) => {
    const parsed = parseRecord(record.bytes);
    const proposal = parsed === null ? null : expiringProposal(parsed.event);
    return proposal === null || !log.alsoCleared.includes(proposal) || kept.has(parsed?.id ?? '');
  });
  return { records, cleared: [...log.cleared, ...log.alsoCleared] };
}

/** A vector's logs as relay records by name, and the id of each record by its global seq (#100). */
export interface VectorLogs {
  readonly logs: Readonly<Record<string, LogRecord[]>>;
  readonly ids: ReadonlyMap<number, string>;
}

/**
 * Turns a vector's logs into relay records, building every record in global
 * seq order, so `@n` names a record of any log written before it (#100).
 */
export function buildLogs(vector: Pick<LogsVector, 'logs'>): VectorLogs {
  const ids = new Map<number, string>();
  const tagged = Object.entries(vector.logs).flatMap(([log, records]) =>
    records.map((record) => ({ log, record })),
  );
  tagged.sort((a, b) => a.record.seq - b.record.seq);
  const logs: Record<string, LogRecord[]> = Object.fromEntries(
    Object.keys(vector.logs).map((log) => [log, []]),
  );
  for (const { log, record } of tagged) logs[log]?.push(...buildRecord(record, ids));
  return { logs, ids };
}

/** Every tally vector, file by file. */
export const TALLY_VECTORS: readonly TallyVector[] = Object.values(VECTOR_FILES).flatMap((file) =>
  file.kind === 'tally' ? file.vectors : [],
);

/** Every fold vector, file by file. */
export const FOLD_VECTORS: readonly FoldVector[] = Object.values(VECTOR_FILES).flatMap((file) =>
  file.kind === 'fold' ? file.vectors : [],
);

/** Every vector with several logs, file by file (#100). */
export const COALITION_VECTORS: readonly LogsVector[] = Object.values(VECTOR_FILES).flatMap(
  (file) => (file.kind === 'coalition' ? file.vectors : []),
);

/** Every room vector, file by file (#125). */
export const ROOM_VECTORS: readonly RoomVector[] = Object.values(VECTOR_FILES).flatMap((file) =>
  file.kind === 'room' ? file.vectors : [],
);

/**
 * The fold vector named `name`, or whose name starts with `name:`, as relay
 * records: `vector('two-open-proposals')`.
 */
export function vector(name: string): VectorLog {
  const found = FOLD_VECTORS.find(
    (candidate) => candidate.name === name || candidate.name.startsWith(`${name}:`),
  );
  if (found === undefined) throw new Error(`no fold vector is named "${name}"`);
  return buildRecords(found);
}
