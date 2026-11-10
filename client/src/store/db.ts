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
 * bot's claims (#119) and its push registration (#99) included. A backup file's groups come back in one
 * transaction too (#78), and the store closes itself when another tab
 * deletes or upgrades its database, so Erase never waits on a connection
 * left open. Personal Documents (#93) sit in a store of their own beside the
 * groups (`./personal.ts`), and a backup file brings them back in that same
 * transaction. A dissolved group stays as a read-only archive (#108): nothing
 * more is queued, claimed or sent for it, and its ballots and notes can be
 * cleared while its outcomes stay. So does a group a vote removed this
 * member from (#115), which keeps what it already had. The relay backup's
 * key and state (#97) are one record in a store of their own, in no group,
 * so no group's record ever holds the key.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import type { BotMoment } from '../engine/chatPosts';
import type { GroupState, LogRecord } from '../engine/fold';
import type { TallyDetail } from '../engine/tally';
import { type Draft, draftIn, type DraftShelf, type DraftStore, withDraft } from './drafts';
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

/**
 * Where the relay holds this device's push endpoint for a group (#99): kept
 * only once the relay has taken it, so its presence is the group's switch.
 */
export interface PushRegistration {
  /** The endpoint the relay holds: this device's push subscription when it was taken. */
  readonly endpoint: string;
  /** Every mailbox it is registered under, from `mailboxAt` (./mailbox.ts). */
  readonly mailboxes: readonly string[];
  /** The relay instance that took it. A fresh relay holds none of it. */
  readonly instance: string | null;
  /** The relay minute of the last registration the relay took. */
  readonly at: number;
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
  /**
   * This membership's 32-byte X25519 secret key (#98), which opens the group's
   * new secrets when its key changes (`crypto/epoch.ts`). Like the signing
   * key, it is made for this group alone and never leaves the device but in a
   * backup file. Absent in a group kept before #98, until the sync loop makes one.
   */
  kxKey?: Uint8Array;
  /**
   * The epoch of `secret` (#98): 0 from genesis, then one more for each key
   * change this device took up. Absent reads as 0, so a group kept before #98
   * needs no migration.
   */
  epoch?: number;
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
   * This device's push registration for the group (#99): absent while push
   * is off for it, as it is until the person turns it on. Never in a backup
   * file: an endpoint belongs to one device.
   */
  push?: PushRegistration;
  /**
   * The nudges this device has posted for its own open Proposals (#99), by
   * `nudgeKey`, so each goes to the relay once. Absent until the first.
   */
  nudged?: string[];
  /**
   * Set once the group is read-only on this device: it dissolved (#108), or
   * a vote removed this member (#115). Absent while it goes on. Nothing is
   * queued, claimed or synced for it from then on.
   */
  archived?: Archive;
}

/** Why a group only reads on this device: it dissolved (#108), or a vote removed this member (#115). */
export type ArchiveReason = 'dissolved' | 'removed';

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

/**
 * A group this device keeps read-only: why (#108, #115), and its cleared
 * state once a dissolved archive's ballots are cleared.
 */
export interface Archive {
  readonly reason: ArchiveReason;
  readonly cleared?: ClearedArchive;
}

/** A group's backup mark (#78): in a backup file, or the backup card answered Not now. */
export type BackupMark = 'saved' | 'not-now';

/** Where restored groups came from: a backup file (#78), or another of the person's devices (#96). */
export type RestoredFrom = 'backup' | 'link';

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
  | 'kxKey'
  | 'epoch'
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

/**
 * What a device knows about a group when it creates or joins it: Create group
 * and Join hand over its encryption key too, and a joiner the epoch of the
 * secret its invite carried (#98).
 */
export type NewGroup = Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'me'> &
  Partial<Pick<Group, 'kxKey' | 'epoch'>>;

/**
 * A move to the group's next epoch (#98): its secret, the cursor to read its
 * mailbox from, and this device's own records to post again there first,
 * oldest first, since they reached the old mailbox after the key changed.
 */
export interface EpochAdvance {
  readonly epoch: number;
  readonly secret: Uint8Array;
  readonly cursor: number;
  readonly repost: readonly Uint8Array[];
}

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
  /** The move to the next epoch this pull found the group's key change for, if any (#98). */
  advance?: EpochAdvance;
}

/**
 * The relay backup on this device (#97): the random backup key, and what the
 * last upload held. It belongs to the device, not to any group.
 */
export interface RelayBackupState {
  /** The 32-byte backup key. The relay's id and seal key derive from it (`crypto/relayBackup.ts`). */
  readonly key: Uint8Array;
  /** The SHA-256, in hex, of what the last upload held, or null before one. */
  readonly digest: string | null;
  /** The relay's UTC day of the last daily check, or null before one. */
  readonly checkedDay: number | null;
  /** When the last upload succeeded, in device milliseconds, or null before one. */
  readonly uploadedAt: number | null;
  /** Whether the last try found the groups too large for the largest backup. */
  readonly tooLarge: boolean;
}

/** What a relay backup update may change: everything but the key. */
export type RelayBackupUpdate = Partial<Omit<RelayBackupState, 'key'>>;

/**
 * What {@link Store.subscribe}'s listeners hear when the relay backup's state
 * changes: never a group id, which is 43 base64url characters.
 */
export const RELAY_BACKUP_CHANGED = 'relay-backup';

/** The relay backup's one device-wide record (#97). */
export interface RelayBackupStore {
  /** The relay backup's state, or undefined while the device keeps none. */
  getRelayBackup(): Promise<RelayBackupState | undefined>;
  /**
   * Keep `key` as the backup key, with nothing uploaded or checked yet, in
   * place of any earlier one. Returns the state it replaced, if any.
   */
  setRelayBackupKey(key: Uint8Array): Promise<RelayBackupState | undefined>;
  /**
   * Keep `key` as the backup key only when the device holds none, as a
   * restored backup file's key is (#97, ADR-0075 §4). Returns whether it did.
   */
  adoptRelayBackupKey(key: Uint8Array): Promise<boolean>;
  /**
   * Apply `update` in one transaction, only while the backup key is still
   * `key`, so an upload that finishes after a new key was made can't record
   * itself against it. Returns whether it applied.
   */
  updateRelayBackup(key: Uint8Array, update: RelayBackupUpdate): Promise<boolean>;
}

/** The id of the event a record carries, or `null` when the record doesn't hold a signed event. */
export type EventIdOf = (bytes: Uint8Array) => string | null;

/** The device's groups, its personal Documents (#93), and its relay backup's state (#97). */
export interface Store extends DraftStore, PersonalStore, RelayBackupStore {
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
   * Keep the group read-only on this device, in one change: once it has
   * dissolved (#108), or a vote has removed this member (#115). Drop its
   * outbox, its drafts, any leave and the chat bot's claims (#119), and mark
   * it archived for `reason`. From then on nothing is queued or claimed for
   * it, and the sync loop sends, reads and posts nothing for it. A group
   * already archived keeps its archive.
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
   * Append each record whose event id isn't in the log yet for its epoch, and
   * save the sync state. A pull more than {@link HISTORY_GAP_MS} after the
   * last sync sets `missingHistory`. A pull that carries an `advance` moves
   * the group to its next epoch in the same change (#98): the new secret and
   * cursor, and the records to post again ahead of the outbox, each once.
   */
  applyPull(groupId: string, pull: Pull, idOf: EventIdOf): Promise<void>;
  /**
   * Keep `fresh` as the group's encryption key unless it has one (#98), in one
   * change, and return the key it keeps: two tabs that race keep the first.
   * No screen reads it, so no listener hears of it.
   */
  ensureKx(groupId: string, fresh: Uint8Array): Promise<Uint8Array>;
  /**
   * Take up a later epoch's secret that an invite carried (#98), reading its
   * mailbox from `cursor` and posting `repost` again first, when it is later
   * than the group's own. The caller checks the secret against the key
   * change's commit first (`epochs.ts`).
   */
  adoptEpoch(groupId: string, next: EpochAdvance): Promise<void>;
  /**
   * Add each of an invite's `records` whose event id the log lacks, each in
   * seq order among the records already there, and clear `missingHistory`
   * (#73). The cursor and sync state stay as they are. A read-only archive
   * takes nothing (#108), so a cleared one never gets its ballots back.
   */
  mergeLog(groupId: string, records: readonly LogRecord[], idOf: EventIdOf): Promise<void>;
  /**
   * Keep a backup file's groups and personal Documents, or a link bundle's
   * (#96), in one transaction (#78, #93). A group new to the device is kept
   * as the file has it, with an empty outbox, no drafts and no chat claims
   * (#119). For a group already here, whichever whole copy synced later
   * stays: the file's replaces the device's only when its last sync is later,
   * and a group this device is leaving or keeps read-only (#108) stays as it
   * is. From a backup file, either way the group is marked `saved`, since
   * the file holds it; from a link, no file holds it, so a new group has no
   * mark and one already here keeps its own. A personal Document merges by
   * id the same way: the file's replaces the device's only when it was
   * edited later (`keepsHeldCopy`). Nothing is stamped with the time now.
   */
  restoreGroups(
    groups: readonly BackedUpGroup[],
    personal?: readonly PersonalDocument[],
    from?: RestoredFrom,
  ): Promise<void>;
  /** Mark each of these groups still on the device, in one transaction (#78). */
  markBackup(groupIds: readonly string[], mark: BackupMark): Promise<void>;
  /**
   * Keep the group's push registration once the relay has taken it, or with
   * null turn push off for the group, in one change (#99).
   */
  setPush(groupId: string, push: PushRegistration | null): Promise<void>;
  /**
   * Replace the nudges this device has posted for the group (#99), in one
   * change. No screen reads them, so no listener hears of it.
   */
  markNudged(groupId: string, nudged: readonly string[]): Promise<void>;
  /** Start over at seq 0 of a relay `instance` the device hasn't seen. */
  resetCursor(groupId: string, instance: string): Promise<void>;
  /**
   * Hear which group changed after each change, or {@link RELAY_BACKUP_CHANGED}
   * when the relay backup's state did; returns the way to stop.
   */
  subscribe(listener: (groupId: string) => void): () => void;
  /** Close the database. */
  close(): void;
}

interface Schema extends DBSchema {
  groups: { key: string; value: Group };
  personal: { key: string; value: PersonalDocument };
  device: { key: string; value: RelayBackupState };
}

/**
 * The schema version. Version 5 adds the device store, which holds the relay
 * backup's state (#97), and version 4 the personal store (#93); neither
 * deletes anything. Version 3 holds a real group secret, from which the
 * mailbox id and seal key derive (#71); version 2 held signed records (#69)
 * and version 1 the stub era's unsigned data. That older data, whose relay
 * blobs anyone could read, is deleted on upgrade, with no migration. A
 * dissolved group's `archived` mark (#108) is an optional field of its
 * record, so it needed no version of its own: a version 3 group that holds
 * one keeps it through the upgrade. So are a group's encryption key and
 * epoch and each record's epoch (#98): a group or record without one reads
 * as epoch 0.
 */
const VERSION = 5;
const GROUPS = 'groups';
const PERSONAL = 'personal';
const DEVICE = 'device';
/** The device store's one key: the relay backup's record. */
const RELAY_BACKUP = 'relay-backup';

/**
 * Brings a database at `oldVersion` up to {@link VERSION}: groups from before
 * version 3 are deleted, and the personal store, then the device store, are
 * added beside whatever groups version 3 kept.
 */
function upgradeFrom(database: IDBPDatabase<Schema>, oldVersion: number): void {
  if (oldVersion < 3) {
    if (database.objectStoreNames.contains(GROUPS)) database.deleteObjectStore(GROUPS);
    database.createObjectStore(GROUPS, { keyPath: 'groupId' });
  }
  if (oldVersion < 4) database.createObjectStore(PERSONAL, { keyPath: 'id' });
  if (oldVersion < 5) database.createObjectStore(DEVICE);
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
      const tx = db.transaction(GROUPS, 'readwrite');
      const found = (await tx.store.getKey(groupId)) !== undefined;
      if (found) await tx.store.delete(groupId);
      await tx.done;
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
        // Its push registration is left to expire at the relay, so no request names the mailbox (#99).
        delete group.push;
        delete group.nudged;
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
        if (pull.advance !== undefined) advanceTo(group, pull.advance);
      }),
    async ensureKx(groupId, fresh) {
      let kept = fresh;
      await changeQuietly(groupId, (group) => {
        group.kxKey ??= fresh;
        kept = group.kxKey;
      });
      return kept;
    },
    adoptEpoch: (groupId, next) =>
      change(groupId, (group) => {
        if (next.epoch > (group.epoch ?? 0)) advanceTo(group, next);
      }),
    mergeLog: (groupId, records, idOf) =>
      change(groupId, (group) => {
        if (group.archived !== undefined) return;
        group.log = inSeqOrder(group.log, unseen(group.log, records, idOf));
        group.missingHistory = false;
      }),
    async restoreGroups(groups, personal = [], from = 'backup') {
      const tx = db.transaction([GROUPS, PERSONAL], 'readwrite');
      try {
        await restoreInto(tx, { groups, personal, from });
      } catch (error) {
        // Anything that fails takes the whole restore with it, groups and Documents alike.
        await abandon(tx);
        throw error;
      }
      await tx.done;
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
    setPush: (groupId, push) =>
      change(groupId, (group) => {
        if (push === null) delete group.push;
        else group.push = push;
      }),
    markNudged: (groupId, nudged) =>
      changeQuietly(groupId, (group) => {
        group.nudged = [...nudged];
      }),
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
    ...relayBackupStore(db, () => {
      notify(RELAY_BACKUP_CHANGED);
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

/** The relay backup's record in `db`'s device store (#97), telling `changed` after each write. */
function relayBackupStore(db: IDBPDatabase<Schema>, changed: () => void): RelayBackupStore {
  /** Writes `next(held)` in one transaction, unless it's undefined; returns the state held before. */
  const write = async (
    next: (held: RelayBackupState | undefined) => RelayBackupState | undefined,
  ): Promise<{ held: RelayBackupState | undefined; wrote: boolean }> => {
    const tx = db.transaction(DEVICE, 'readwrite');
    const held = await tx.store.get(RELAY_BACKUP);
    const state = next(held);
    if (state !== undefined) await tx.store.put(state, RELAY_BACKUP);
    await tx.done;
    if (state !== undefined) changed();
    return { held, wrote: state !== undefined };
  };
  const fresh = (key: Uint8Array): RelayBackupState => ({
    key: Uint8Array.from(key),
    digest: null,
    checkedDay: null,
    uploadedAt: null,
    tooLarge: false,
  });
  return {
    getRelayBackup: () => db.get(DEVICE, RELAY_BACKUP),
    async setRelayBackupKey(key) {
      return (await write(() => fresh(key))).held;
    },
    async adoptRelayBackupKey(key) {
      return (await write((held) => (held === undefined ? fresh(key) : undefined))).wrote;
    },
    async updateRelayBackup(key, update) {
      const result = await write((held) =>
        held !== undefined && sameBytes(held.key, key) ? { ...held, ...update } : undefined,
      );
      return result.wrote;
    },
  };
}

/**
 * Moves `group` to the epoch `advance` names: its secret and cursor, and its
 * records to post again ahead of the outbox, skipping any already queued.
 */
function advanceTo(group: Group, { epoch, secret, cursor, repost }: EpochAdvance): void {
  group.epoch = epoch;
  group.secret = secret;
  group.cursor = cursor;
  const fresh = repost.filter((bytes) => !group.outbox.some((queued) => sameBytes(queued, bytes)));
  group.outbox = [...fresh, ...group.outbox];
}

/**
 * Aborts `tx` and waits for it to end. A transaction that a failed request
 * has already aborted can't be aborted again, and that's fine: either way,
 * nothing it wrote stays.
 */
async function abandon(tx: RestoreTransaction): Promise<void> {
  try {
    tx.abort();
  } catch {
    // Already aborted by the request that failed.
  }
  await tx.done.catch(() => undefined);
}

/** A transaction over both of the store's object stores, as a restore opens it. */
type RestoreTransaction = IDBPTransaction<Schema, ['groups', 'personal'], 'readwrite'>;

/** What one restore keeps: a backup file's or a link bundle's groups and Documents (#96). */
interface Restored {
  readonly groups: readonly BackedUpGroup[];
  readonly personal: readonly PersonalDocument[];
  readonly from: RestoredFrom;
}

/**
 * Puts each group and personal Document a backup file or a link bundle
 * holds into `tx`, keeping the device's copy wherever it's the one to keep
 * (`keptCopy`, `keepsHeldCopy`).
 */
async function restoreInto(
  tx: RestoreTransaction,
  { groups, personal, from }: Restored,
): Promise<void> {
  const kept = tx.objectStore(GROUPS);
  for (const restored of groups) {
    await kept.put(keptCopy(await kept.get(restored.groupId), restored, from));
  }
  const documents = tx.objectStore(PERSONAL);
  for (const restored of personal) {
    if (!keepsHeldCopy(await documents.get(restored.id), restored)) await documents.put(restored);
  }
}

/**
 * The backup mark a restored group gets (#78, #96): `saved` from a backup
 * file, which holds it; from a link, which no file holds, the mark the
 * device's own copy had, if any.
 */
function markFor(held: Group | undefined, from: RestoredFrom): Pick<Group, 'backup'> {
  if (from === 'backup') return { backup: 'saved' };
  return held?.backup === undefined ? {} : { backup: held.backup };
}

/**
 * The copy of a group to keep when a backup file or a link bundle holds
 * `restored` and the device holds `held` (#78, #96): the restored one, with
 * no outbox, drafts or chat claims, unless the device's synced at least as
 * late, is leaving, or is a read-only archive, which a restore never brings
 * back to life (#108). Either is marked as `markFor` says. The device's push
 * registration and posted nudges (#99) stay either way: they belong to this
 * device, and neither a file nor a link bundle holds them, so a linked
 * device starts with push off.
 */
function keptCopy(held: Group | undefined, restored: BackedUpGroup, from: RestoredFrom): Group {
  const mark = markFor(held, from);
  if (held !== undefined && (stays(held) || syncedSince(held, restored))) {
    return { ...held, ...mark };
  }
  // A copy that comes back read-only takes no push (#108), as `markArchived` keeps none.
  const { push, nudged } = restored.archived === undefined ? (held ?? {}) : {};
  return {
    ...restored,
    outbox: [],
    ...mark,
    ...(push === undefined ? {} : { push }),
    ...(nudged === undefined ? {} : { nudged }),
  };
}

/** Whether a restore leaves `held` as it is: the device is leaving it, or keeps it read-only. */
function stays(held: Group): boolean {
  return held.leaving !== undefined || held.archived !== undefined;
}

/** Whether `held` last synced no earlier than `restored`; a copy that never synced is the oldest. */
function syncedSince(held: Group, restored: BackedUpGroup): boolean {
  return (held.lastSyncAt ?? -Infinity) >= (restored.lastSyncAt ?? -Infinity);
}

/**
 * A function that edits one group in one read-write transaction, then
 * notifies. An edit that throws, like a missing group, changes nothing.
 */
function changer(
  db: IDBPDatabase<Schema>,
  notify: (groupId: string) => void,
): (groupId: string, edit: (group: Group) => void) => Promise<void> {
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
 * A record's key for dedupe: its event id within the epoch of the mailbox it
 * was read from (#98), or null when it holds no signed event. A copy its
 * author posted again to a new epoch's mailbox is a record of its own.
 */
function keyOf(record: LogRecord, idOf: EventIdOf): string | null {
  const id = idOf(record.bytes);
  return id === null ? null : `${String(record.epoch ?? 0)}:${id}`;
}

/**
 * The records of `incoming` that hold a signed event whose id, in its epoch,
 * is neither in `log` nor earlier in `incoming`. A record that doesn't verify
 * has no id, so it is dropped and can never shadow the real record of the
 * same event.
 */
function unseen(
  log: readonly LogRecord[],
  incoming: readonly LogRecord[],
  idOf: EventIdOf,
): LogRecord[] {
  if (incoming.length === 0) {
    return [];
  }
  const seen = new Set(log.map((record) => keyOf(record, idOf)));
  return incoming.filter((record) => {
    const key = keyOf(record, idOf);
    if (key === null || seen.has(key)) {
      return false;
    }
    seen.add(key);
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
