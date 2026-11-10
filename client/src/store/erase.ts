/**
 * Erase Reconcile from this device (#78; spec §9 "Local data"; ADR-0046 as
 * cut by ADR-0073): one local action that leaves nothing of Reconcile behind
 * on the device and tells no one.
 *
 * It halts the sync loop first, so no request starts once it begins, and
 * closes the store, since an open connection blocks `deleteDatabase` (another
 * tab's store closes itself when asked, `db.ts`). Then it deletes every
 * database the page's origin holds, the store's own and any that
 * `indexedDB.databases()` lists, empties Cache Storage, `localStorage` and
 * `sessionStorage`, and unregisters every service worker. It runs every step
 * even when one fails, and only when all have succeeded does it reload the
 * app at `/`, which opens on first run with no groups. It makes no network
 * call: nothing about an erase leaves the device.
 *
 * The groups carry on for everyone else, and a backup file brings them back.
 */
import { DATABASE_NAME, type Store } from './db';
import type { Sync } from './sync';

/** What Erase clears, and how it reloads: the browser's own unless a test hands in others. */
export interface EraseTargets {
  /** The page's IndexedDB. */
  readonly indexedDB: IDBFactory;
  /** Cache Storage, where the browser has it. */
  readonly caches: Pick<CacheStorage, 'keys' | 'delete'> | undefined;
  /** `localStorage` and `sessionStorage`. */
  readonly storages: readonly Pick<Storage, 'clear'>[];
  /** The page's service workers, where the browser has them. */
  readonly serviceWorker:
    | { getRegistrations(): Promise<readonly Pick<ServiceWorkerRegistration, 'unregister'>[]> }
    | undefined;
  /** `location.replace`: the reload once everything is gone. */
  readonly replace: (url: string) => void;
}

/** The running app Erase stops before it deletes anything. */
export interface ErasableApp {
  readonly sync: Pick<Sync, 'halt'>;
  readonly store: Pick<Store, 'close'>;
}

/** Thrown when some of the data couldn't be erased; the app doesn't reload then. */
export class EraseIncomplete extends Error {
  /** Say that Erase didn't finish. */
  constructor() {
    super('Some of Reconcile’s data on this device couldn’t be erased.');
    this.name = 'EraseIncomplete';
  }
}

/** The browser's own targets. */
export function browserTargets(): EraseTargets {
  return {
    indexedDB: window.indexedDB,
    caches: typeof caches === 'undefined' ? undefined : caches,
    storages: [window.localStorage, window.sessionStorage],
    serviceWorker: (navigator as Partial<Navigator>).serviceWorker,
    replace: window.location.replace.bind(window.location),
  };
}

/** Deletes the database `name`; rejects when the browser refuses. */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`IndexedDB refused to delete ${name}.`));
    };
  });
}

/** The names of every database the browser lists, or none where it can't list them. */
async function listedDatabases(factory: IDBFactory): Promise<string[]> {
  if (typeof factory.databases !== 'function') return [];
  const listed = await factory.databases();
  return listed.flatMap(({ name }) => (name === undefined ? [] : [name]));
}

/** Deletes the store's database and every other one the browser lists. */
async function deleteDatabases(factory: IDBFactory): Promise<void> {
  const names = new Set([DATABASE_NAME, ...(await listedDatabases(factory))]);
  await Promise.all([...names].map((name) => deleteDatabase(factory, name)));
}

/** Deletes every cache in Cache Storage. */
async function clearCaches(storage: EraseTargets['caches']): Promise<void> {
  if (storage === undefined) return;
  const names = await storage.keys();
  await Promise.all(names.map((name) => storage.delete(name)));
}

/** Empties `localStorage` and `sessionStorage`; rejects when the browser refuses either. */
function clearStorages(storages: EraseTargets['storages']): Promise<void> {
  return new Promise((resolve) => {
    for (const storage of storages) storage.clear();
    resolve();
  });
}

/** Unregisters every service worker the page has. */
async function unregisterWorkers(container: EraseTargets['serviceWorker']): Promise<void> {
  if (container === undefined) return;
  const registrations = await container.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

/**
 * Erases all of Reconcile's data on this device, then reloads at `/`.
 *
 * @throws {EraseIncomplete} when any step failed: every other step still ran,
 *   and the app doesn't reload.
 */
export async function eraseDevice(
  app: ErasableApp,
  targets: EraseTargets = browserTargets(),
): Promise<void> {
  await app.sync.halt();
  app.store.close();
  const results = await Promise.allSettled([
    deleteDatabases(targets.indexedDB),
    clearCaches(targets.caches),
    clearStorages(targets.storages),
    unregisterWorkers(targets.serviceWorker),
  ]);
  if (results.some((result) => result.status === 'rejected')) throw new EraseIncomplete();
  targets.replace('/');
}
