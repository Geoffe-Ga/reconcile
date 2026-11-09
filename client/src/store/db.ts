/**
 * The device's store: every group it belongs to, kept in IndexedDB (ADR-0029).
 *
 * A group's record holds its keys, the relay-ordered log, the outbox of events
 * not yet accepted by the relay, and the sync cursor. Nothing here touches the
 * network. Each change reads and writes one group in a single transaction, so
 * a crash or a closed tab leaves either the old record or the new one.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

import { bucketFor } from '../crypto/seal';

/** Who this device is in a group. */
export interface Me {
  /** The author key every event this device makes carries. */
  author: string;
  /** The name this device joined with. */
  name: string;
}

/** One relay record in the log: an opened event with its place in relay order. */
export interface LogRecord {
  /** The relay's seq for it. */
  seq: number;
  /** The relay minute it arrived. */
  received: number;
  /** The event's exact bytes, as opened from the blob. */
  bytes: Uint8Array;
}

/** Everything the device keeps about one group. */
export interface Group {
  /** The group's id. */
  groupId: string;
  /** The group's one mailbox at the relay. */
  mailbox: string;
  /** STUB(seal): the group secret, used as the seal key until #71 derives one from it. */
  secret: Uint8Array;
  /** This device's membership. */
  me: Me;
  /** Relay records in relay order, each event once. */
  log: LogRecord[];
  /** The highest seq read so far; the next GET asks for records after it. */
  cursor: number;
  /** The relay minute of the last successful GET, or `null` before one. */
  relayNow: number | null;
  /** The relay instance the cursor belongs to, or `null` before the first GET. */
  instance: string | null;
  /** Event bytes this device made that the relay hasn't accepted yet, oldest first. */
  outbox: Uint8Array[];
  /** When the last sync succeeded, in device milliseconds, or `null` before one. */
  lastSyncAt: number | null;
}

/** What a device knows about a group when it creates or joins it. */
export type NewGroup = Pick<Group, 'groupId' | 'mailbox' | 'secret' | 'me'>;

/** What one sync pass read from the relay. */
export interface Pull {
  /** The opened records, in relay order; ones already in the log are skipped. */
  records: LogRecord[];
  /** The highest seq the pass read up to. */
  cursor: number;
  /** The relay minute it reported. */
  relayNow: number;
  /** The relay instance it reported. */
  instance: string;
  /** When the pass finished, in device milliseconds. */
  lastSyncAt: number;
}

/** An event's id, or `null` when the bytes aren't an event. */
export type EventIdOf = (bytes: Uint8Array) => string | null;

/** The device's groups. */
export interface Store {
  /** Every group on the device. */
  listGroups(): Promise<Group[]>;
  /** One group, or `undefined` when the device isn't in it. */
  getGroup(groupId: string): Promise<Group | undefined>;
  /** Keep a new group; refuses an id the device already has. */
  addGroup(group: NewGroup): Promise<Group>;
  /**
   * Queue an event for the relay, after the ones already queued.
   *
   * @throws {PayloadTooLarge} when the event can't fit in any blob.
   */
  enqueue(groupId: string, bytes: Uint8Array): Promise<void>;
  /** Drop the first outbox entry with exactly these bytes, once the relay has it. */
  markSent(groupId: string, bytes: Uint8Array): Promise<void>;
  /** Append each record whose event id isn't in the log yet, and save the sync state. */
  applyPull(groupId: string, pull: Pull, idOf: EventIdOf): Promise<void>;
  /** Start over at seq 0 of a relay `instance` the device hasn't seen. */
  resetCursor(groupId: string, instance: string): Promise<void>;
  /** Hear which group changed after each change; returns the way to stop. */
  subscribe(listener: (groupId: string) => void): () => void;
  /** Close the database. */
  close(): void;
}

interface Schema extends DBSchema {
  groups: { key: string; value: Group };
}

const VERSION = 1;
const GROUPS = 'groups';

/** Open the store in the IndexedDB database `name`. */
export async function openStore(name = 'reconcile'): Promise<Store> {
  const db = await openDB<Schema>(name, VERSION, {
    upgrade(database) {
      database.createObjectStore(GROUPS, { keyPath: 'groupId' });
    },
  });
  const listeners = new Set<(groupId: string) => void>();
  const notify = (groupId: string): void => {
    for (const listener of listeners) {
      listener(groupId);
    }
  };
  const change = changer(db, notify);

  return {
    listGroups: () => db.getAll(GROUPS),
    getGroup: (groupId) => db.get(GROUPS, groupId),
    async addGroup(group) {
      const stored: Group = {
        ...group,
        log: [],
        cursor: 0,
        relayNow: null,
        instance: null,
        outbox: [],
        lastSyncAt: null,
      };
      await db.add(GROUPS, stored);
      notify(group.groupId);
      return stored;
    },
    async enqueue(groupId, bytes) {
      bucketFor(bytes.length);
      await change(groupId, (group) => {
        group.outbox.push(bytes);
      });
    },
    markSent: (groupId, bytes) =>
      change(groupId, (group) => {
        const index = group.outbox.findIndex((entry) => sameBytes(entry, bytes));
        if (index >= 0) {
          group.outbox.splice(index, 1);
        }
      }),
    applyPull: (groupId, pull, idOf) =>
      change(groupId, (group) => {
        group.log.push(...unseen(group.log, pull.records, idOf));
        group.cursor = pull.cursor;
        group.relayNow = pull.relayNow;
        group.instance = pull.instance;
        group.lastSyncAt = pull.lastSyncAt;
      }),
    resetCursor: (groupId, instance) =>
      change(groupId, (group) => {
        group.cursor = 0;
        group.instance = instance;
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      db.close();
    },
  };
}

/** A function that edits one group in one read-write transaction, then notifies. */
function changer(
  db: IDBPDatabase<Schema>,
  notify: (groupId: string) => void,
): (groupId: string, edit: (group: Group) => void) => Promise<void> {
  return async (groupId, edit) => {
    const tx = db.transaction(GROUPS, 'readwrite');
    const group = await tx.store.get(groupId);
    if (group === undefined) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error('No such group on this device.');
    }
    edit(group);
    await Promise.all([tx.store.put(group), tx.done]);
    notify(groupId);
  };
}

/** The records of `incoming` whose event id is neither in `log` nor earlier in `incoming`. */
function unseen(log: LogRecord[], incoming: LogRecord[], idOf: EventIdOf): LogRecord[] {
  if (incoming.length === 0) {
    return [];
  }
  const seen = new Set(log.map((record) => idOf(record.bytes)));
  return incoming.filter((record) => {
    const id = idOf(record.bytes);
    if (id === null || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
