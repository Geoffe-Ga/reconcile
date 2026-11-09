/**
 * Golden vectors: the engine's contract (ADR-0073, docs/spec/phase-1-spec.md §4–§5).
 *
 * Each file in vectors/ is `{kind: "tally" | "fold", vectors: [...]}`.
 * - A tally vector is `{name, eligible, versions, expect}`.
 * - A fold vector is `{name, records: [{seq, received, event | raw}], relayNow, expect,
 *   unchangedWithout?}`. Each `event` is serialized with `JSON.stringify` as written,
 *   so a vector pins exact bytes; `raw` gives the bytes as text instead.
 *   A string `"@3"` stands for the id of the record at seq 3, so `"@1.0"` is genesis's
 *   first Atom. `expect` is matched as a subset of the folded state.
 *   `unchangedWithout` lists seqs whose removal must leave the state, apart from
 *   `ignored`, deep-equal.
 */
import { describe, expect, it } from 'vitest';

import { eventId } from './event';
import { fold, type LogRecord } from './fold';
import { tally, type TallyInput, type TallyOutcome } from './tally';

interface TallyVector extends TallyInput {
  readonly name: string;
  readonly expect: TallyOutcome;
}

type VectorRecord =
  | { readonly seq: number; readonly received: number; readonly event: unknown }
  | { readonly seq: number; readonly received: number; readonly raw: string };

interface FoldVector {
  readonly name: string;
  readonly records: readonly VectorRecord[];
  readonly relayNow: number | null;
  readonly expect: object;
  readonly unchangedWithout?: readonly number[];
}

type VectorFile =
  | { readonly kind: 'tally'; readonly vectors: readonly TallyVector[] }
  | { readonly kind: 'fold'; readonly vectors: readonly FoldVector[] };

const FILES = import.meta.glob<VectorFile>('./vectors/*.json', { import: 'default', eager: true });

const encoder = new TextEncoder();

/** Replaces `@n` (and `@n.i`) with the id of the record at seq n. */
function resolveRef(text: string, ids: ReadonlyMap<number, string>): string {
  const match = /^@(\d+)(.*)$/.exec(text);
  if (match === null) return text;
  const id = ids.get(Number(match[1]));
  if (id === undefined)
    throw new Error(`a vector refers to seq ${String(match[1])} before it exists`);
  return id + String(match[2]);
}

/** Resolves every `@n` reference inside a JSON value, in keys as well as values. */
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

/** Turns a vector's records into relay records, serializing each event once, in seq order. */
function buildRecords(vector: FoldVector): { records: LogRecord[]; ids: Map<number, string> } {
  const ids = new Map<number, string>();
  const records = vector.records.map((record) => {
    const text = 'raw' in record ? record.raw : JSON.stringify(resolve(record.event, ids));
    const bytes = encoder.encode(text);
    ids.set(record.seq, eventId(bytes));
    return { seq: record.seq, received: record.received, bytes };
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
  it('are all tally or fold files', () => {
    expect(Object.keys(FILES).sort()).toEqual([
      './vectors/fold.json',
      './vectors/tally.json',
      './vectors/time.json',
    ]);
    expect(Object.values(FILES).map((file) => file.kind)).toEqual(['fold', 'tally', 'fold']);
  });

  it('name every vector uniquely', () => {
    const names = [...tallyVectors, ...foldVectors].map((vector) => vector.name);
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
