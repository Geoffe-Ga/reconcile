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
 * or the new one. Everything the device keeps about a group lives in that one
 * record, so Leave deletes the group with a single delete (#77), the chat
 * bot's claims (#119) included. A backup file's groups come back in one
 * transaction too (#78), and the store closes itself when another tab
 * deletes or upgrades its database, so Erase never waits on a connection
 * left open. Personal Documents (#93) sit in a store of their own beside the
 * groups (`./personal.ts`), and a backup file brings them back in that same
 * transaction. A dissolved group stays as a read-only archive (#108): nothing
 * more is queued, claimed or sent for it, and its ballots and notes can be
 * cleared while its outcomes stay.
 *
 * Once the device locks its keys with a passkey (#95), every secret leaves
 * the group records for one sealed vault record (`./vault.ts`), and the
 * records keep the rest. A store opened on such a device reads nothing until
 * {@link Store.unlock} gets the vault key from the passkey; it keeps that key
 * in memory for the session, opens the vault inside each read's transaction
 * and hands back whole groups, so nothing else in the app changes. Every
 * write of key material (Create group and Join, a backup's import, a group
 * leaving or removed) goes through one function, `keepKeys`, which seals the
 * keys into the vault when there is one and refuses while it's locked, in
 * the same transaction as the records it writes.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import type { BotMoment } from '../engine/chatPosts';
import type { GroupState, LogRecord } from '../engine/fold';
import type { TallyDetail } from '../engine/tally';
import { type Draft, draftIn, type DraftShelf, type DraftStore, withDraft } from './drafts';
import {
  type GroupKeys,
  newVault,
  openKeys,
  resealKeys,
  VAULT_ID,
  type VaultLock,
  type VaultRecord,
} from './vault';
import {
  byCreation,
  isPersonalDocument,
  keepsHeldCopy,
  type PersonalDocument,
  type PersonalStore,
} from './personal';

/** Who this device is in a group. */
export interface Me {
  /** This membership's public key in base64url: the `author` every event this device makes carries. */
  author: string;
  /** The name this device joined with. */
  name: string;
}

/**
 * A chat bot claim this device made (#119): its `chat-posted` event's id, and
 * the Proposal and moment it claims. Only the device that made the winning
 * claim posts it, and it knows the claim by this id.
 */
export interface ChatClaim {
  readonly id: string;
  readonly proposal: string;
  readonly moment: BotMoment;
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
   * Set when a sync succeeded more than {@link HISTORY_GAP_MS} after the one
   * before, so the relay may have dropped events this device never read
   * (#73). Only {@link Store.mergeLog} clears it. Absent until first set.
   */
  missingHistory?: boolean;
  /**
   * The signed `leave` this device queued (#77), while the group waits to be
   * deleted: absent until Leave. Nothing more is queued after it, and the sync
   * loop purges the group once the relay returns a seq for it.
   */
  leaving?: Uint8Array;
  /**
   * How the group stands with backups on this device (#78): `saved` once it
   * is in a backup file this device saved or restored from, `not-now` once
   * the person answered Not now on group home's backup card. Absent until
   * either, and group home suggests a backup while it is.
   */
  backup?: BackupMark;
  /**
   * The chat bot claims this device made and hasn't settled yet (#119), oldest
   * first: each is posted once if it won, or dropped. Absent until the first.
   */
  chatClaims?: ChatClaim[];
  /**
   * Set once the group is read-only on this device (#108): absent while it
   * goes on. Nothing is queued, claimed or synced for it from then on.
   */
  archived?: Archive;
}

/** Why a group only reads on this device: it dissolved (#108). #115 adds a removal. */
export type ArchiveReason = 'dissolved';

/**
 * A dissolved archive once this device has cleared its ballots and notes
 * (#108; ADR-0075 §5): the group as the device last folded it, every ballot
 * and note taken out, with each decided Proposal's totals and outcome from
 * the device's own tally. The log that held the ballots is gone.
 */
export interface ClearedArchive {
  /** When this device cleared them, in device milliseconds. */
  readonly at: number;
  /** The group's folded state then, with no ballot on any Proposal. */
  readonly state: GroupState;
  /** Each decided Proposal's totals and outcome, by its id. */
  readonly tallies: Readonly<Record<string, TallyDetail>>;
}

/** A group this device keeps read-only (#108): why, and its cleared state once cleared. */
export interface Archive {
  readonly reason: ArchiveReason;
  readonly cleared?: ClearedArchive;
}

/** A group's backup mark (#78): in a backup file, or the backup card answered Not now. */
export type BackupMark = 'saved' | 'not-now';

/**
 * A group as its IndexedDB record holds it: everything but its secret and
 * signing key once the device has a vault (#95), which holds those instead.
 */
type StoredGroup = Omit<Group, keyof GroupKeys> & Partial<GroupKeys>;

/** Thrown when key material is read or written while the vault is locked (#95). */
export class VaultLocked extends Error {
  /** Say the keys are locked. */
  constructor() {
    super('This device’s keys are locked with a passkey.');
    this.name = 'VaultLocked';
  }
}

/**
 * A group as a backup file carries it (#78): its keys, secret, your name, its
 * relay-ordered log and sync state, and whether some history may be missing.
 * Never the outbox or drafts, so a restore never sends stale intent. A file
 * never holds `archived`: a restore sets it when the log folds to a
 * `dissolve` (#108), so the group comes back read-only.
 */
export type BackedUpGroup = Pick<
  Group,
  | 'groupId'
  | 'secret'
  | 'signingKey'
  | 'me'
  | 'log'
  | 'cursor'
  | 'relayNow'
  | 'instance'
  | 'lastSyncAt'
  | 'archived'
> & { readonly missingHistory: boolean };

/**
 * The longest gap between syncs that can't have missed an event: 28 days. The
 * relay keeps blobs 30 days, rounded up by a day (ADR-0057), so a device away
 * for longer may find some already gone.
 */
export const HISTORY_GAP_MS = 28 * 86_400_000;

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

/** The device's groups, and its personal Documents (#93). */
export interface Store extends DraftStore, PersonalStore {
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
  /**
   * Queue this member's signed `leave` after everything already queued, and
   * mark the group as leaving, in one change (#77). From then on nothing else
   * is queued, and it stays this way across reloads until the relay has the
   * leave. A group already leaving keeps its first leave.
   */
  markLeaving(groupId: string, leave: Uint8Array): Promise<void>;
  /**
   * Queue a signed `chat-posted` claim and keep it as one of this device's
   * claims, in one change (#119). Returns false, changing nothing, when this
   * device already holds a claim of that moment, as a second tab might, or the
   * group is leaving or archived (#108).
   *
   * @throws {RecordTooLarge} when the record is over 64,000 bytes.
   */
  claimChat(groupId: string, record: Uint8Array, claim: ChatClaim): Promise<boolean>;
  /**
   * Drop the claim `id` from this device's claims, in one change, and return
   * whether it was there. Two tabs settling one claim can't both hear true,
   * so a claim is posted at most once. No screen reads claims, so no listener
   * hears of it.
   */
  settleChatClaim(groupId: string, id: string): Promise<boolean>;
  /**
   * Delete everything this device keeps about the group, in one transaction:
   * its log, cursor, outbox, keys, secret, drafts and flags. The sync loop
   * calls it once the relay has returned a seq for the group's leave, a
   * dissolved group's wipe calls it, and so does Remove from this device
   * (#108). A group that is already gone is left alone.
   */
  purgeGroup(groupId: string): Promise<void>;
  /**
   * Keep the group read-only on this device, in one change (#108; #115
   * reuses it): drop its outbox, its drafts, any leave and the chat bot's
   * claims (#119), and mark it archived for `reason`. From then on nothing is
   * queued or claimed for it, and the sync loop sends, reads and posts
   * nothing for it. A group already archived keeps its archive.
   */
  markArchived(groupId: string, reason: ArchiveReason): Promise<void>;
  /**
   * Clear an archived group's ballots and notes, in one change (#108): keep
   * `cleared`, the state to show from now on, and drop the log that held
   * them. Refuses a group that isn't archived.
   */
  clearArchive(groupId: string, cleared: ClearedArchive): Promise<void>;
  /** Drop the first outbox entry with exactly these bytes, once the relay has it. */
  markSent(groupId: string, bytes: Uint8Array): Promise<void>;
  /**
   * Append each record whose event id isn't in the log yet, and save the sync
   * state. A pull more than {@link HISTORY_GAP_MS} after the last sync sets
   * `missingHistory`.
   */
  applyPull(groupId: string, pull: Pull, idOf: EventIdOf): Promise<void>;
  /**
   * Add each of an invite's `records` whose event id the log lacks, each in
   * seq order among the records already there, and clear `missingHistory`
   * (#73). The cursor and sync state stay as they are. A read-only archive
   * takes nothing (#108), so a cleared one never gets its ballots back.
   */
  mergeLog(groupId: string, records: readonly LogRecord[], idOf: EventIdOf): Promise<void>;
  /**
   * Keep a backup file's groups and personal Documents, in one transaction
   * (#78, #93). A group new to the device is kept as the file has it, with an
   * empty outbox, no drafts and no chat claims (#119). For a group already
   * here, whichever whole copy synced later stays: the file's replaces the
   * device's only when its last sync is later, and a group this device is
   * leaving or keeps read-only (#108) stays as it is. Either way the group is
   * marked `saved`, since a backup file holds it. A personal Document merges
   * by id the same way: the file's replaces the device's only when it was
   * edited later (`keepsHeldCopy`). Nothing is stamped with the time now.
   */
  restoreGroups(
    groups: readonly BackedUpGroup[],
    personal?: readonly PersonalDocument[],
  ): Promise<void>;
  /** Mark each of these groups still on the device, in one transaction (#78). */
  markBackup(groupIds: readonly string[], mark: BackupMark): Promise<void>;
  /** Start over at seq 0 of a relay `instance` the device hasn't seen. */
  resetCursor(groupId: string, instance: string): Promise<void>;
  /**
   * The passkey that opens this device's vault and the salt it's asked with,
   * or null when its keys aren't locked with a passkey (#95).
   */
  readVault(): Promise<VaultLock | null>;
  /**
   * Seal every secret on the device under the vault `key`, for the passkey
   * `lock`, and delete the plain copies, in one transaction (#95). From then
   * on this session holds the key, and every later secret goes into the vault.
   *
   * @throws {Error} when the device already has a vault; nothing changes.
   */
  sealKeys(lock: VaultLock, key: Uint8Array): Promise<void>;
  /**
   * Open the vault under `key` for this session, keeping a copy of it, and
   * return true; false, keeping nothing, when the device has no vault or the
   * key doesn't open it. It never writes.
   */
  unlock(key: Uint8Array): Promise<boolean>;
  /**
   * Resolve when this session may read and hand on key material: the device
   * has no vault, or this session sealed or unlocked it (#95). Anything that
   * hands keys anywhere calls it first: Save a backup today, and #96's Link
   * a new device. Erase never does, so a device whose passkey is lost can
   * still start over.
   *
   * @throws {VaultLocked} when the device has a vault this session hasn't opened.
   */
  requireUnlocked(): Promise<void>;
  /**
   * Replace every group on the device and the vault with a backup file's
   * groups, in one transaction: Restore when the passkey no longer unlocks
   * the vault (#95). Each is kept as a restore keeps a new group, its keys in
   * its record, since no vault is left to seal them in. The file's personal
   * Documents, which hold no key, merge as {@link Store.restoreGroups} merges
   * them.
   */
  replaceGroups(
    groups: readonly BackedUpGroup[],
    personal?: readonly PersonalDocument[],
  ): Promise<void>;
  /** Hear which group changed after each change; returns the way to stop. */
  subscribe(listener: (groupId: string) => void): () => void;
  /** Close the database. */
  close(): void;
}

interface Schema extends DBSchema {
  groups: { key: string; value: StoredGroup };
  personal: { key: string; value: PersonalDocument };
  vault: { key: string; value: VaultRecord };
}

/**
 * The schema version. Version 5 adds the key vault (#95), and version 4 the
 * personal store (#93); neither deletes anything. Version 3 holds a real
 * group secret, from which the mailbox id and seal key derive (#71); version
 * 2 held signed records (#69) and version 1 the stub era's unsigned data.
 * That older data, whose relay blobs anyone could read, is deleted on
 * upgrade, with no migration. A dissolved group's `archived` mark (#108) is
 * an optional field of its record, so it needed no version of its own: a
 * version 3 group that holds one keeps it through the upgrade.
 */
const VERSION = 5;
const GROUPS = 'groups';
const PERSONAL = 'personal';
const VAULT = 'vault';

/** Every object store: the records, the personal Documents and the vault. */
type Stores = ('groups' | 'personal' | 'vault')[];

/** A read-write transaction over every store, the only kind that writes key material. */
type KeyTransaction = IDBPTransaction<Schema, Stores, 'readwrite'>;

/**
 * Brings a database at `oldVersion` up to {@link VERSION}: groups from before
 * version 3 are deleted, then the personal store and the vault are added
 * beside whatever groups version 3 kept.
 */
function upgradeFrom(database: IDBPDatabase<Schema>, oldVersion: number): void {
  if (oldVersion < 3) {
    if (database.objectStoreNames.contains(GROUPS)) database.deleteObjectStore(GROUPS);
    database.createObjectStore(GROUPS, { keyPath: 'groupId' });
  }
  if (oldVersion < 4) database.createObjectStore(PERSONAL, { keyPath: 'id' });
  if (oldVersion < 5) database.createObjectStore(VAULT, { keyPath: 'id' });
}

/** The IndexedDB database the app keeps its groups in. */
export const DATABASE_NAME = 'reconcile';

/**
 * Open the store in the IndexedDB database `name`. When another tab deletes
 * the database (Erase, #78) or opens a newer version of it, this connection
 * closes, so that tab never waits on this one.
 */
export async function openStore(name = DATABASE_NAME): Promise<Store> {
  const db = await openDB<Schema>(name, VERSION, {
    upgrade(database, oldVersion) {
      upgradeFrom(database, oldVersion);
    },
    blocking() {
      db.close();
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
  // The vault key, once this session has sealed or unlocked the vault (#95).
  const session: Session = { key: null };
  const enqueueAll: Store['enqueueAll'] = async (groupId, records, draft) => {
    for (const { length } of records) {
      if (length > MAX_RECORD_BYTES) throw new RecordTooLarge(length);
    }
    await change(groupId, (group) => {
      if (group.leaving !== undefined) throw new Error('This group is leaving this device.');
      if (group.archived !== undefined) throw new Error('This group is read-only on this device.');
      group.outbox.push(...records);
      if (draft !== undefined) group.drafts = withDraft(group.drafts, draft, null);
    });
  };

  return {
    listGroups: () => readWhole(db, session, null),
    getGroup: async (groupId) => {
      const [group] = await readWhole(db, session, groupId);
      return group;
    },
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
      await writeKeys(db, async (tx) => {
        if ((await tx.objectStore(GROUPS).getKey(group.groupId)) !== undefined) {
          throw new Error('This device already holds that group.');
        }
        await keepKeys(tx, session, { put: [stored] });
      });
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
    markLeaving: (groupId, leave) =>
      change(groupId, (group) => {
        if (group.leaving !== undefined) return;
        group.outbox.push(leave);
        group.leaving = leave;
      }),
    async claimChat(groupId, record, claim) {
      if (record.length > MAX_RECORD_BYTES) throw new RecordTooLarge(record.length);
      let queued = false;
      await change(groupId, (group) => {
        const held = group.chatClaims ?? [];
        const same = held.some((c) => c.proposal === claim.proposal && c.moment === claim.moment);
        if (group.leaving !== undefined || group.archived !== undefined || same) return;
        group.outbox.push(record);
        group.chatClaims = [...held, claim];
        queued = true;
      });
      return queued;
    },
    async settleChatClaim(groupId, id) {
      let held = false;
      await changeQuietly(groupId, (group) => {
        const claims = group.chatClaims ?? [];
        held = claims.some((claim) => claim.id === id);
        group.chatClaims = claims.filter((claim) => claim.id !== id);
      });
      return held;
    },
    async purgeGroup(groupId) {
      const found = await writeKeys(db, async (tx) => {
        if ((await tx.objectStore(GROUPS).getKey(groupId)) === undefined) return false;
        await keepKeys(tx, session, { drop: [groupId] });
        return true;
      });
      if (found) notify(groupId);
    },
    markArchived: (groupId, reason) =>
      change(groupId, (group) => {
        if (group.archived !== undefined) return;
        group.archived = { reason };
        group.outbox = [];
        delete group.drafts;
        delete group.leaving;
        delete group.chatClaims;
      }),
    clearArchive: (groupId, cleared) =>
      change(groupId, (group) => {
        if (group.archived === undefined) throw new Error('This group isn’t archived.');
        group.archived = { ...group.archived, cleared };
        group.log = [];
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
        if (group.lastSyncAt !== null && pull.lastSyncAt - group.lastSyncAt > HISTORY_GAP_MS) {
          group.missingHistory = true;
        }
        group.log.push(...unseen(group.log, pull.records, idOf));
        group.cursor = pull.cursor;
        group.relayNow = pull.relayNow;
        group.instance = pull.instance;
        group.lastSyncAt = pull.lastSyncAt;
      }),
    mergeLog: (groupId, records, idOf) =>
      change(groupId, (group) => {
        if (group.archived !== undefined) return;
        group.log = inSeqOrder(group.log, unseen(group.log, records, idOf));
        group.missingHistory = false;
      }),
    async restoreGroups(groups, personal = []) {
      // Anything that fails takes the whole restore with it, groups and Documents alike.
      await writeKeys(db, (tx) => restoreInto(tx, session, groups, personal));
      for (const { groupId } of groups) notify(groupId);
    },
    async markBackup(groupIds, mark) {
      const tx = db.transaction(GROUPS, 'readwrite');
      const marked: string[] = [];
      for (const groupId of groupIds) {
        const group = await tx.store.get(groupId);
        if (group === undefined) continue;
        group.backup = mark;
        await tx.store.put(group);
        marked.push(groupId);
      }
      await tx.done;
      for (const groupId of marked) notify(groupId);
    },
    async listPersonal() {
      return (await db.getAll(PERSONAL)).sort(byCreation);
    },
    getPersonal: (id) => db.get(PERSONAL, id),
    async savePersonal(document) {
      if (!isPersonalDocument(document)) {
        throw new Error('This isn’t a personal Document this device can keep.');
      }
      await db.put(PERSONAL, document);
    },
    deletePersonal: (id) => db.delete(PERSONAL, id),
    resetCursor: (groupId, instance) =>
      change(groupId, (group) => {
        group.cursor = 0;
        group.instance = instance;
      }),
    async readVault() {
      const vault = await db.get(VAULT, VAULT_ID);
      return vault === undefined
        ? null
        : { credentialId: vault.credentialId, prfSalt: vault.prfSalt };
    },
    async sealKeys(lock, key) {
      const sealing: Session = { key: Uint8Array.from(key) };
      try {
        await writeKeys(db, async (tx) => {
          const vaults = tx.objectStore(VAULT);
          if ((await vaults.getKey(VAULT_ID)) !== undefined) {
            throw new Error('This device’s keys are already locked with a passkey.');
          }
          await vaults.put(newVault(lock, key));
          const records = await tx.objectStore(GROUPS).getAll();
          await keepKeys(tx, sealing, { put: records.map((record) => wholeGroup(record, null)) });
        });
      } catch (error) {
        sealing.key?.fill(0);
        throw error;
      }
      session.key = sealing.key;
    },
    async unlock(key) {
      const vault = await db.get(VAULT, VAULT_ID);
      if (vault === undefined || openKeys(vault, key) === null) return false;
      session.key = Uint8Array.from(key);
      return true;
    },
    async requireUnlocked() {
      const tx = db.transaction([GROUPS, VAULT]);
      await vaultKeys(tx, session);
      await tx.done;
    },
    async replaceGroups(groups, personal = []) {
      await writeKeys(db, async (tx) => {
        await tx.objectStore(GROUPS).clear();
        await tx.objectStore(VAULT).clear();
        await restoreInto(tx, session, groups, personal);
      });
      session.key?.fill(0);
      session.key = null;
      for (const { groupId } of groups) notify(groupId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      db.close();
    },
  };
}

/**
 * Aborts `tx` and waits for it to end. A transaction that a failed request
 * has already aborted can't be aborted again, and that's fine: either way,
 * nothing it wrote stays.
 */
async function abandon(tx: KeyTransaction): Promise<void> {
  try {
    tx.abort();
  } catch {
    // Already aborted by the request that failed.
  }
  await tx.done.catch(() => undefined);
}

/**
 * Puts each group and personal Document a backup holds into `tx`, keeping
 * the device's copy wherever it's the one to keep (`keptCopy`,
 * `keepsHeldCopy`). The groups' keys go through `keepKeys`, so with a vault
 * they're resealed under the session's key.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function restoreInto(
  tx: KeyTransaction,
  session: Session,
  groups: readonly BackedUpGroup[],
  personal: readonly PersonalDocument[],
): Promise<void> {
  const opened = await vaultKeys(tx, session);
  const records = tx.objectStore(GROUPS);
  const kept: Group[] = [];
  for (const restored of groups) {
    const held = await records.get(restored.groupId);
    kept.push(keptCopy(held === undefined ? undefined : wholeGroup(held, opened), restored));
  }
  await keepKeys(tx, session, { put: kept });
  const documents = tx.objectStore(PERSONAL);
  for (const restored of personal) {
    if (!keepsHeldCopy(await documents.get(restored.id), restored)) await documents.put(restored);
  }
}

/**
 * The copy of a group to keep when a backup file holds `restored` and the
 * device holds `held` (#78): the file's, with no outbox, drafts or chat
 * claims, unless the device's synced at least as late, is leaving, or is a
 * read-only archive, which a restore never brings back to life (#108).
 * Either is marked `saved`.
 */
function keptCopy(held: Group | undefined, restored: BackedUpGroup): Group {
  if (held !== undefined && (stays(held) || syncedSince(held, restored))) {
    return { ...held, backup: 'saved' };
  }
  return { ...restored, outbox: [], backup: 'saved' };
}

/** Whether a restore leaves `held` as it is: the device is leaving it, or keeps it read-only. */
function stays(held: Group): boolean {
  return held.leaving !== undefined || held.archived !== undefined;
}

/** Whether `held` last synced no earlier than `restored`; a copy that never synced is the oldest. */
function syncedSince(held: Group, restored: BackedUpGroup): boolean {
  return (held.lastSyncAt ?? -Infinity) >= (restored.lastSyncAt ?? -Infinity);
}

/** This session's hold on the vault key: null until it seals or unlocks the vault. */
interface Session {
  key: Uint8Array | null;
}

/** The opened vault: its record, the keys it holds, and the key that opened it. */
interface OpenedVault {
  readonly vault: VaultRecord;
  readonly keys: Map<string, GroupKeys>;
  readonly key: Uint8Array;
}

/**
 * The vault opened inside `tx`, or null when the device has none.
 *
 * @throws {VaultLocked} when it has one this session can't open.
 */
async function vaultKeys<Mode extends IDBTransactionMode>(
  tx: IDBPTransaction<Schema, Stores, Mode>,
  session: Session,
): Promise<OpenedVault | null> {
  return opened(await tx.objectStore(VAULT).get(VAULT_ID), session);
}

/**
 * `vault` opened under the session's key, or null when the device has none.
 *
 * @throws {VaultLocked} when it has one this session can't open.
 */
function opened(vault: VaultRecord | undefined, session: Session): OpenedVault | null {
  if (vault === undefined) return null;
  const { key } = session;
  const keys = key === null ? null : openKeys(vault, key);
  if (key === null || keys === null) throw new VaultLocked();
  return { vault, keys, key };
}

/** Whether `record` holds its own keys, as every record does on a device with no vault. */
function hasKeys(record: StoredGroup): boolean {
  return record.secret !== undefined && record.signingKey !== undefined;
}

/** `record` with its keys: its own without a vault, or the vault's. */
function wholeGroup(record: StoredGroup, opened: OpenedVault | null): Group {
  const keys = opened === null ? record : opened.keys.get(record.groupId);
  if (keys?.secret === undefined || keys.signingKey === undefined) {
    throw new Error('A group’s keys are missing from this device.');
  }
  return { ...record, secret: keys.secret, signingKey: keys.signingKey };
}

/**
 * The group `groupId`, or every group when it's null, each with its keys,
 * read with the vault in one read-only transaction. As with `db.get`,
 * nothing waits on the transaction's end once its reads are in.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function readWhole(
  db: IDBPDatabase<Schema>,
  session: Session,
  groupId: string | null,
): Promise<Group[]> {
  const tx = db.transaction([GROUPS, VAULT]);
  const records = tx.objectStore(GROUPS);
  const read = groupId === null ? await records.getAll() : [await records.get(groupId)];
  // A record holds its own keys exactly when the device has no vault, so a
  // plain device reads as it always has, and the vault is read only when needed.
  const plain = read.every((record) => record === undefined || hasKeys(record));
  const keys = plain ? null : opened(await tx.objectStore(VAULT).get(VAULT_ID), session);
  return read.flatMap((record) => (record === undefined ? [] : [wholeGroup(record, keys)]));
}

/** What one write of key material does: the groups to put, whole, and the ones to delete. */
interface KeyChange {
  readonly put?: readonly Group[];
  readonly drop?: readonly string[];
}

/**
 * The one write path for key material (#95). Inside `tx`, deletes each group
 * in `drop` and puts each in `put`. Without a vault, each record holds its
 * own keys, as before the vault. With one, every key goes into the vault,
 * resealed under the session's key in the same transaction, and each record
 * goes without them, so no secret is ever written outside it.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function keepKeys(tx: KeyTransaction, session: Session, change: KeyChange): Promise<void> {
  const records = tx.objectStore(GROUPS);
  const opened = await vaultKeys(tx, session);
  for (const groupId of change.drop ?? []) {
    await records.delete(groupId);
    opened?.keys.delete(groupId);
  }
  for (const group of change.put ?? []) {
    const { secret, signingKey, ...rest } = group;
    opened?.keys.set(group.groupId, { secret, signingKey });
    await records.put(opened === null ? group : rest);
  }
  if (opened !== null) {
    await tx.objectStore(VAULT).put(resealKeys(opened.vault, opened.key, opened.keys));
  }
}

/**
 * Runs `work` in one read-write transaction over every store, the only kind
 * that writes key material. If it throws, the transaction
 * aborts and nothing it wrote stays.
 */
async function writeKeys<T>(
  db: IDBPDatabase<Schema>,
  work: (tx: KeyTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction([GROUPS, PERSONAL, VAULT], 'readwrite');
  try {
    const result = await work(tx);
    await tx.done;
    return result;
  } catch (error) {
    await abandon(tx);
    throw error;
  }
}

/**
 * A function that edits one group's record in one read-write transaction,
 * then notifies. An edit that throws, like a missing group, changes nothing.
 * No edit touches key material, which only `keepKeys` writes.
 */
function changer(
  db: IDBPDatabase<Schema>,
  notify: (groupId: string) => void,
): (groupId: string, edit: (group: StoredGroup) => void) => Promise<void> {
  return async (groupId, edit) => {
    const tx = db.transaction(GROUPS, 'readwrite');
    const group = await tx.store.get(groupId);
    try {
      if (group === undefined) throw new Error('No such group on this device.');
      edit(group);
    } catch (error) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw error;
    }
    await Promise.all([tx.store.put(group), tx.done]);
    notify(groupId);
  };
}

/**
 * The records of `incoming` that hold a signed event whose id is neither in
 * `log` nor earlier in `incoming`. A record that doesn't verify has no id, so
 * it is dropped and can never shadow the real record of the same event.
 */
function unseen(
  log: readonly LogRecord[],
  incoming: readonly LogRecord[],
  idOf: EventIdOf,
): LogRecord[] {
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

/**
 * `log` with each of `added` placed before the first record of a higher seq,
 * so the relay's order holds and the log's own records keep theirs.
 */
function inSeqOrder(log: readonly LogRecord[], added: readonly LogRecord[]): LogRecord[] {
  const merged = [...log];
  for (const record of [...added].sort((a, b) => a.seq - b.seq)) {
    const at = merged.findIndex((kept) => kept.seq > record.seq);
    merged.splice(at === -1 ? merged.length : at, 0, record);
  }
  return merged;
}

/** True when `a` and `b` hold the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
