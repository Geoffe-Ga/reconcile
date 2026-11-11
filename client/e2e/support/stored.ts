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
  /** Its X25519 secret key (#98), or none for a group kept before #98. */
  readonly kxKey: number[] | null;
  /** The epoch of `secret` (#98): 0 until the group's key first changes. */
  readonly epoch: number;
}

/** HKDF-SHA-256 of `secret` with an empty salt, by Node's own crypto: spec §3's derivations. */
export function derive(secret: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

/** Minutes in a relay week (#110): weeks turn over on Thursday at 00:00 UTC. */
export const WEEK_MINUTES = 10_080;

/** The relay week of relay minute `minute` (#110). */
export function weekOf(minute: number): number {
  return Math.floor(minute / WEEK_MINUTES);
}

/**
 * A group's mailbox id for relay week `week` (#110), by Node's own crypto:
 * HKDF-SHA-256 of the secret with an empty salt, under the info
 * `reconcile/v1/mailbox-week` ‖ 0x00 ‖ the week's 4 big-endian bytes.
 */
export function weekMailbox(secret: Uint8Array, week: number): string {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(week, 1);
  const info = Buffer.concat([Buffer.from('reconcile/v1/mailbox-week'), tail]);
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32)).toString('base64url');
}

/**
 * A group's mailbox ids from last week's to next week's, by the clock this
 * machine shares with the test relay: every id the group's traffic in a run
 * can name, even one that crosses Thursday 00:00 UTC (#110).
 */
export function groupMailboxes(secret: Uint8Array): string[] {
  const week = weekOf(Math.floor(Date.now() / 60_000));
  return [week - 1, week, week + 1].map((each) => weekMailbox(secret, each));
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
        kxKey?: Uint8Array;
        epoch?: number;
        me: { author: string };
      }[];
      return groups.map((group) => ({
        groupId: group.groupId,
        secret: Array.from(group.secret),
        signingKey: Array.from(group.signingKey),
        author: group.me.author,
        kxKey: group.kxKey === undefined ? null : Array.from(group.kxKey),
        epoch: group.epoch ?? 0,
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
