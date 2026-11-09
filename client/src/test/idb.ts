/**
 * IndexedDB for tests: fake-indexeddb's globals, and a fresh empty database
 * factory for each test, so no test sees another's data.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';

/** Give every test in the calling file its own empty `indexedDB`. */
export function freshIndexedDBPerTest(): void {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
