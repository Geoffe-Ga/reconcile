/**
 * The cache of public entry vectors (#477; ADR-0080 §5): vectors of shelf
 * entries' public text, kept on the device by entry id and model, reused
 * while the entry's claims and the model are the same, and dropped when the
 * entry leaves the shelf or the model changes. A store that fails costs only
 * the reuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  type EntryClaims,
  entryVectors,
  indexedDbVectorStore,
  memoryVectorStore,
  type StoredVectors,
  VECTOR_DATABASE,
  type VectorStore,
} from './entryVectors';
import type { Embedder } from './types';

/** An embedder named `model` that gives each sentence its length and its first code unit, and counts what it embeds. */
function counting(model?: string): Embedder & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    ...(model === undefined ? {} : { model }),
    seen,
    embed: (sentences) => {
      seen.push([...sentences]);
      return Promise.resolve(sentences.map((s) => [s.length, s.charCodeAt(0)]));
    },
  };
}

const SHELF: EntryClaims[] = [
  { id: 'e1', claims: ['Keep the library open.', 'Fund the reading room.'] },
  { id: 'e2', claims: ['Plant trees by the river.', 'Keep the library open.'] },
];

describe('entryVectors (#477)', () => {
  it('embeds every claim once, however many entries share it, and hands back each entry’s vectors in order', async () => {
    const embedder = counting('m1');

    const vectors = await entryVectors(SHELF, embedder, { store: memoryVectorStore() });

    expect(embedder.seen.flat().sort()).toEqual([
      'Fund the reading room.',
      'Keep the library open.',
      'Plant trees by the river.',
    ]);
    expect(vectors.get('e2')?.map((v) => Array.from(v))).toEqual([
      [25, 'P'.charCodeAt(0)],
      [22, 'K'.charCodeAt(0)],
    ]);
  });

  it('embeds in chunks, checking the signal between them', async () => {
    const embedder = counting('m1');
    const controller = new AbortController();
    const embed = embedder.embed.bind(embedder);
    embedder.embed = (sentences) => {
      controller.abort();
      return embed(sentences);
    };

    await expect(
      entryVectors(SHELF, embedder, { signal: controller.signal, chunk: 2 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedder.seen).toHaveLength(1);
  });

  it('keeps each entry’s vectors by entry id and model, and reuses them on the next run without embedding', async () => {
    const store = memoryVectorStore();
    await entryVectors(SHELF, counting('m1'), { store });
    const again = counting('m1');

    const vectors = await entryVectors(SHELF, again, { store });

    expect(again.seen).toEqual([]);
    expect(vectors.get('e1')).toHaveLength(2);
    expect(store.records().map((r) => [r.entryId, r.model, r.claims])).toEqual([
      ['e1', 'm1', SHELF[0]?.claims],
      ['e2', 'm1', SHELF[1]?.claims],
    ]);
  });

  it('embeds again an entry whose claims changed', async () => {
    const store = memoryVectorStore();
    await entryVectors(SHELF, counting('m1'), { store });
    const again = counting('m1');

    await entryVectors(
      [{ id: 'e1', claims: ['Keep the library open late.'] }, SHELF[1] ?? { id: '', claims: [] }],
      again,
      { store },
    );

    expect(again.seen.flat()).toEqual(['Keep the library open late.']);
  });

  it('drops every vector of another model, and embeds again', async () => {
    const store = memoryVectorStore();
    await entryVectors(SHELF, counting('m1'), { store });
    const next = counting('m2');

    await entryVectors(SHELF, next, { store });

    expect(next.seen.flat()).toHaveLength(3);
    expect(store.records().map((r) => r.model)).toEqual(['m2', 'm2']);
  });

  it('drops the vectors of an entry that left the shelf', async () => {
    const store = memoryVectorStore();
    await entryVectors(SHELF, counting('m1'), { store });

    await entryVectors(SHELF.slice(1), counting('m1'), { store });

    expect(store.records().map((r) => r.entryId)).toEqual(['e2']);
  });

  it('keeps nothing for an embedder that names no model', async () => {
    const store = memoryVectorStore();

    await entryVectors(SHELF, counting(), { store });

    expect(store.records()).toEqual([]);
  });

  it('still answers when the store fails to read, write or prune', async () => {
    const broken: VectorStore = {
      read: () => Promise.reject(new Error('no')),
      write: () => Promise.reject(new Error('no')),
      keepOnly: () => Promise.reject(new Error('no')),
    };

    const vectors = await entryVectors(SHELF, counting('m1'), { store: broken });

    expect([...vectors.keys()]).toEqual(['e1', 'e2']);
  });
});

describe('indexedDbVectorStore (#477)', () => {
  let factory: IDBFactory;

  beforeEach(() => {
    factory = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const record = (entryId: string, model = 'm1'): StoredVectors => ({
    entryId,
    model,
    claims: ['Keep the library open.'],
    vectors: [Float32Array.from([0.25, -0.5])],
  });

  it('writes records, reads back the ones asked for, and keeps only the shelf’s under one model', async () => {
    const store = indexedDbVectorStore(factory);

    await store.write([record('e1'), record('e2'), record('e3', 'm0')]);
    const read = await store.read(['e1', 'e3', 'missing']);
    await store.keepOnly(['e1', 'e3'], 'm1');
    const left = await store.read(['e1', 'e2', 'e3']);

    expect([...read.keys()]).toEqual(['e1', 'e3']);
    expect(Array.from(read.get('e1')?.vectors[0] ?? [])).toEqual([0.25, -0.5]);
    expect([...left.keys()]).toEqual(['e1']);
  });

  it('lives in a database of its own, which an erase can delete while the store is open', async () => {
    const store = indexedDbVectorStore(factory);
    await store.write([record('e1')]);

    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(VECTOR_DATABASE);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error('blocked'));
      };
    });
    const after = await store.read(['e1']);

    expect(VECTOR_DATABASE).toBe('reconcile-bedfellows-vectors');
    expect(after.size).toBe(0);
  });

  it('rejects when the database won’t open', async () => {
    vi.spyOn(factory, 'open').mockImplementation(() => {
      throw new Error('refused');
    });

    await expect(indexedDbVectorStore(factory).read(['e1'])).rejects.toThrow('refused');
  });
});
