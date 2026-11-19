/**
 * Bedfellows keeps the reader's writing in memory (#475, #477, #478; ADR-0080
 * §5). While the worker runs the pipeline with the model and a stance judge
 * over real corpus readers and the whole tune shelf, every write to IndexedDB, the Cache API and Web
 * Storage is captured, and every request and console call watched. The only
 * writes are the cache of public entry vectors: each an entry's id, its
 * model, its own claims and their vectors. No reader sentence that isn't also
 * an entry's, no reader vector, no score and no stance is written anywhere, and nothing
 * is requested or logged. A control call through each door proves the watch
 * would see it.
 */
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCorpus } from './corpus';
import { indexedDbVectorStore, type StoredVectors } from './entryVectors';
import { claimsIn, splitClaims } from './split';
import { standInEmbedder, standInJudge } from './standIns';
import type { FromWorker, Stance, StanceJudge } from './types';
import { createRunner } from './worker';

/** Every door the watch covers but IndexedDB, each a spy. */
function watchEveryDoor() {
  const doors = {
    fetch: vi.fn(),
    xhr: vi.fn(),
    beacon: vi.fn(),
    caches: vi.fn(),
    setItem: vi.spyOn(Storage.prototype, 'setItem'),
    removeItem: vi.spyOn(Storage.prototype, 'removeItem'),
    clear: vi.spyOn(Storage.prototype, 'clear'),
    log: vi.spyOn(console, 'log'),
    info: vi.spyOn(console, 'info'),
    warn: vi.spyOn(console, 'warn'),
    error: vi.spyOn(console, 'error'),
    debug: vi.spyOn(console, 'debug'),
  };
  vi.stubGlobal('fetch', doors.fetch);
  vi.stubGlobal('XMLHttpRequest', doors.xhr);
  vi.stubGlobal('navigator', Object.create(navigator, { sendBeacon: { value: doors.beacon } }));
  vi.stubGlobal('caches', {
    open: doors.caches,
    delete: doors.caches,
    match: doors.caches,
    put: doors.caches,
  });
  return doors;
}

/** Every value written to any IndexedDB object store: each write is spied on, and still made. */
function captureIndexedDbWrites(): () => unknown[] {
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  const add = vi.spyOn(IDBObjectStore.prototype, 'add');
  return () => [...put.mock.calls, ...add.mock.calls].map(([value]) => value as unknown);
}

/** A judge that answers all three stances, by the pair's length, so every path of the check runs. */
const VARIED_JUDGE: StanceJudge = {
  judge: (readerSentence, entrySentence) => {
    const stances: readonly Stance[] = ['agrees', 'opposes', 'unsure'];
    return Promise.resolve(stances[(readerSentence.length + entrySentence.length) % 3] ?? 'unsure');
  },
};

describe('the worker’s run keeps the reader’s writing in memory (#475, #477, #478)', () => {
  let doors: ReturnType<typeof watchEveryDoor>;
  let written: () => unknown[];

  beforeEach(() => {
    doors = watchEveryDoor();
    written = captureIndexedDbWrites();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes only entries’ public vectors, never a pair or its stance, and requests and logs nothing', async () => {
    const corpus = loadCorpus();
    const readers = corpus.readers.filter((r) => r.split === 'tune').slice(0, 3);
    const entries = corpus.entries.filter((e) => e.split === 'tune');
    const posted: FromWorker[] = [];
    const runner = createRunner(
      {
        judge: standInJudge,
        loadModel: () => Promise.resolve(standInEmbedder),
        loadJudge: () => Promise.resolve(VARIED_JUDGE),
        store: indexedDbVectorStore(new IDBFactory()),
      },
      (message) => posted.push(message),
    );

    for (const [id, reader] of readers.entries()) {
      runner.handle({
        type: 'run',
        id,
        input: { reader: reader.documents, entries, dial: 0 },
        model: true,
      });
      await vi.waitFor(
        () => {
          expect(posted).toHaveLength(id + 1);
        },
        { timeout: 10_000 },
      );
    }

    expect(posted.every((message) => message.type === 'rows')).toBe(true);
    expect(posted.some((message) => message.type === 'rows' && message.rows.length > 0)).toBe(true);
    const claimsOf = new Map(entries.map((e) => [e.id, new Set(claimsIn(e.title, e.text))]));
    const entryText = new Set([...claimsOf.values()].flatMap((claims) => [...claims]));
    const readerOnly = readers
      .flatMap((r) => r.documents.flatMap((d) => splitClaims(d.text)))
      .filter((sentence) => !entryText.has(sentence));
    const readerVectors = new Set(
      (await standInEmbedder.embed(readerOnly)).map((v) => Array.from(v).join()),
    );
    const zero = new Array<number>(standInEmbedder.dimensions).fill(0).join();
    readerVectors.delete(zero);
    expect(readerOnly.length).toBeGreaterThan(0);
    // The first run keeps every entry's vectors once; the later runs reuse them.
    expect(written()).toHaveLength(entries.length);
    for (const value of written()) {
      const record = value as StoredVectors;
      expect(Object.keys(record).sort()).toEqual(['claims', 'entryId', 'model', 'vectors']);
      expect(record.model).toBe(standInEmbedder.model);
      const own = claimsOf.get(record.entryId);
      expect(own, record.entryId).toBeDefined();
      for (const claim of record.claims) expect(own?.has(claim), claim).toBe(true);
      const expected = await standInEmbedder.embed(record.claims);
      expect(record.vectors.map((v) => Array.from(v))).toEqual(expected.map((v) => Array.from(v)));
      for (const vector of record.vectors) {
        expect(readerVectors.has(Array.from(vector).join()), 'a reader vector').toBe(false);
      }
    }
    const text = JSON.stringify(written(), (_, v: unknown) => (v instanceof Float32Array ? [] : v));
    for (const sentence of readerOnly) expect(text, sentence).not.toContain(sentence);
    for (const stance of ['agrees', 'opposes', 'unsure']) expect(text).not.toContain(stance);
    const verified = posted.flatMap((m) => (m.type === 'rows' ? m.rows : []));
    expect(verified.some((row) => row.reason.verified)).toBe(true);
    for (const [door, spy] of Object.entries(doors)) {
      expect(spy, door).not.toHaveBeenCalled();
    }
  });

  it('control: the watch sees a call through every door, and a write to IndexedDB', async () => {
    // Only src/net/ may name these two (spec §2), so the control checks that the spies stand
    // where a request would look them up, rather than calling them.
    expect(globalThis).toHaveProperty('fetch', doors.fetch);
    expect(globalThis).toHaveProperty('XMLHttpRequest', doors.xhr);
    navigator.sendBeacon('/v1/x');
    void caches.open('x');
    localStorage.setItem('x', 'y');
    sessionStorage.removeItem('x');
    localStorage.clear();
    console.log('x');
    console.info('x');
    console.warn('x');
    console.error('x');
    console.debug('x');
    await indexedDbVectorStore(new IDBFactory()).write([
      { entryId: 'control', model: 'm', claims: ['x'], vectors: [Float32Array.from([1])] },
    ]);

    for (const [door, spy] of Object.entries(doors)) {
      if (door === 'fetch' || door === 'xhr') continue;
      expect(spy, door).toHaveBeenCalled();
    }
    expect(written()).toHaveLength(1);
    expect((written()[0] as StoredVectors).entryId).toBe('control');
  });
});
