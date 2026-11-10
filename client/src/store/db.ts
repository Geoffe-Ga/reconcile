/**
 * The device's store: every group it belongs to, kept in IndexedDB (ADR-0029).
 *
 * A group's record holds its secret and signing key, the relay-ordered log,
 * the outbox of signed records not yet accepted by the relay, and the sync
 * cursor. The mailbox id and seal key aren't kept: they derive from the
 * secret wherever they're needed (spec §3), so nothing stored can drift
 * from it. Each membership
 * has its own signing key, made for that group alone and kept only with its
 * records (ADR-0009), so two groups on one device share no key or id. Nothing
 * here touches the network. Each change reads and writes one group in a
 * single transaction, so a crash or a closed tab leaves either the old record
 * or the new one.
 *
 * Once a decided Proposal's ballots expire (#111), `clearBallots` deletes
 * them, its other results and anything else that expires with them from the
 * log and the outbox, and marks the Proposal `cleared`. From then on every
 * ingest drops such records for it, so none comes back from the relay.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import { expiryKeyOf } from '../engine/expiry';
import type { LogRecord } from '../engine/fold';
import { type Draft, draftIn, type DraftShelf, type DraftStore, withDraft } from './drafts';

/** Who this device is in a group. */
export interface Me {
  /** This membership's public key in base64url: the `author` every event this device makes carries. */
  author: string;
  /** The name this device joined with. */
  name: string;
}

/** Everything the device keeps about one group. */
export interface Group {
  /** The group's id. */
  groupId: string;
  /**
   * The 32-byte group secret, made at genesis, that only members hold. The
   * group's mailbox id and seal key derive from it (`crypto/groupKeys.ts`).
   */
  secret: Uint8Array;
  /** This membership's 32-byte Ed25519 secret key. It never leaves the device or this group. */
  signingKey: Uint8Array;
  /** This device's membership. */
  me: Me;
  /** Relay records in relay order, each event once: the input to `fold`. */
  log: LogRecord[];
  /** The highest seq read so far; the next GET asks for records after it. */
  cursor: number;
  /** The relay minute of the last successful GET, or `null` before one. */
  relayNow: number | null;
  /** The relay instance the cursor belongs to, or `null` before the first GET. */
  instance: string | null;
  /** Signed records this device made that the relay hasn't accepted yet, oldest first. */
  outbox: Uint8Array[];
  /** When the last sync succeeded, in device milliseconds, or `null` before one. */
  lastSyncAt: number | null;
  /** Private drafts by target, never sent (./drafts.ts). Absent until the first one. */
  drafts?: DraftShelf;
  /**
   * The Proposals whose ballots this device has deleted (#111), which `fold`
   * takes, oldest first. Absent until the first. #73's invite header and #78's
   * backup carry it, so a newcomer or a restored device knows which it can't check.
   */
  cleared?: string[];
}

/** A Proposal whose ballots expire now, and the event id of the result that stays. */
export interface Clearing {
  readonly proposal: string;
  readonly keep: string;
}

/** What a device knows about a group when it creates or joins it. */
export type NewGroup = Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'me'>;

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

/** The id of the event a record carries, or `null` when the record doesn't hold a signed event. */
export type EventIdOf = (bytes: Uint8Array) => string | null;

