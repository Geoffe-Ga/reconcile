/**
 * Golden vectors: the engine's contract (ADR-0073, docs/spec/phase-1-spec.md §3–§5).
 *
 * Each file in vectors/ is `{kind: "tally" | "fold" | "atom-text", vectors: [...]}`, except
 * keys.json. Every file is read as text and parsed with `JSON.parse`, as any reader would,
 * because Vite's own JSON loader refuses the lone-surrogate escapes atom-text.json needs.
 * - keys.json, `{kind: "keys", seeds: {name: seed}}`, names the signing keys the fold vectors
 *   use, each from a fixed 32-byte seed in hex.
 * - A tally vector is `{name, eligible, versions, expect}`.
 * - A fold vector is `{name, records, relayNow, expect, unchangedWithout?}`.
 *   - Each record is `{seq, received, event | raw}`. An `event` is serialized with
 *     `JSON.stringify` as written, so a vector pins exact bytes; `raw` gives the bytes as text.
 *   - A string `"@3"` stands for the id of the record at seq 3, so `"@1.0"` is genesis's first
 *     Atom, and `"%ana"` stands for ana's public key in base64url.
 *   - The relay record is `publicKey ‖ signature ‖ event bytes` (spec §3), signed by the key
 *     `by` names, or else by the key the event's `"%name"` author names. `key` (hex, or
 *     `"%name"`) and `sig` (hex) replace those fields, and `flip: {in, at}` flips the low bit of
 *     byte `at` of the `key`, `signature` or `event`. `unsigned: true` sends the bare event
 *     bytes, as the stub era did. `elsewhere: true` makes a record of another mailbox: `@seq`
 *     can name it, but it isn't folded.
 *   - `expect` is matched as a subset of the folded state.
 *   - `unchangedWithout` lists seqs whose removal must leave the state, apart from `ignored`,
 *     deep-equal.
 * - atom-text.json pins `normalizeAtomText` and the genesis split; atomText.test.ts runs it.
 */
import { describe, expect, it } from 'vitest';

import { EVENT_CONTEXT, publicKeyOf, sign } from '../crypto/sign';
import { concat, fromHex } from '../test/bytes';
import { base64url, eventId } from './event';
import { fold, type LogRecord } from './fold';
import { tally, type TallyInput, type TallyOutcome } from './tally';

