/**
 * Erase Reconcile from this device (#78; ADR-0046 as cut by ADR-0073): every
 * database, Cache Storage, both web storages and every service worker, gone,
 * with no network call, before the app reloads at `/`.
 */
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guideRecord } from '../platform/guide';
import { utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { DATABASE_NAME, openStore, type Store } from './db';
import { browserTargets, EraseIncomplete, eraseDevice, type EraseTargets } from './erase';

freshIndexedDBPerTest();

/** What happened, in order, across the app, the targets and the reload. */
let steps: string[] = [];

beforeEach(() => {
  steps = [];
  localStorage.setItem('reconcile.notice', 'accepted');
  sessionStorage.setItem('reconcile.tab', 'kept');
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Cache Storage with `names` in it, which records each delete. */
function fakeCaches(names: readonly string[], refuse = false) {
  const held = new Set(names);
  return {
    held,
    caches: {
      keys: () => Promise.resolve([...held]),
      delete: (name: string) => {
        steps.push(`delete cache ${name}`);
        if (refuse) return Promise.reject(new Error('Cache Storage refused.'));
        return Promise.resolve(held.delete(name));
      },
    },
  };
}

/** Service worker registrations, each recording its unregister. */
function fakeWorkers(count: number) {
  const registrations = Array.from({ length: count }, (_, index) => ({
    unregister: vi.fn(() => {
      steps.push(`unregister worker ${String(index)}`);
      return Promise.resolve(true);
    }),
  }));
  return {
    registrations,
    serviceWorker: { getRegistrations: () => Promise.resolve(registrations) },
  };
}

/** The app's store, holding one group, and a sync loop whose halt is recorded. */
async function runningApp(): Promise<{ store: Store; sync: { halt: () => Promise<void> } }> {
  const store = await openStore();
  await store.addGroup({
    groupId: 'group-1',
    secret: new Uint8Array(32).fill(9),
    signingKey: new Uint8Array(32).fill(7),
    me: { author: 'author-ana', name: 'Ana' },
  });
  const close = store.close.bind(store);
  store.close = () => {
    steps.push('close store');
    close();
  };
  return {
    store,
    sync: {
      halt: () => {
        steps.push('halt sync');
        return Promise.resolve();
      },
    },
  };
}

/** Targets on the fake IndexedDB and jsdom's storages, with fake caches and workers. */
function targets(overrides: Partial<EraseTargets> = {}): EraseTargets {
  return {
    indexedDB,
    caches: fakeCaches(['reconcile-shell-v1']).caches,
    storages: [localStorage, sessionStorage],
    serviceWorker: fakeWorkers(1).serviceWorker,
    replace: (url: string) => steps.push(`replace ${url}`),
    ...overrides,
  };
}

/** Another database on this origin, as an older build or a library might have left. */
async function otherDatabase(): Promise<void> {
  const db = await openDB('reconcile-older', 1, {
    upgrade(database) {
      void database.createObjectStore('things').put('Canary', 'key');
    },
  });
  db.close();
}

describe('eraseDevice', () => {
  it('deletes every database, empties Cache Storage and both web storages, and unregisters every worker', async () => {
    const app = await runningApp();
    await otherDatabase();
    const { held, caches } = fakeCaches(['reconcile-shell-v1', 'reconcile-shell-v2']);
    const { registrations, serviceWorker } = fakeWorkers(2);

    await eraseDevice(app, targets({ caches, serviceWorker }));

    expect(await indexedDB.databases()).toEqual([]);
    expect([...held]).toEqual([]);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    for (const registration of registrations)
      expect(registration.unregister).toHaveBeenCalledOnce();
    const reopened = await openStore();
    expect(await reopened.listGroups()).toEqual([]);
    reopened.close();
  });

  it('takes the first-run guide’s flag (#91) and the chat bot’s claims (#119) with the rest', async () => {
    const app = await runningApp();
    const guide = guideRecord();
    guide.see();
    const claim = { id: 'claim-1', proposal: 'proposal-1', moment: 'open' } as const;
    await app.store.claimChat('group-1', utf8('{"claim":1}'), claim);

    await eraseDevice(app, targets());

    expect(guide.seen()).toBe(false);
    const reopened = await openStore();
    expect(await reopened.getGroup('group-1')).toBeUndefined();
    reopened.close();
  });

  it('halts sync and closes the store first, and reloads at / only once everything else is done', async () => {
    const app = await runningApp();
    const { serviceWorker } = fakeWorkers(2);

    await eraseDevice(app, targets({ serviceWorker }));

    expect(steps.slice(0, 2)).toEqual(['halt sync', 'close store']);
    expect(steps.at(-1)).toBe('replace /');
    expect(steps.filter((step) => step.startsWith('replace'))).toHaveLength(1);
    expect(steps.indexOf('unregister worker 1')).toBeLessThan(steps.indexOf('replace /'));
    expect(steps.indexOf('delete cache reconcile-shell-v1')).toBeLessThan(
      steps.indexOf('replace /'),
    );
  });

  it('makes no network call', async () => {
    const app = await runningApp();
    const fetch = vi.fn(() => Promise.reject(new Error('No network in Erase.')));
    const beacon = vi.fn(() => false);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { sendBeacon: beacon });

    await eraseDevice(app, targets());

    expect(fetch).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('doesn’t wait on another tab’s open connection: that tab’s store closes itself', async () => {
    const app = await runningApp();
    const otherTab = await openStore();

    await eraseDevice(app, targets());

    expect(await indexedDB.databases()).toEqual([]);
    await expect(otherTab.listGroups()).rejects.toThrow();
  });

  it('deletes the app’s own database even where the browser can’t list databases', async () => {
    const app = await runningApp();
    const factory = indexedDB;
    const unlisted = {
      deleteDatabase: (name: string) => factory.deleteDatabase(name),
      databases: undefined,
    } as unknown as IDBFactory;

    await eraseDevice(app, targets({ indexedDB: unlisted }));

    expect(await factory.databases()).toEqual([]);
  });

  it('erases without Cache Storage or service workers, where the browser has neither', async () => {
    const app = await runningApp();

    await eraseDevice(app, targets({ caches: undefined, serviceWorker: undefined }));

    expect(await indexedDB.databases()).toEqual([]);
    expect(steps.at(-1)).toBe('replace /');
  });

  it('finishes every other step, then rejects without reloading, when one fails', async () => {
    const app = await runningApp();
    const { caches } = fakeCaches(['reconcile-shell-v1'], true);
    const { registrations, serviceWorker } = fakeWorkers(1);

    await expect(eraseDevice(app, targets({ caches, serviceWorker }))).rejects.toThrow(
      new EraseIncomplete(),
    );

    expect(await indexedDB.databases()).toEqual([]);
    expect(localStorage).toHaveLength(0);
    expect(registrations[0]?.unregister).toHaveBeenCalledOnce();
    expect(steps).not.toContain('replace /');
  });

  it('rejects when a database won’t delete', async () => {
    const app = await runningApp();
    const refusing = {
      databases: () => Promise.resolve([{ name: DATABASE_NAME, version: 3 }]),
      deleteDatabase: () => {
        const request = { onsuccess: null, onerror: null, error: new DOMException('No.') } as {
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          error: DOMException;
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    } as unknown as IDBFactory;

    await expect(eraseDevice(app, targets({ indexedDB: refusing }))).rejects.toThrow(
      EraseIncomplete,
    );
    expect(steps).not.toContain('replace /');
  });
});

describe('browserTargets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are the page’s own IndexedDB, Cache Storage, web storages and service workers', () => {
    const caches = fakeCaches([]).caches;
    const { serviceWorker } = fakeWorkers(0);
    vi.stubGlobal('caches', caches);
    vi.stubGlobal('navigator', { serviceWorker });

    const found = browserTargets();

    expect(found.indexedDB).toBe(indexedDB);
    expect(found.caches).toBe(caches);
    expect(found.storages).toEqual([localStorage, sessionStorage]);
    expect(found.serviceWorker).toBe(serviceWorker);
    expect(typeof found.replace).toBe('function');
  });

  it('leave out what the browser doesn’t have', () => {
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('navigator', {});

    const found = browserTargets();

    expect(found.caches).toBeUndefined();
    expect(found.serviceWorker).toBeUndefined();
  });
});
