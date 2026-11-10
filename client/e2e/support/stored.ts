/**
 * What a device keeps, read straight from its IndexedDB with no hook into the
 * app, and the derivations spec §3 makes from it, done by Node's own crypto.
 */
import { hkdfSync } from 'node:crypto';

import type { Page } from '@playwright/test';

/** What a device keeps for one group. */
export interface StoredGroup {
  readonly groupId: string;
  readonly secret: number[];
  readonly signingKey: number[];
  readonly author: string;
}

/** HKDF-SHA-256 of `secret` with an empty salt, by Node's own crypto: spec §3's derivations. */
export function derive(secret: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

/** The groups in the app's IndexedDB on `page`. */
export function storedGroups(page: Page): Promise<StoredGroup[]> {
  return page.evaluate(async () => {
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
      const groups = (await request(db.transaction('groups').objectStore('groups').getAll())) as {
        groupId: string;
        secret: Uint8Array;
        signingKey: Uint8Array;
        me: { author: string };
      }[];
      return groups.map((group) => ({
        groupId: group.groupId,
        secret: Array.from(group.secret),
        signingKey: Array.from(group.signingKey),
        author: group.me.author,
      }));
    } finally {
      db.close();
    }
  });
}

/** One group's relay-ordered log on a device: each record's seq, receipt time and bytes in hex. */
export interface StoredLog {
  readonly groupId: string;
  readonly author: string;
  readonly log: readonly (readonly [number, number, string])[];
}

/** Every group's log in the app's IndexedDB on `page`, so two devices' folds can be compared (#78). */
export function storedLogs(page: Page): Promise<StoredLog[]> {
  return page.evaluate(async () => {
    const request = <T>(asking: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        asking.onsuccess = () => {
          resolve(asking.result);
        };
        asking.onerror = () => {
          reject(asking.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const hex = (bytes: Uint8Array): string =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const db = await request(indexedDB.open('reconcile'));
    try {
      const groups = (await request(db.transaction('groups').objectStore('groups').getAll())) as {
        groupId: string;
        me: { author: string };
        log: { seq: number; received: number; bytes: Uint8Array }[];
      }[];
      return groups.map((group) => ({
        groupId: group.groupId,
        author: group.me.author,
        log: group.log.map(({ seq, received, bytes }) => [seq, received, hex(bytes)] as const),
      }));
    } finally {
      db.close();
    }
  });
}

/** The one group `page`'s device holds, or a clear stop when it holds another number. */
export async function onlyGroup(page: Page): Promise<StoredGroup> {
  const groups = await storedGroups(page);
  const [group] = groups;
  if (group === undefined || groups.length !== 1) {
    throw new Error(`Expected the device to hold exactly one group, not ${String(groups.length)}.`);
  }
  return group;
}