interface TallyVector extends TallyInput {
  readonly name: string;
  readonly expect: TallyOutcome;
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

interface FoldVector {
  readonly name: string;
  readonly records: readonly VectorRecord[];
  readonly relayNow: number | null;
  readonly expect: object;
  readonly unchangedWithout?: readonly number[];
}

type VectorFile =
  | { readonly kind: 'tally'; readonly vectors: readonly TallyVector[] }
  | { readonly kind: 'fold'; readonly vectors: readonly FoldVector[] }
  | { readonly kind: 'atom-text'; readonly vectors: readonly { readonly name: string }[] }
  | { readonly kind: 'keys'; readonly seeds: Readonly<Record<string, string>> };

const TEXTS = import.meta.glob<string>('./vectors/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const FILES: Readonly<Record<string, VectorFile>> = Object.fromEntries(
  Object.entries(TEXTS).map(([path, text]) => [path, JSON.parse(text) as VectorFile]),
);

const encoder = new TextEncoder();

const SEEDS = new Map(
  Object.values(FILES).flatMap((file) =>
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
function publicKeyNamed(name: string): string {
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

/** Resolves every `@n` and `%name` reference inside a JSON value, in keys as well as values. */
function resolve(value: unknown, ids: ReadonlyMap<number, string>): unknown {
  if (typeof value === 'string') return resolveRef(value, ids);
  if (Array.isArray(value)) return value.map((item: unknown) => resolve(item, ids));
  if (typeof value === 'object' && value !== null) {
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

/** Turns a vector's records into relay records, serializing each event once, in seq order. */
function buildRecords(vector: FoldVector): { records: LogRecord[]; ids: Map<number, string> } {
  const ids = new Map<number, string>();
  const records = vector.records.flatMap((record) => {
    const text = 'raw' in record ? record.raw : JSON.stringify(resolve(record.event, ids));
    const event = encoder.encode(text);
    ids.set(record.seq, eventId(event));
    const bytes = relayBytes(record, event);
    return record.elsewhere === true ? [] : [{ seq: record.seq, received: record.received, bytes }];
  });
  return { records, ids };
}

const tallyVectors = Object.values(FILES).flatMap((file) =>
  file.kind === 'tally' ? file.vectors : [],
);
const foldVectors = Object.values(FILES).flatMap((file) =>
  file.kind === 'fold' ? file.vectors : [],
);

describe('vector files', () => {
  it('are the keys, then tally, fold or atom-text files', () => {
    expect(Object.keys(FILES).sort()).toEqual([
      './vectors/atom-text.json',
      './vectors/fold.json',
      './vectors/keys.json',
      './vectors/levels-capabilities.json',
      './vectors/levels-eligible-count.json',
      './vectors/levels-step-down.json',
      './vectors/levels-step-up-after-open.json',
      './vectors/signatures.json',
      './vectors/tally.json',
      './vectors/time.json',
      './vectors/versions-ballot.json',
      './vectors/versions-early-close.json',
      './vectors/versions-late-low-quorum.json',
      './vectors/versions-one-open.json',
      './vectors/versions-tie.json',
    ]);
    expect(Object.values(FILES).map((file) => file.kind)).toEqual([
      'atom-text',
      'fold',
      'keys',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'tally',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
    ]);
  });

  it('name ten keys, each derived as a second implementation (WebCrypto) derives it', async () => {
    expect([...SEEDS.keys()]).toEqual([
      'ana',
      'ben',
      'cal',
      'dee',
      'kim',
      'zed',
      'eve',
      'fay',
      'gus',
      'hal',
    ]);
    for (const [name, seed] of SEEDS) {
      const pkcs8 = concat(fromHex('302e020100300506032b657004220420'), seed);
      const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
      const { x } = await crypto.subtle.exportKey('jwk', key);
      expect(publicKeyNamed(name)).toBe(x);
    }
  });

  it('name every vector uniquely', () => {
    const names = Object.values(FILES).flatMap((file) =>
      'vectors' in file ? file.vectors.map((vector) => vector.name) : [],
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    'pass at an average of exactly 2.0',
    'fail at exactly 10% zeros',
    'lapse below quorum',
    'a 2-member group passes with 2 of 2 ballots',
    'a three-way tie goes to the earliest version',
    'at 11 eligible, 3 scorers lapse',
    'at 11 eligible, 4 scorers meet quorum',
    'at 15 eligible, 4 scorers lapse',
    'at 15 eligible, 5 scorers meet quorum',
  ])('include the tally vector "%s"', (name) => {
    expect(tallyVectors.map((vector) => vector.name)).toContain(name);
  });

  it.each([
    'a 2-member group passes with 2 of 2 ballots, which closes it early',
    'an early close once everyone has scored; a ballot after the close is ignored',
    'an event with v: 2 is ignored and leaves state unchanged',
    'an event that refers to an ignored event is ignored too',
    'a Proposal whose author ts is 7 days old is still open a minute before its relay deadline',
    'a Proposal whose author ts is 7 days old closes when relay time reaches its deadline',
    "a ballot received after the deadline doesn't count whatever its ts says, nor displace an earlier one",
    'a forged genesis before the real one founds nothing, and the real one founds the group',
    "one byte flipped in the event bytes is ignored, and can't shadow the real event after it",
    "one byte flipped in the signature is ignored, and can't shadow the real event after it",
    "one byte flipped in the key is ignored, and can't shadow the real event after it",
    "a member's real signature under another member's key is ignored",
    "a record whose key isn't the event's author is ignored, and can't shadow the author's own",
    'a Proposal validly signed by a key that never joined is ignored',
    "replay-join-other-group: Kim's join, signed for group A, is ignored in group B",
    'a second genesis, validly signed by a member, is ignored',
    "a small-order key, whose signature holds for every message, can't join",
    "a non-canonical encoding of a small-order key can't join either",
    'a bare event with no key or signature, as the stub era posted, is ignored and shadows nothing',
    "re-posting a member's older ballot as identical signed bytes, after their newer one, changes neither the outcome nor which ballot counts",
    'genesis makes the founder a Co-Creator, a join with no level folds as a Collaborator, and a join keeps the level it names',
    "a join that names an unknown level, such as admin, is ignored, so its author can't vote",
    "a Member's proposal and vote are ignored, and a Member isn't in the eligible set",
    "a Collaborator's vote counts, but their proposal is ignored",
    "a Co-Creator's proposal and vote both count",
    "a level event sets its author's own level at once: a Collaborator steps up and proposes, and the founder steps down and can't",
    'a level event is ignored from a non-member, for an unknown level, for the level its author already holds, or for another group',
    "levels-step-up-after-open: Kim joins as a Member, a Proposal opens, then Kim steps up to Collaborator and votes; the ballot is ignored and Kim isn't waited for",
    "a Collaborator's ballot cast before they step down to Member still counts, and one received after doesn't",
    'stepping down never touches an open Proposal: its eligible set and quorum stay 3, so 2 ballots lapse at the deadline',
    "someone in a Proposal's eligible set who steps down and back up before its deadline can still vote on it",
    "in a group of 5 with 2 Members, a Proposal's eligible count is 3 and its quorum is 3, so 2 ballots lapse at the deadline",
    "in a group of 5 with 2 Members, the 3 voting members' ballots meet quorum and close the vote early",
    'passes that close in the same minute apply in the relay order of their Proposals',
    "a version joins the open Proposal's ballot under its own event id, in relay order",
    'a fourth version is ignored, and the ballot keeps the first three',
    'a version received a minute before the deadline joins the ballot, and one received at the deadline is ignored',
    'a version received after an early close is ignored, even in the same minute',
    'a version needs an author who holds propose, so not a Collaborator, and a Proposal to join',
    'a ballot that names a version not yet on its Proposal is ignored, and stays ignored once the version arrives',
    "a voter's latest ballot replaces their earlier one in full, so a version it leaves out loses their score",
    "when both versions pass, the one with the higher average becomes the Atom's text",
    'a version added after the others had scored keeps the vote open until every voter has scored it too',
    "every voter's score for version 1 doesn't close the vote while one of them hasn't scored version 2",
    'a second Proposal on an Atom whose first is still open is ignored, and so are its ballots',
    "a Proposal on another Atom opens while the first Atom's is still open",
    'a second Proposal on the same Atom opens once the first has closed early, even in the same minute',
    "a second Proposal on the same Atom is ignored a minute before the first one's deadline, and opens at it",
    "a late version scored 4 by only 2 of 10 eligible members can't win, because it never reaches quorum",
    'a three-version tie goes to the earliest version',
    'a tie between later versions goes to the one the relay received first, whatever their ts',
  ])('include the fold vector "%s"', (name) => {
    expect(foldVectors.map((vector) => vector.name)).toContain(name);
  });
});

describe('tally vectors', () => {
  it.each(tallyVectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    expect(tally(vector)).toEqual(vector.expect);
  });
});

describe('fold vectors', () => {
  it.each(foldVectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const { records, ids } = buildRecords(vector);
    const state = fold(records, vector.relayNow);
    expect(state).toMatchObject(resolve(vector.expect, ids) as object);
    const without = vector.unchangedWithout ?? [];
    const kept = records.filter((record) => !without.includes(record.seq));
    expect({ ...fold(kept, vector.relayNow), ignored: [] }).toEqual({ ...state, ignored: [] });
  });
});
