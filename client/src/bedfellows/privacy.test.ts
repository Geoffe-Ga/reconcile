/**
 * Bedfellows keeps the reader's writing in memory (#475; ADR-0080 §5): while
 * the worker runs the pipeline over real corpus readers and the whole tune
 * shelf, nothing is requested and nothing is written to IndexedDB, the Cache
 * API, Web Storage or the console. Every one of those doors is watched; a
 * control call through each proves the watch would see it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCorpus } from './corpus';
import { standInEmbedder, standInJudge } from './standIns';
import type { FromWorker } from './types';
import { createRunner, yielding } from './worker';

/** Every door the watch covers, each a spy. */
function watchEveryDoor() {
  const doors = {
    fetch: vi.fn(),
    xhr: vi.fn(),
    beacon: vi.fn(),
    indexedDB: vi.fn(),
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
  vi.stubGlobal('indexedDB', { open: doors.indexedDB, deleteDatabase: doors.indexedDB });
  vi.stubGlobal('caches', { open: doors.caches, delete: doors.caches, match: doors.caches });
  return doors;
}

describe('the worker’s run keeps everything in memory (#475)', () => {
  let doors: ReturnType<typeof watchEveryDoor>;

  beforeEach(() => {
    doors = watchEveryDoor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests nothing and writes nothing while it runs', async () => {
    const corpus = loadCorpus();
    const readers = corpus.readers.filter((r) => r.split === 'tune').slice(0, 3);
    const entries = corpus.entries.filter((e) => e.split === 'tune');
    const posted: FromWorker[] = [];
    const runner = createRunner(
      { embedder: yielding(standInEmbedder), judge: standInJudge },
      (message) => posted.push(message),
    );

    readers.forEach((reader, id) => {
      runner.handle({ type: 'run', id, input: { reader: reader.documents, entries, dial: 0 } });
    });
    await vi.waitFor(
      () => {
        expect(posted).toHaveLength(readers.length);
      },
      { timeout: 10_000 },
    );

    expect(posted.every((message) => message.type === 'rows')).toBe(true);
    expect(posted.some((message) => message.type === 'rows' && message.rows.length > 0)).toBe(true);
    for (const [door, spy] of Object.entries(doors)) {
      expect(spy, door).not.toHaveBeenCalled();
    }
  });

  it('control: the watch sees a call through every door', () => {
    // Only src/net/ may name these two (spec §2), so the control checks that the spies stand
    // where a request would look them up, rather than calling them.
    expect(globalThis).toHaveProperty('fetch', doors.fetch);
    expect(globalThis).toHaveProperty('XMLHttpRequest', doors.xhr);
    navigator.sendBeacon('/v1/x');
    indexedDB.open('x');
    void caches.open('x');
    localStorage.setItem('x', 'y');
    sessionStorage.removeItem('x');
    localStorage.clear();
    console.log('x');
    console.info('x');
    console.warn('x');
    console.error('x');
    console.debug('x');

    for (const [door, spy] of Object.entries(doors)) {
      if (door === 'fetch' || door === 'xhr') continue;
      expect(spy, door).toHaveBeenCalled();
    }
  });
});
