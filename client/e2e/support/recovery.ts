/**
 * Recovery contacts' keys and shares as devices keep them (#109, #118), read
 * straight from each profile's IndexedDB with no hook into the app, and
 * opened outside it with the device's own key.
 */
import type { Page } from '@playwright/test';

import { openShare, type RecoveryShare } from '../../src/crypto/shares';
import type { Person } from './fixtures';
import { storedGroups, storedLogs } from './stored';

/** One record of the device store, read straight from `page`'s IndexedDB, or null. */
export function deviceRecord(page: Page, key: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (name) => {
    const request = <T>(asking: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        asking.onsuccess = () => {
          resolve(asking.result);
        };
        asking.onerror = () => {
          reject(asking.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const db = await request(indexedDB.open('reconcile'));
    try {
      const record = (await request(db.transaction('device').objectStore('device').get(name))) as
        Record<string, unknown> | undefined;
      if (record === undefined) return null;
      // Bytes come back as plain arrays, so they cross into the test intact.
      return Object.fromEntries(
        Object.entries(record).map(([field, value]) => [
          field,
          value instanceof Uint8Array ? Array.from(value) : value,
        ]),
      );
    } finally {
      db.close();
    }
  }, key);
}

/** The relay backup key `page`'s device keeps, read straight from its IndexedDB. */
export async function backupKeyOn(page: Page): Promise<number[]> {
  const state = await deviceRecord(page, 'relay-backup');
  const key = state?.key;
  if (!Array.isArray(key)) throw new Error('No relay backup key on this device.');
  return key as number[];
}

/** The events of type `type` in a stored log, as their author and body. */
export function postedEvents(
  log: readonly (readonly [number, number, string])[],
  type: string,
): { readonly seq: number; readonly author: string; readonly body: Record<string, unknown> }[] {
  return log.flatMap(([seq, , hex]) => {
    const event = JSON.parse(Buffer.from(hex, 'hex').subarray(96).toString('utf8')) as {
      type: string;
      author: string;
      body: Record<string, unknown>;
    };
    return event.type === type ? [{ seq, author: event.author, body: event.body }] : [];
  });
}

/**
 * The latest share sealed to `person` from `author` in their one group,
 * opened outside the app with their own key from their own device.
 */
export async function shareOf(person: Person, author: string): Promise<RecoveryShare> {
  const [group] = await storedGroups(person.page);
  const [stored] = await storedLogs(person.page);
  if (group?.kxKey == null || stored === undefined) throw new Error('Expected one group.');
  const kxKey = Uint8Array.from(group.kxKey);
  const opened = postedEvents(stored.log, 'recovery-share')
    .filter((posted) => posted.author === author && typeof posted.body.box === 'string')
    .map(({ body }) =>
      openShare({
        groupId: group.groupId,
        contact: group.author,
        author,
        kxKey,
        box: String(body.box),
      }),
    )
    .filter((share): share is RecoveryShare => share !== null);
  const latest = opened.at(-1);
  if (latest === undefined) throw new Error(`${person.name} holds no share from ${author}.`);
  return latest;
}
