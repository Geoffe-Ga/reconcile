/**
 * The golden vectors in src/engine/vectors/, read and built into relay records
 * as any reader would: each file is read as text and parsed with `JSON.parse`,
 * because Vite's own JSON loader refuses the lone-surrogate escapes
 * atom-text.json needs. vectors.test.ts runs every one; other engine tests,
 * such as home.test.ts, fold one by name with {@link vector}.
 *
 * - keys.json, `{kind: "keys", seeds: {name: seed}}`, names the signing keys the fold vectors
 *   use, each from a fixed 32-byte seed in hex.
 * - A tally vector is `{name, eligible, bar?, versions, expect}`. `bar` names a class whose
 *   bar `DEFAULT_RULES` holds, `"ordinary"` when missing (#94), and the outcome must equal
 *   `expect` with that bar added.
 * - A fold vector is `{name, records, relayNow, expect, unchangedWithout?}`.
 *   - Each record is `{seq, received, event | raw}`. An `event` is serialized with
 *     `JSON.stringify` as written, so a vector pins exact bytes; `raw` gives the bytes as text.
 *   - A string `"@3"` stands for the id of the record at seq 3, so `"@1.0"` is genesis's first
 *     Atom, and `"%ana"` stands for ana's public key in base64url. `{"$base64url": [bytes]}`
 *     stands for those bytes in unpadded base64url, as invite.json's token signatures are
 *     written, so no high-entropy text sits in the repository.
 *   - The relay record is `publicKey ‖ signature ‖ event bytes` (spec §3), signed by the key
 *     `by` names, or else by the key the event's `"%name"` author names. `key` (hex, or
 *     `"%name"`) and `sig` (hex) replace those fields, and `flip: {in, at}` flips the low bit of
 *     byte `at` of the `key`, `signature` or `event`. `unsigned: true` sends the bare event
 *     bytes, as the stub era did. `elsewhere: true` makes a record of another mailbox: `@seq`
 *     can name it, but it isn't folded.
 *   - `expect` is matched as a subset of the folded state.
 *   - `unchangedWithout` lists seqs whose removal must leave the state, apart from `ignored`,
 *     deep-equal.
 * - invite.json (#73) is a fold file: joins carrying invite tokens, each signed outside @noble.
 * - atom-text.json pins `normalizeAtomText` and the genesis split; atomText.test.ts runs it.
 */
import { EVENT_CONTEXT, publicKeyOf, sign } from '../crypto/sign';
import { base64url, eventId } from '../engine/event';
import type { LogRecord } from '../engine/fold';
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
}

/** How a vector record departs from a plain record signed by its author. */
interface RecordOptions {
  readonly by?: string;
  readonly key?: string;
  readonly sig?: string;
  readonly flip?: { readonly in: 'key' | 'signature' | 'event'; readonly at: number };
  readonly unsigned?: boolean;
  readonly elsewhere?: boolean;
}

type VectorRecord = RecordOptions &
  (
    | { readonly seq: number; readonly received: number; readonly event: unknown }
    | { readonly seq: number; readonly received: number; readonly raw: string }
  );

/** One fold vector: records in relay order, the relay's `now`, and the state they must fold to. */
export interface FoldVector {
  readonly name: string;
  readonly records: readonly VectorRecord[];
  readonly relayNow: number | null;
  readonly expect: object;
  readonly unchangedWithout?: readonly number[];
}

/** One vector file, by its `kind`. */
export type VectorFile =
  | { readonly kind: 'tally'; readonly vectors: readonly TallyVector[] }
  | { readonly kind: 'fold'; readonly vectors: readonly FoldVector[] }
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

/** Replaces `@n` (and `@n.i`) with the id of the record at seq n, and `%name` with name's key. */
function resolveRef(text: string, ids: ReadonlyMap<number, string>): string {
  const key = /^%(\w+)$/.exec(text);
  if (key !== null) return publicKeyNamed(String(key[1]));
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

/**
 * Resolves every `@n` and `%name` reference inside a JSON value, in keys as
 * well as values, and writes each `{"$base64url": [bytes]}` as its text.
 */
export function resolve(value: unknown, ids: ReadonlyMap<number, string>): unknown {
  if (typeof value === 'string') return resolveRef(value, ids);
  if (Array.isArray(value)) return value.map((item: unknown) => resolve(item, ids));
  if (typeof value === 'object' && value !== null) {
    const bytes = base64urlBytes(value);
    if (bytes !== null) return base64url(Uint8Array.from(bytes));
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

/** A fold vector's relay records, the id of each record by seq, and its relay `now`. */
export interface VectorLog {
  readonly records: LogRecord[];
  readonly ids: ReadonlyMap<number, string>;
  readonly relayNow: number | null;
}

/** Turns a vector's records into relay records, serializing each event once, in seq order. */
export function buildRecords(vector: FoldVector): VectorLog {
  const ids = new Map<number, string>();
  const records = vector.records.flatMap((record) => {
    const text = 'raw' in record ? record.raw : JSON.stringify(resolve(record.event, ids));
    const event = encoder.encode(text);
    ids.set(record.seq, eventId(event));
    const bytes = relayBytes(record, event);
    return record.elsewhere === true ? [] : [{ seq: record.seq, received: record.received, bytes }];
  });
  return { records, ids, relayNow: vector.relayNow };
}

/** Every tally vector, file by file. */
export const TALLY_VECTORS: readonly TallyVector[] = Object.values(VECTOR_FILES).flatMap((file) =>
  file.kind === 'tally' ? file.vectors : [],
);

/** Every fold vector, file by file. */
export const FOLD_VECTORS: readonly FoldVector[] = Object.values(VECTOR_FILES).flatMap((file) =>
  file.kind === 'fold' ? file.vectors : [],
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