/** The device's groups. */
export interface Store extends DraftStore {
  /** Every group on the device. */
  listGroups(): Promise<Group[]>;
  /** One group, or `undefined` when the device isn't in it. */
  getGroup(groupId: string): Promise<Group | undefined>;
  /** Keep a new group; refuses an id the device already has. */
  addGroup(group: NewGroup): Promise<Group>;
  /**
   * Queue a signed record for the relay, after the ones already queued. A
   * Proposal or version names the `draft` target it came from, and that draft
   * goes in the same change, so a queued one never leaves its draft behind.
   *
   * @throws {RecordTooLarge} when the record is over 64,000 bytes.
   */
  enqueue(groupId: string, bytes: Uint8Array, draft?: string): Promise<void>;
  /**
   * Queue several signed records, in order, in one change, as `enqueue` does
   * one: a Proposal proposed again with its other versions (#74). If any is
   * over 64,000 bytes, none is queued and the draft stays.
   *
   * @throws {RecordTooLarge} when a record is over 64,000 bytes.
   */
  enqueueAll(groupId: string, records: readonly Uint8Array[], draft?: string): Promise<void>;
  /** Drop the first outbox entry with exactly these bytes, once the relay has it. */
  markSent(groupId: string, bytes: Uint8Array): Promise<void>;
  /**
   * Append each record whose event id isn't in the log yet, and save the sync
   * state. A ballot, a result or anything else that expires with ballots, for a
   * Proposal in `cleared`, is dropped (#111).
   */
  applyPull(groupId: string, pull: Pull, idOf: EventIdOf): Promise<void>;
  /**
   * In one change, delete from the log and the outbox every record that
   * expires with each Proposal's ballots, apart from the result it keeps, and
   * add the Proposal to `cleared` (#111).
   */
  clearBallots(groupId: string, clearings: readonly Clearing[]): Promise<void>;
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

/**
 * The schema version. Version 3 holds a real group secret, from which the
 * mailbox id and seal key derive (#71); version 2 held signed records (#69)
 * and version 1 the stub era's unsigned data. Older data, whose relay blobs
 * anyone could read, is deleted on upgrade, with no migration.
 */
const VERSION = 3;
const GROUPS = 'groups';

/** Open the store in the IndexedDB database `name`. */
export async function openStore(name = 'reconcile'): Promise<Store> {
  const db = await openDB<Schema>(name, VERSION, {
    upgrade(database) {
      if (database.objectStoreNames.contains(GROUPS)) {
        database.deleteObjectStore(GROUPS);
      }
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
  const changeQuietly = changer(db, () => undefined);
  const enqueueAll: Store['enqueueAll'] = async (groupId, records, draft) => {
    for (const { length } of records) {
      if (length > MAX_RECORD_BYTES) throw new RecordTooLarge(length);
    }
    await change(groupId, (group) => {
      group.outbox.push(...records);
      if (draft !== undefined) group.drafts = withDraft(group.drafts, draft, null);
    });
  };

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
    enqueue: (groupId, bytes, draft) => enqueueAll(groupId, [bytes], draft),
    enqueueAll,
    async readDraft(groupId, target) {
      const group = await db.get(GROUPS, groupId);
      return group === undefined ? undefined : draftIn(group, target);
    },
    // A draft changes nothing any screen reads from the store, so no listener hears of it.
    writeDraft: (groupId, target, draft: Draft | null) =>
      changeQuietly(groupId, (group) => {
        group.drafts = withDraft(group.drafts, target, draft);
      }),
    markSent: (groupId, bytes) =>
      change(groupId, (group) => {
        // Bytes are enough: a record's bytes fix its event, and the outbox posts in order.
        const index = group.outbox.findIndex((entry) => sameBytes(entry, bytes));
        if (index >= 0) {
          group.outbox.splice(index, 1);
        }
      }),
    applyPull: (groupId, pull, idOf) =>
      change(groupId, (group) => {
        const kept = withoutCleared(pull.records, group.cleared ?? []);
        group.log.push(...unseen(group.log, kept, idOf));
        group.cursor = pull.cursor;
        group.relayNow = pull.relayNow;
        group.instance = pull.instance;
        group.lastSyncAt = pull.lastSyncAt;
      }),
    clearBallots: (groupId, clearings) =>
      change(groupId, (group) => {
        const keep = new Map(clearings.map(({ proposal, keep }) => [proposal, keep]));
        const expires = (bytes: Uint8Array): boolean => {
          const key = expiryKeyOf(bytes);
          return key !== null && keep.has(key.proposal) && keep.get(key.proposal) !== key.id;
        };
        group.log = group.log.filter((record) => !expires(record.bytes));
        group.outbox = group.outbox.filter((bytes) => !expires(bytes));
        const cleared = group.cleared ?? [];
        group.cleared = [...cleared, ...[...keep.keys()].filter((id) => !cleared.includes(id))];
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

/**
 * The records of `incoming` that hold a signed event whose id is neither in
 * `log` nor earlier in `incoming`. A record that doesn't verify has no id, so
 * it is dropped and can never shadow the real record of the same event.
 */
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

/** The records of `incoming` that don't expire with a Proposal in `cleared`. */
function withoutCleared(incoming: LogRecord[], cleared: readonly string[]): LogRecord[] {
  if (cleared.length === 0) return incoming;
  return incoming.filter((record) => {
    const proposal = expiryKeyOf(record.bytes)?.proposal;
    return proposal === undefined || !cleared.includes(proposal);
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
