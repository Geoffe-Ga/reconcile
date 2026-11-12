/**
 * The device's store: every group it belongs to, kept in IndexedDB (ADR-0029).
 *
 * A group's record holds its secret and signing key, the relay-ordered log,
 * the outbox of signed records not yet accepted by the relay, and the sync
 * cursors, one for each weekly mailbox it has read lately (#110). The
 * mailbox ids and seal key aren't kept: they derive from the secret wherever
 * they're needed (spec §3), so nothing stored can drift from it; a cursor is
 * filed under its mailbox's id. Each membership
 * has its own signing key, made for that group alone and kept only with its
 * records (ADR-0009), so two groups on one device share no key or id. Nothing
 * here touches the network. Each change reads and writes one group in a
 * single transaction, so a crash or a closed tab leaves either the old record
 * or the new one. Everything the device keeps about a group lives in that one
 * record, so Leave deletes the group with a single delete (#77), the chat
 * bot's claims (#119), what it learned of the group's webhook (#123) and its
 * push registration (#99) included. A backup file's groups come back in one
 * transaction too (#78), and the store closes itself when another tab
 * deletes or upgrades its database, so Erase never waits on a connection
 * left open. Personal Documents (#93) sit in a store of their own beside the
 * groups (`./personal.ts`), and a backup file brings them back in that same
 * transaction; a shared one keeps its share state on its own record (#105).
 * A dissolved group stays as a read-only archive (#108): nothing
 * more is queued, claimed or sent for it, and its ballots and notes can be
 * cleared while its outcomes stay. So does a group a vote removed this
 * member from (#115), which keeps what it already had. The relay backup's
 * key and state (#97) are one record in a store of their own, in no group,
 * so no group's record ever holds the key. Under a vault that record keeps
 * its state, and the vault its key. A front door's applications (#121) stay
 * on the device too: those a member's device read from its group's inbox on
 * the group's record, and those this device sent, with the reply keys only
 * it holds, in a store of their own (`./applications.ts`), outside the vault
 * for now, as a share's keys are.
 *
 * Once the device locks its keys with a passkey (#95), every group secret and
 * the relay backup key leave their records for one sealed vault record
 * (`./vault.ts`), and the records keep the rest. A shared personal
 * Document's seed and signing key (#105) stay on its record for now. A store opened on such a device reads nothing until
 * {@link Store.unlock} gets the vault key from the passkey; it keeps that key
 * in memory for the session, opens the vault inside each read's transaction
 * and hands back whole groups, so nothing else in the app changes. Every
 * write of key material (Create group and Join, a backup's or a link's
 * import, a group leaving or removed, and the relay backup's key) goes
 * through one function, `keepKeys`, which seals the keys into the vault when
 * there is one and refuses while it's locked, in the same transaction as the
 * records it writes. Every read of the relay backup's state opens the vault
 * too, so a locked device neither reads nor writes its key.
 * The person's recovery contacts (#109) are another record in the device
 * store, under its own key: the one place the device lists them, which no
 * backup file, link bundle or relay copy carries. They hold no key, so they
 * stay out of the vault.
 *
 * Once a decided Proposal's ballots expire (#111), `clearBallots` deletes
 * them, its other results and anything else that expires with them from the
 * log and the outbox, and marks the Proposal `cleared`. From then on every
 * ingest drops such records for it, a pull, an invite's merge and a backup
 * file's or a link's restore alike, so none comes back.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import type { BotMoment } from '../engine/chatPosts';
import { expiryKeyOf } from '../engine/expiry';
import { keptInRoom } from '../engine/room';
import { type DoorInbox, SENT_CHANGED, type SentApplication, type SentStore } from './applications';
import type { GroupState, LogRecord } from '../engine/fold';
import type { TallyDetail } from '../engine/tally';
import { type Draft, draftIn, type DraftShelf, type DraftStore, withDraft } from './drafts';
import { placedInLog } from './logOrder';
import {
  type GroupKeys,
  newVault,
  openKeys,
  resealKeys,
  VAULT_ID,
  type VaultKeys,
  type VaultLock,
  type VaultRecord,
} from './vault';
import {
  byCreation,
  isPersonalDocument,
  isShareState,
  keepsHeldCopy,
  keptShare,
  type PersonalDocument,
  restoredCopy,
  type PersonalStore,
  type ShareState,
  textOf,
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
 * What this device learned of the group's Discord webhook (#123), for the
 * webhook whose id is `webhook` (never its token): `text` once Discord showed
 * it posts into a text channel, which takes no threads, or the server and
 * channel ids Discord gave for it, which tell a new thread from that channel.
 */
export interface ChatChannel {
  readonly webhook: string;
  readonly home: 'text' | { readonly guild: string; readonly channel: string };
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

/**
 * What a coalition entry means to do once it can (#114): join under the seat
 * of a group on this device, and propose admitting a group whose reconcile
 * Proposal passes.
 */
export interface CoalitionPlan {
  /**
   * The id of the group on this device whose seat this device joins the
   * coalition under once the coalition names that seat: the maker's group,
   * and a group being admitted. Absent once joined, or with nothing to join.
   */
  joinAs?: string;
  /**
   * The group this device brought a formed coalition's card to, and its
   * reconcile Proposal: once that passes, this device proposes admitting the
   * group into the coalition. Absent once proposed, or once it didn't pass.
   */
  admitting?: Admitting;
}

/**
 * An admission this device will propose (#114): the group it brought a
 * formed coalition's card to, that group's reconcile Proposal, and the title
 * and why the admit motion will carry.
 */
export interface Admitting {
  readonly group: string;
  readonly proposal: string;
  readonly title: string;
  readonly why: string;
}

/**
 * Everything the device keeps about one group, about one coalition whose
 * secret a group on the device holds (#114), or about one coalition's room
 * (#125): its `kind` says which.
 */
export interface Group extends CoalitionPlan {
  /**
   * The group's id; for a coalition, its entry id, derived from its secret
   * (`crypto/card.ts`), since a device keeps it before its genesis exists.
   */
  groupId: string;
  /**
   * `coalition` for a coalition's entry (#114): its own log, cursors, outbox
   * and `me`, synced like a group's. `room` for a coalition's room (#125,
   * `./rooms.ts`): its `secret` is the coalition's `inner`, its signing key
   * and author the coalition entry's, and its log keeps 30 days of relay
   * time. Absent for a group.
   */
  kind?: 'coalition' | 'room';
  /**
   * The 32-byte group secret, made at genesis, that only members hold. The
   * group's weekly mailbox ids and seal key derive from it (`crypto/groupKeys.ts`).
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
  /**
   * The seq after which a weekly mailbox of this epoch is read while it has no
   * cursor of its own in `cursors` (#110): 0 from creation and after a fresh
   * relay instance, the invite's highest seq after a join, and the key
   * change's seq after a move to a new epoch (#98). A sync pass leaves it.
   */
  cursor: number;
  /**
   * The highest seq read from each weekly mailbox of this epoch, by mailbox
   * id, for the last 5 weeks (#110); the next GET of a mailbox asks for the
   * records after its cursor. Absent until the first pass, and again after a
   * fresh relay instance or a move to a new epoch, which read from `cursor`.
   */
  cursors?: Readonly<Record<string, number>>;
  /**
   * The relay minute of the last successful pass, the earliest of its GETs'
   * `now`s, or `null` before one. Its week is the week the pass read up to.
   */
  relayNow: number | null;
  /** The relay instance the cursors belong to, or `null` before the first GET. */
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
   * What this device learned of the group's webhook (#123), so it asks
   * Discord once: absent until it learns something. A new webhook starts over.
   */
  chatChannel?: ChatChannel;
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
  /**
   * The ids of the `recovery-share` events whose held-share line group home
   * has already shown, and the person put away (#109). Absent until the first.
   */
  recoverySeen?: string[];
  /**
   * The shares this device, as a recovery contact, agreed to hand back (#118),
   * oldest first: each from its alert's approval until it went or stopped.
   * Absent until the first. No backup file or link carries them.
   */
  recoveryHolds?: RecoveryHold[];
  /**
   * The front door's inbox as this device last read it (#121): absent until
   * the group's door is open and this member may invite. Never in a backup
   * file, and dropped with an archive.
   */
  door?: DoorInbox;
  /**
   * The Proposals whose ballots this device has deleted (#111), which `fold`
   * takes, oldest first. Absent until the first. #73's invite header, #78's
   * backup file and #96's link carry it, so a newcomer or a restored device
   * knows which it can't check.
   */
  cleared?: string[];
}

/** A Proposal whose ballots expire now, and the event id of the result that stays. */
export interface Clearing {
  readonly proposal: string;
  readonly keep: string;
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

/**
 * Where restored groups came from: a backup file (#78), another of the
 * person's devices (#96), or the relay backup that recovery contacts helped
 * open (#118).
 */
export type RestoredFrom = 'backup' | 'link' | 'relay';

/**
 * A group as its IndexedDB record holds it: everything but its secret and
 * signing key once the device has a vault (#95), which holds those instead.
 */
type StoredGroup = Omit<Group, keyof GroupKeys> & Partial<GroupKeys>;

/**
 * The relay backup's state (#97) as its IndexedDB record holds it: without
 * its key once the device has a vault (#95), which holds the key instead.
 */
type StoredRelayBackup = Omit<RelayBackupState, 'key'> & { readonly key?: Uint8Array };

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
 * `dissolve` (#108), so the group comes back read-only. `cleared` lists the
 * Proposals whose ballots the device had deleted (#111).
 */
export type BackedUpGroup = Pick<
  Group,
  | 'kind'
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
  | 'cleared'
> & { readonly missingHistory: boolean };

/**
 * The longest gap between syncs that can't have missed an event: 28 days. The
 * relay keeps blobs 30 days, rounded up by a day (ADR-0057), so a device away
 * for longer may find some already gone.
 */
export const HISTORY_GAP_MS = 28 * 86_400_000;

/**
 * What a device knows about a group when it creates or joins it: Create group
 * and Join hand over its encryption key too, a joiner the epoch of the
 * secret its invite carried (#98), and through an invite the Proposals the
 * inviter has cleared (#111).
 */
export type NewGroup = Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'me'> &
  Partial<Pick<Group, 'kxKey' | 'epoch' | 'cleared' | 'kind' | 'joinAs' | 'admitting'>>;

/** True for a coalition's entry (#114), false for a group or a room. */
export function isCoalitionEntry(group: Pick<Group, 'kind'>): boolean {
  return group.kind === 'coalition';
}

/** True for a coalition's room (#125), false for a group or a coalition's entry. */
export function isRoomEntry(group: Pick<Group, 'kind'>): boolean {
  return group.kind === 'room';
}

/**
 * A change to a coalition entry's plan and name (#114): each field given
 * replaces it, and null clears it.
 */
export interface PlanChange {
  /** The name this device joins the coalition under. */
  readonly name?: string;
  readonly joinAs?: string | null;
  readonly admitting?: CoalitionPlan['admitting'] | null;
}

/**
 * A move to the group's next epoch (#98): its secret, the cursor to read its
 * mailboxes from, and this device's own records to post again there first,
 * oldest first, since they reached the old mailbox after the key changed.
 */
export interface EpochAdvance {
  readonly epoch: number;
  readonly secret: Uint8Array;
  readonly cursor: number;
  readonly repost: readonly Uint8Array[];
}

/** What one sync pass, or a join's invite, read from the relay. */
export interface Pull {
  /**
   * The opened records, in relay order; ones already in the log are skipped,
   * and each goes after the last log record before it in relay order
   * (`logOrder.ts`, #110).
   */
  records: LogRecord[];
  /** A join's base cursor: the invite's highest seq (#110). A sync pass leaves the group's. */
  cursor?: number;
  /** A sync pass's cursors, each weekly mailbox's highest seq, in place of the group's (#110). */
  cursors?: Readonly<Record<string, number>>;
  /** The relay minute it reported: the earliest `now` of a pass's GETs. */
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

/** One recovery contact as this device chose them (#109): who, and where, as they were then. */
export interface ChosenContact {
  /** The group they share with the person: the group the share went to. */
  readonly groupId: string;
  /** Their key in that group: the `author` of their events there. */
  readonly member: string;
  /** Their name in that group, as the picker showed it. */
  readonly name: string;
  /** The group's name. */
  readonly groupName: string;
}

/**
 * The person's recovery contacts (#109; ADR-0043 §1): the split their
 * shares came from, `t` needed of `n`, who holds them, and when this device
 * chose them. `retired` lists the relay backup ids an earlier key named,
 * which still have to be overwritten with random bytes before every older
 * share opens nothing.
 */
export interface RecoveryPlan {
  readonly split: string;
  readonly t: number;
  readonly n: number;
  readonly contacts: readonly ChosenContact[];
  /** When this device chose them, in device milliseconds. */
  readonly chosenAt: number;
  readonly retired: readonly string[];
}

/** How a hold ended (#118): the share went to the new device, or the recovery stopped, and when, in device ms. */
export interface HoldEnd {
  readonly kind: 'sent' | 'stopped';
  readonly at: number;
}

/**
 * A share this device holds for someone recovering on a new device (#118;
 * ADR-0043 §2, ADR-0075 §4): the `recovery-alert` it posted, whose share it
 * is (the person's key in the group), the split approved, the tag a cancel
 * names, and the code that says where the share goes. The code goes once the
 * hold ends.
 */
export interface RecoveryHold {
  /** The alert's event id. */
  readonly alert: string;
  /** The person's key in the group: the author of the share. */
  readonly person: string;
  /** The split of the share approved: a later choice of contacts stops the hold. */
  readonly split: string;
  /** The 16-byte tag sealed in the alert, which the person's cancel names. */
  readonly tag: string;
  /** The recovery code, while the share waits to go. */
  readonly code?: string;
  /** When this device approved, in device ms. */
  readonly approvedAt: number;
  /** How the hold ended; absent while it holds. */
  readonly ended?: HoldEnd;
}

/**
 * A recovering device's request (#118): the seed its code and mailbox come
 * from, the secret half of the X25519 key the shares are sealed to, and when
 * it started, in device ms. It lives in the device store, outside the vault,
 * until a backup opens or the person stops.
 */
export interface RecoverRequest {
  readonly seed: Uint8Array;
  readonly secretKey: Uint8Array;
  readonly startedAt: number;
}

/** What a relay backup update may change: everything but the key. */
export type RelayBackupUpdate = Partial<Omit<RelayBackupState, 'key'>>;

/**
 * What {@link Store.subscribe}'s listeners hear when the relay backup's state
 * changes: never a group id, which is 43 base64url characters.
 */
export const RELAY_BACKUP_CHANGED = 'relay-backup';

/**
 * What {@link Store.subscribe}'s listeners hear when the recovery contacts
 * change (#109): never a group id either.
 */
export const RECOVERY_CHANGED = 'recovery';

/** The recovery contacts' one device-wide record (#109). */
export interface RecoveryStore {
  /** The person's recovery contacts, or undefined while they've chosen none on this device. */
  getRecoveryPlan(): Promise<RecoveryPlan | undefined>;
  /** Keep `plan` in place of any earlier one. */
  setRecoveryPlan(plan: RecoveryPlan): Promise<void>;
  /** Drop `id` from the plan's retired backup ids, in one transaction, once it is overwritten. */
  forgetRetired(id: string): Promise<void>;
  /** This device's request to recover with contacts (#118), or undefined while it has none. */
  getRecoverRequest(): Promise<RecoverRequest | undefined>;
  /**
   * In one transaction, the request this device keeps, or `fresh`, kept, when
   * it keeps none: two screens starting at once both get the one kept.
   */
  keepRecoverRequest(fresh: RecoverRequest): Promise<RecoverRequest>;
  /** Forget the request: the person stopped. */
  dropRecoverRequest(): Promise<void>;
  /**
   * In one transaction, forget the request and mark the device recovered at
   * `at` (device ms), once a backup has opened and its groups are kept.
   */
  finishRecovery(at: number): Promise<void>;
  /** When this device was recovered with contacts, in device ms, or undefined if it never was. */
  getRecoveredAt(): Promise<number | undefined>;
}

/**
 * The relay backup's one device-wide record (#97). Its key is a secret like a
 * group's (#95): with a vault, every call opens it, and each one fails with
 * {@link VaultLocked}, reading and writing nothing, while it's locked.
 */
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

/**
 * The device's groups, its personal Documents (#93), its relay backup's state
 * (#97), its recovery contacts (#109), and the front-door applications it
 * sent (#121).
 */
export interface Store
  extends DraftStore, PersonalStore, RelayBackupStore, RecoveryStore, SentStore {
  /** Every group on the device: never a coalition's entry (#114) or a room (#125). */
  listGroups(): Promise<Group[]>;
  /** Every coalition entry on the device (#114). */
  listCoalitions(): Promise<Group[]>;
  /** Every coalition room on the device (#125). */
  listRooms(): Promise<Group[]>;
  /** One group or coalition entry, or `undefined` when the device has none by that id. */
  getGroup(groupId: string): Promise<Group | undefined>;
  /** Keep a new group or coalition entry; refuses an id the device already has. */
  addGroup(group: NewGroup): Promise<Group>;
  /**
   * Change a coalition entry's plan and the name it joins under, in one change
   * (#114). Refuses an entry that isn't a coalition's.
   */
  planCoalition(groupId: string, change: PlanChange): Promise<void>;
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
   * Keep `channel` as what this device learned of the group's webhook, in one
   * change, replacing anything it learned before (#123). No screen reads it,
   * so no listener hears of it.
   */
  noteChatChannel(groupId: string, channel: ChatChannel): Promise<void>;
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
   * outbox, its drafts, any leave, the chat bot's claims (#119) and what it
   * learned of the webhook (#123), and mark it archived for `reason`. From
   * then on nothing is queued or claimed for it, and the sync loop sends,
   * reads and posts nothing for it. A group already archived keeps its
   * archive.
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
   * Add each record whose event id isn't in the log yet for its epoch, in
   * relay order (`logOrder.ts`, #110), and save the sync state: the cursors
   * the pull gives, if any, in place of the group's. A pull from a relay
   * instance the group hasn't read before, a fresh relay database, puts its
   * records after the whole log and starts every cursor over from 0. A pull
   * more than {@link HISTORY_GAP_MS} after the last sync sets
   * `missingHistory`. A pull that carries an `advance` moves the group to its
   * next epoch in the same change (#98): the new secret and base cursor with
   * no other cursors, and the records to post again ahead of the outbox, each
   * once.
   * A ballot, a result or anything else that expires with ballots, for a
   * Proposal in `cleared`, is dropped (#111).
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
   * mailboxes from `cursor` and posting `repost` again first, when it is later
   * than the group's own. The caller checks the secret against the key
   * change's commit first (`epochs.ts`).
   */
  adoptEpoch(groupId: string, next: EpochAdvance): Promise<void>;
  /**
   * Add each of an invite's `records` whose event id the log lacks, each in
   * seq order among the records already there, and clear `missingHistory`
   * (#73). The cursor and sync state stay as they are. A read-only archive
   * takes nothing (#108), so a cleared one never gets its ballots back. Like
   * `applyPull`, it drops what expired with a Proposal in `cleared` (#111).
   */
  mergeLog(groupId: string, records: readonly LogRecord[], idOf: EventIdOf): Promise<void>;
  /**
   * In one change, delete from the log and the outbox every record that
   * expires with each Proposal's ballots, apart from the result it keeps, and
   * add the Proposal to `cleared` (#111).
   */
  clearBallots(groupId: string, clearings: readonly Clearing[]): Promise<void>;
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
   * edited later (`keepsHeldCopy`), keeping the device's share when the
   * file's copy holds none (`restoredCopy`, #105), as a link bundle's never
   * does. Nothing is stamped with the time now. A restored copy keeps the
   * Proposals either copy has cleared, and none of what expired with them
   * (#111), so a restore never brings a cleared ballot back.
   */
  restoreGroups(
    groups: readonly BackedUpGroup[],
    personal?: readonly PersonalDocument[],
    from?: RestoredFrom,
  ): Promise<void>;
  /** Mark each of these groups still on the device, in one transaction (#78). */
  markBackup(groupIds: readonly string[], mark: BackupMark): Promise<void>;
  /**
   * Add `ids` to the held shares group home has shown for the group, each
   * once, in one change (#109), so its quiet card shows each line once.
   */
  markRecoverySeen(groupId: string, ids: readonly string[]): Promise<void>;
  /**
   * Queue the signed `recovery-alert` and keep `hold` beside it, in one
   * change (#118), so a hold never exists without its alert on its way.
   *
   * @throws {Error} when the group is leaving or read-only on this device.
   */
  holdShare(groupId: string, alert: Uint8Array, hold: RecoveryHold): Promise<void>;
  /** End the hold of `alert` as `end` says, dropping its code, unless it has ended already (#118). */
  endHold(groupId: string, alert: string, end: HoldEnd): Promise<void>;
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
  /**
   * Replace the group's front-door inbox with `edit` of it (#121), in one
   * change, or drop it when `edit` returns undefined. A group this device is
   * leaving or keeps read-only takes none (#77, #108).
   */
  updateInbox(
    groupId: string,
    edit: (held: DoorInbox | undefined) => DoorInbox | undefined,
  ): Promise<void>;
  /**
   * The passkey that opens this device's vault and the salt it's asked with,
   * or null when its keys aren't locked with a passkey (#95).
   */
  readVault(): Promise<VaultLock | null>;
  /**
   * Seal every secret on the device under the vault `key`, for the passkey
   * `lock`, and delete the plain copies, in one transaction (#95): each
   * group's keys and the relay backup's key (#97). From then on this session
   * holds the key, and every later secret goes into the vault.
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
   * hands keys anywhere calls it first: Save a backup, and Link a new device
   * (#96) before it shows a code and again before it sends. Erase never
   * does, so a device whose passkey is lost can still start over.
   *
   * @throws {VaultLocked} when the device has a vault this session hasn't opened.
   */
  requireUnlocked(): Promise<void>;
  /**
   * Replace every group on the device and the vault with a backup file's
   * groups, in one transaction: Restore when the passkey no longer unlocks
   * the vault (#95). Each is kept as a restore keeps a new group, its keys in
   * its record, since no vault is left to seal them in. The relay backup's
   * state goes too (#97), since its key went with the vault. The file's
   * personal Documents, which hold no key, merge as
   * {@link Store.restoreGroups} merges them.
   */
  replaceGroups(
    groups: readonly BackedUpGroup[],
    personal?: readonly PersonalDocument[],
  ): Promise<void>;
  /**
   * Hear which group changed after each change, or {@link RELAY_BACKUP_CHANGED}
   * when the relay backup's state did; returns the way to stop.
   */
  subscribe(listener: (groupId: string) => void): () => void;
  /** Close the database. */
  close(): void;
}

/** The mark a device keeps once it was recovered with contacts (#118). */
interface RecoveredMark {
  readonly recoveredAt: number;
}

/**
 * A record of the device store, each under its own key: the relay backup's
 * (#97), the recovery contacts' (#109), and a recovering device's request and
 * the mark it leaves (#118).
 */
type DeviceRecord = StoredRelayBackup | RecoveryPlan | RecoverRequest | RecoveredMark;

interface Schema extends DBSchema {
  groups: { key: string; value: StoredGroup };
  personal: { key: string; value: PersonalDocument };
  device: { key: string; value: DeviceRecord };
  vault: { key: string; value: VaultRecord };
  sent: { key: string; value: SentApplication };
}

/** The relay backup's record in a device record read from its key, or undefined: only it is checked daily. */
function relayBackupIn(record: DeviceRecord | undefined): StoredRelayBackup | undefined {
  return record !== undefined && 'checkedDay' in record ? record : undefined;
}

/** The recovery contacts in a device record read from their key, or undefined: only they have contacts. */
function recoveryPlanIn(record: DeviceRecord | undefined): RecoveryPlan | undefined {
  return record !== undefined && 'contacts' in record ? record : undefined;
}

/** A recovering device's request in a device record read from its key, or undefined (#118). */
function recoverRequestIn(record: DeviceRecord | undefined): RecoverRequest | undefined {
  return record !== undefined && 'seed' in record ? record : undefined;
}

/** When the device was recovered, in a device record read from its key, or undefined (#118). */
function recoveredAtIn(record: DeviceRecord | undefined): number | undefined {
  return record !== undefined && 'recoveredAt' in record ? record.recoveredAt : undefined;
}

/**
 * The schema version. Version 7 adds the store of front-door applications
 * this device sent (#121), version 6 the key vault (#95), version 5 the
 * device store, which holds the relay backup's state (#97), and version 4
 * the personal store (#93); none of them deletes anything. Version 3 holds a
 * real group secret, from which the mailbox id and seal key derive (#71);
 * version 2 held signed records (#69) and version 1 the stub era's unsigned
 * data. That older data, whose relay blobs anyone could read, is deleted on
 * upgrade, with no migration. A dissolved group's `archived` mark (#108) is
 * an optional field of its record, so it needed no version of its own: a
 * version 3 group that holds one keeps it through the upgrade. So are a
 * group's encryption key and epoch and each record's epoch (#98): a group or
 * record without one reads as epoch 0. So is a personal Document's share by
 * link (#105): a version 4 or 5 Document that holds one keeps it whole
 * through the upgrade.
 */
const VERSION = 7;
const GROUPS = 'groups';
const PERSONAL = 'personal';
const DEVICE = 'device';
/** The device store's key for the relay backup's record. */
const RELAY_BACKUP = 'relay-backup';
/** The device store's key for the recovery contacts' record (#109): a key of its own, so no new version. */
const RECOVERY = 'recovery';
/** The device store's key for a recovering device's request (#118). */
const RECOVER_REQUEST = 'recover-request';
/** The device store's key for the mark a recovered device keeps (#118). */
const RECOVERED = 'recovered';
const VAULT = 'vault';
const SENT = 'sent';

/**
 * The stores a key transaction spans: the records, the personal Documents,
 * the relay backup's record and the vault.
 */
type Stores = ('groups' | 'personal' | 'device' | 'vault')[];

/** A read-write transaction over those stores, the only kind that writes key material. */
type KeyTransaction = IDBPTransaction<Schema, Stores, 'readwrite'>;

/**
 * Brings a database at `oldVersion` up to {@link VERSION}, one version at a
 * time: groups from before version 3 are deleted, then the personal store,
 * the device store, the vault and the sent applications' store (#121) are
 * added, in that order, beside whatever
 * groups version 3 kept.
 */
function upgradeFrom(database: IDBPDatabase<Schema>, oldVersion: number): void {
  if (oldVersion < 3) {
    if (database.objectStoreNames.contains(GROUPS)) database.deleteObjectStore(GROUPS);
    database.createObjectStore(GROUPS, { keyPath: 'groupId' });
  }
  if (oldVersion < 4) database.createObjectStore(PERSONAL, { keyPath: 'id' });
  if (oldVersion < 5) database.createObjectStore(DEVICE);
  if (oldVersion < 6) database.createObjectStore(VAULT, { keyPath: 'id' });
  if (oldVersion < 7) database.createObjectStore(SENT, { keyPath: 'id' });
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
  /**
   * Edits one whole group, keys and all, in one key transaction, then
   * notifies unless `heard` is false: #98's new epoch secrets and encryption
   * keys go through `keepKeys` this way, so a vault keeps them sealed.
   */
  const changeKeys = async (
    groupId: string,
    edit: (group: Group) => void,
    heard = true,
  ): Promise<void> => {
    await writeKeys(db, async (tx) => {
      const record = await tx.objectStore(GROUPS).get(groupId);
      if (record === undefined) throw new Error('No such group on this device.');
      const group = wholeGroup(record, await vaultKeys(tx, session));
      edit(group);
      await keepKeys(tx, session, { put: [group] });
    });
    if (heard) notify(groupId);
  };
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
    listGroups: async () =>
      (await readWhole(db, session, null)).filter((group) => group.kind === undefined),
    listCoalitions: async () => (await readWhole(db, session, null)).filter(isCoalitionEntry),
    listRooms: async () => (await readWhole(db, session, null)).filter(isRoomEntry),
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
    planCoalition: (groupId, plan) =>
      change(groupId, (group) => {
        if (!isCoalitionEntry(group)) throw new Error('This isn’t a coalition’s entry.');
        replan(group, plan);
      }),
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
    noteChatChannel: (groupId, channel) =>
      changeQuietly(groupId, (group) => {
        group.chatChannel = channel;
      }),
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
        delete group.chatChannel;
        // Its push registration is left to expire at the relay, so no request names the mailbox (#99).
        delete group.push;
        delete group.nudged;
        // A dissolved group's front door has closed, and a removed member reads it no more:
        // its applications go (#121, #115).
        delete group.door;
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
    applyPull(groupId, pull, idOf) {
      const { advance } = pull;
      // Only a move to a new epoch changes a key (#98); every other pull edits the record alone.
      if (advance === undefined) {
        return change(groupId, (group) => {
          pulled(group, pull, idOf);
        });
      }
      return changeKeys(groupId, (group) => {
        pulled(group, pull, idOf);
        advanceTo(group, advance);
      });
    },
    async ensureKx(groupId, fresh) {
      let kept = fresh;
      await changeKeys(
        groupId,
        (group) => {
          group.kxKey ??= fresh;
          kept = group.kxKey;
        },
        false,
      );
      return kept;
    },
    adoptEpoch: (groupId, next) =>
      changeKeys(groupId, (group) => {
        if (next.epoch > (group.epoch ?? 0)) advanceTo(group, next);
      }),
    clearBallots: (groupId, clearings) =>
      change(groupId, (group) => {
        clearIn(group, clearings);
      }),
    mergeLog: (groupId, records, idOf) =>
      change(groupId, (group) => {
        if (group.archived !== undefined) return;
        const kept = withoutCleared(group.log, records, group.cleared ?? []);
        group.log = inSeqOrder(group.log, unseen(group.log, kept, idOf));
        group.missingHistory = false;
      }),
    async restoreGroups(groups, personal = [], from = 'backup') {
      // Anything that fails takes the whole restore with it, groups and Documents alike.
      await writeKeys(db, (tx) => restoreInto(tx, session, { groups, personal, from }));
      for (const { groupId } of groups) notify(groupId);
    },
    markRecoverySeen: (groupId, ids) =>
      change(groupId, (group) => {
        const seen = group.recoverySeen ?? [];
        group.recoverySeen = [...seen, ...ids.filter((id) => !seen.includes(id))];
      }),
    holdShare: (groupId, alert, hold) =>
      change(groupId, (group) => {
        if (group.leaving !== undefined) throw new Error('This group is leaving this device.');
        if (group.archived !== undefined)
          throw new Error('This group is read-only on this device.');
        group.outbox.push(alert);
        group.recoveryHolds = [...(group.recoveryHolds ?? []), hold];
      }),
    endHold: (groupId, alert, end) =>
      change(groupId, (group) => {
        group.recoveryHolds = (group.recoveryHolds ?? []).map((hold) =>
          endedHold(hold, alert, end),
        );
      }),
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
    updateInbox: (groupId, edit) =>
      change(groupId, (group) => {
        if (group.leaving !== undefined || group.archived !== undefined) return;
        const door = edit(group.door);
        if (door === undefined) delete group.door;
        else group.door = door;
      }),
    ...sentStore(db, () => {
      notify(SENT_CHANGED);
    }),
    async listPersonal() {
      return (await db.getAll(PERSONAL)).sort(byCreation);
    },
    getPersonal: (id) => db.get(PERSONAL, id),
    async savePersonal(document) {
      const saved = textOf(document);
      if (!isPersonalDocument(saved)) {
        throw new Error('This isn’t a personal Document this device can keep.');
      }
      // One change, so a share set meanwhile (#105) is never written over.
      const tx = db.transaction(PERSONAL, 'readwrite');
      const share = keptShare(await tx.store.get(saved.id), saved);
      await Promise.all([tx.store.put(share === undefined ? saved : { ...saved, share }), tx.done]);
    },
    async updateShare(id, edit) {
      const tx = db.transaction(PERSONAL, 'readwrite');
      const held = await tx.store.get(id);
      let kept: PersonalDocument | undefined;
      try {
        kept = held && withShare(held, edit(held));
      } catch (error) {
        await abandonPersonal(tx);
        throw error;
      }
      if (kept === undefined) {
        await abandonPersonal(tx);
        return undefined;
      }
      await Promise.all([tx.store.put(kept), tx.done]);
      return kept;
    },
    deletePersonal: (id) => db.delete(PERSONAL, id),
    ...relayBackupStore(db, session, () => {
      notify(RELAY_BACKUP_CHANGED);
    }),
    ...recoveryStore(db, () => {
      notify(RECOVERY_CHANGED);
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
          const backup = relayBackupIn(await tx.objectStore(DEVICE).get(RELAY_BACKUP));
          await keepKeys(tx, sealing, {
            put: records.map((record) => wholeGroup(record, null)),
            ...(backup === undefined ? {} : { relayBackup: wholeBackup(backup, null) }),
          });
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
      const dropped = await writeKeys(db, async (tx) => {
        await tx.objectStore(GROUPS).clear();
        await tx.objectStore(VAULT).clear();
        // The relay backup's key went with the vault, so its state goes too (#97).
        const backups = tx.objectStore(DEVICE);
        const held = (await backups.getKey(RELAY_BACKUP)) !== undefined;
        await backups.delete(RELAY_BACKUP);
        await restoreInto(tx, session, { groups, personal, from: 'backup' });
        return held;
      });
      session.key?.fill(0);
      session.key = null;
      for (const { groupId } of groups) notify(groupId);
      if (dropped) notify(RELAY_BACKUP_CHANGED);
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

/** The applications this device sent, in `db`'s sent store (#121), telling `changed` after each write. */
function sentStore(db: IDBPDatabase<Schema>, changed: () => void): SentStore {
  return {
    async listSent() {
      return (await db.getAll(SENT)).sort((a, b) => a.sentAt - b.sentAt);
    },
    async addSent(application) {
      await db.put(SENT, application);
      changed();
    },
    async updateSent(id, edit) {
      const tx = db.transaction(SENT, 'readwrite');
      const held = await tx.store.get(id);
      if (held !== undefined) await tx.store.put({ ...edit(held), id });
      await tx.done;
      if (held !== undefined) changed();
    },
    async dropSent(id) {
      await db.delete(SENT, id);
      changed();
    },
  };
}

/**
 * Saves what a sync pass read into `group`'s record: its new log records, in
 * relay order, and sync state. A room (#125) then keeps only the records
 * received at most 30 days of relay time before the pull's `now`, so each
 * sync deletes the rest in the same change.
 */
function pulled(group: StoredGroup, pull: Pull, idOf: EventIdOf): void {
  if (group.lastSyncAt !== null && pull.lastSyncAt - group.lastSyncAt > HISTORY_GAP_MS) {
    group.missingHistory = true;
  }
  takePull(group, pull, idOf);
  if (isRoomEntry(group)) {
    group.log = group.log.filter((record) => keptInRoom(record.received, pull.relayNow));
  }
  group.relayNow = pull.relayNow;
  group.instance = pull.instance;
  group.lastSyncAt = pull.lastSyncAt;
}

/**
 * The relay backup's record in `db`'s device store (#97), telling `changed`
 * after each write. Every read and write opens the vault in its transaction,
 * and every write goes through `keepKeys`, so with a vault the key is sealed
 * there and never written plain, and a locked session gets {@link VaultLocked}.
 */
function relayBackupStore(
  db: IDBPDatabase<Schema>,
  session: Session,
  changed: () => void,
): RelayBackupStore {
  /**
   * Writes `next(held)` in one key transaction, unless it's undefined;
   * returns the state held before.
   */
  const write = async (
    next: (held: RelayBackupState | undefined) => RelayBackupState | undefined,
  ): Promise<{ held: RelayBackupState | undefined; wrote: boolean }> => {
    const result = await writeKeys(db, async (tx) => {
      const held = await backupIn(tx, session);
      const state = next(held);
      if (state !== undefined) await keepKeys(tx, session, { relayBackup: state });
      return { held, wrote: state !== undefined };
    });
    if (result.wrote) changed();
    return result;
  };
  const fresh = (key: Uint8Array): RelayBackupState => ({
    key: Uint8Array.from(key),
    digest: null,
    checkedDay: null,
    uploadedAt: null,
    tooLarge: false,
  });
  return {
    getRelayBackup: () => backupIn(db.transaction([DEVICE, VAULT]), session),
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

/** The recovery contacts' record in `db`'s device store (#109), telling `changed` after each write. */
function recoveryStore(db: IDBPDatabase<Schema>, changed: () => void): RecoveryStore {
  return {
    getRecoveryPlan: async () => recoveryPlanIn(await db.get(DEVICE, RECOVERY)),
    async setRecoveryPlan(plan) {
      await db.put(DEVICE, plan, RECOVERY);
      changed();
    },
    async forgetRetired(id) {
      const tx = db.transaction(DEVICE, 'readwrite');
      const held = recoveryPlanIn(await tx.store.get(RECOVERY));
      const kept = held?.retired.filter((retired) => retired !== id);
      const wrote = held !== undefined && kept?.length !== held.retired.length;
      if (wrote) await tx.store.put({ ...held, retired: kept ?? [] }, RECOVERY);
      await tx.done;
      if (wrote) changed();
    },
    getRecoverRequest: async () => recoverRequestIn(await db.get(DEVICE, RECOVER_REQUEST)),
    async keepRecoverRequest(fresh) {
      const tx = db.transaction(DEVICE, 'readwrite');
      const held = recoverRequestIn(await tx.store.get(RECOVER_REQUEST));
      if (held === undefined) await tx.store.put(fresh, RECOVER_REQUEST);
      await tx.done;
      if (held === undefined) changed();
      return held ?? fresh;
    },
    async dropRecoverRequest() {
      await db.delete(DEVICE, RECOVER_REQUEST);
      changed();
    },
    async finishRecovery(at) {
      const tx = db.transaction(DEVICE, 'readwrite');
      await Promise.all([
        tx.store.delete(RECOVER_REQUEST),
        tx.store.put({ recoveredAt: at }, RECOVERED),
        tx.done,
      ]);
      changed();
    },
    getRecoveredAt: async () => recoveredAtIn(await db.get(DEVICE, RECOVERED)),
  };
}

/** `hold` ended as `end` says, without its code, when it is the hold of `alert` and still holds (#118). */
function endedHold(hold: RecoveryHold, alert: string, end: HoldEnd): RecoveryHold {
  if (hold.alert !== alert || hold.ended !== undefined) return hold;
  const ended: RecoveryHold & { code?: string } = { ...hold, ended: end };
  delete ended.code;
  return ended;
}

/**
 * Adds a pull's records that `group`'s log lacks, but none that expired with
 * a Proposal it has cleared (#111), and takes its cursors. A
 * pull from a relay instance the group hasn't read before is a fresh relay
 * database's, whose seqs start again from 1: its records go after the whole
 * log, and every mailbox is read from that relay's start, from its base
 * cursor of 0 (#110). Otherwise each record goes in relay order
 * (`logOrder.ts`).
 */
function takePull(
  group: Pick<Group, 'log' | 'cursor' | 'cursors' | 'instance' | 'cleared'>,
  pull: Pull,
  idOf: EventIdOf,
): void {
  const kept = withoutCleared(group.log, pull.records, group.cleared ?? []);
  const added = unseen(group.log, kept, idOf);
  const fresh = group.instance !== null && pull.instance !== group.instance;
  group.log = fresh ? [...group.log, ...added] : placedInLog(group.log, added);
  if (fresh) {
    group.cursor = 0;
    delete group.cursors;
  }
  if (pull.cursor !== undefined) group.cursor = pull.cursor;
  if (pull.cursors !== undefined) group.cursors = { ...pull.cursors };
}

/**
 * Moves `group` to the epoch `advance` names: its secret and base cursor, with
 * no cursor of the old epoch's mailboxes (#110), and its records to post
 * again ahead of the outbox, skipping any already queued.
 */
function advanceTo(group: Group, { epoch, secret, cursor, repost }: EpochAdvance): void {
  group.epoch = epoch;
  group.secret = secret;
  group.cursor = cursor;
  delete group.cursors;
  const fresh = repost.filter((bytes) => !group.outbox.some((queued) => sameBytes(queued, bytes)));
  group.outbox = [...fresh, ...group.outbox];
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
 * `document` with `share` in place of any it held, or without one when
 * `share` is undefined (#105).
 *
 * @throws {Error} when the share isn't one to keep.
 */
function withShare(document: PersonalDocument, share: ShareState | undefined): PersonalDocument {
  if (share === undefined) return textOf(document);
  if (!isShareState(share)) throw new Error('This isn’t a share this device can keep.');
  return { ...textOf(document), share };
}

/** Ends a personal-store transaction that writes nothing. */
async function abandonPersonal(
  tx: IDBPTransaction<Schema, ['personal'], 'readwrite'>,
): Promise<void> {
  tx.abort();
  await tx.done.catch(() => undefined);
}

/** What one restore keeps: a backup file's or a link bundle's groups and Documents (#96). */
interface Restored {
  readonly groups: readonly BackedUpGroup[];
  readonly personal: readonly PersonalDocument[];
  readonly from: RestoredFrom;
}

/**
 * Puts each group and personal Document a backup file or a link bundle
 * holds into `tx`, keeping the device's copy wherever it's the one to keep
 * (`keptCopy`, `keepsHeldCopy`). The groups' keys go through `keepKeys`, so
 * with a vault they're resealed under the session's key.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function restoreInto(
  tx: KeyTransaction,
  session: Session,
  { groups, personal, from }: Restored,
): Promise<void> {
  const opened = await vaultKeys(tx, session);
  const records = tx.objectStore(GROUPS);
  const kept: Group[] = [];
  for (const restored of groups) {
    const held = await records.get(restored.groupId);
    kept.push(keptCopy(held === undefined ? undefined : wholeGroup(held, opened), restored, from));
  }
  await keepKeys(tx, session, { put: kept });
  const documents = tx.objectStore(PERSONAL);
  for (const restored of personal) {
    const held = await documents.get(restored.id);
    if (!keepsHeldCopy(held, restored)) await documents.put(restoredCopy(held, restored));
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
 * back to life (#108). A restored copy also clears what `held` had cleared
 * (#111, `heldClearings`). Either is marked as `markFor` says. The device's
 * push registration and posted nudges (#99) stay either way: they belong to
 * this device, and neither a file nor a link bundle holds them, so a linked
 * device starts with push off.
 */
function keptCopy(held: Group | undefined, restored: BackedUpGroup, from: RestoredFrom): Group {
  const mark = markFor(held, from);
  if (held !== undefined && (stays(held) || syncedSince(held, restored))) {
    return { ...held, ...mark };
  }
  // A copy that comes back read-only takes no push (#108), as `markArchived` keeps none.
  const { push, nudged } = restored.archived === undefined ? (held ?? {}) : {};
  const copy: Group = {
    ...restored,
    log: [...restored.log],
    outbox: [],
    ...mark,
    ...(push === undefined ? {} : { push }),
    ...(nudged === undefined ? {} : { nudged }),
  };
  if (held !== undefined) clearIn(copy, heldClearings(held, copy));
  return copy;
}

/**
 * The Proposals `held` has cleared that `restored` still holds ballots for
 * (#111), each with the result `held` kept, when `restored`'s log holds that
 * result too, so a restore clears them again as `held` did.
 */
function heldClearings(held: Group, restored: Pick<Group, 'log' | 'cleared'>): Clearing[] {
  const already = restored.cleared ?? [];
  const pending = new Set((held.cleared ?? []).filter((id) => !already.includes(id)));
  const restoredIds = new Set(restored.log.map((record) => expiryKeyOf(record.bytes)?.id));
  return held.log.flatMap((record) => {
    const key = expiryKeyOf(record.bytes);
    if (key?.result !== true || !pending.has(key.proposal) || !restoredIds.has(key.id)) return [];
    return [{ proposal: key.proposal, keep: key.id }];
  });
}

/**
 * Deletes from `group`'s log and outbox every record that expires with each
 * Proposal's ballots in `clearings`, apart from the result it keeps, and adds
 * the Proposal to `cleared` (#111).
 */
function clearIn(group: Pick<Group, 'log' | 'outbox' | 'cleared'>, clearings: readonly Clearing[]) {
  if (clearings.length === 0) return;
  const keep = new Map(clearings.map(({ proposal, keep }) => [proposal, keep]));
  const expires = (bytes: Uint8Array): boolean => {
    const key = expiryKeyOf(bytes);
    return key !== null && keep.has(key.proposal) && keep.get(key.proposal) !== key.id;
  };
  group.log = group.log.filter((record) => !expires(record.bytes));
  group.outbox = group.outbox.filter((bytes) => !expires(bytes));
  const cleared = group.cleared ?? [];
  group.cleared = [...cleared, ...[...keep.keys()].filter((id) => !cleared.includes(id))];
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
  readonly keys: VaultKeys;
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
  const keys = opened === null ? record : opened.keys.groups.get(record.groupId);
  if (keys?.secret === undefined || keys.signingKey === undefined) {
    throw new Error('A group’s keys are missing from this device.');
  }
  const { kxKey } = keys;
  return {
    ...record,
    secret: keys.secret,
    signingKey: keys.signingKey,
    ...(kxKey === undefined ? {} : { kxKey }),
  };
}

/**
 * The relay backup's state from its `record`, with its key: the record's own
 * without a vault, or the vault's.
 */
function wholeBackup(record: StoredRelayBackup, opened: OpenedVault | null): RelayBackupState {
  const key = opened === null ? record.key : opened.keys.backupKey;
  if (key === undefined) throw new Error('The relay backup’s key is missing from this device.');
  return { ...record, key };
}

/**
 * The relay backup's state read in `tx`, with its key, or undefined while the
 * device keeps none. With a vault it opens the vault first, kept or not.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function backupIn<Mode extends IDBTransactionMode>(
  tx: IDBPTransaction<Schema, Stores, Mode>,
  session: Session,
): Promise<RelayBackupState | undefined> {
  const opened = await vaultKeys(tx, session);
  const record = relayBackupIn(await tx.objectStore(DEVICE).get(RELAY_BACKUP));
  return record === undefined ? undefined : wholeBackup(record, opened);
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

/**
 * What one write of key material does: the groups to put, whole, the ones to
 * delete, and the relay backup's state to keep, key and all (#97).
 */
interface KeyChange {
  readonly put?: readonly Group[];
  readonly drop?: readonly string[];
  readonly relayBackup?: RelayBackupState;
}

/**
 * The one write path for key material (#95). Inside `tx`, deletes each group
 * in `drop`, puts each in `put`, and keeps `relayBackup`. Without a vault,
 * each record holds its own keys, as before the vault. With one, every key
 * goes into the vault, resealed under the session's key in the same
 * transaction, and each record goes without them, so no secret is ever
 * written outside it.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 */
async function keepKeys(tx: KeyTransaction, session: Session, change: KeyChange): Promise<void> {
  const opened = await vaultKeys(tx, session);
  await keepGroups(tx, opened?.keys ?? null, change);
  if (change.relayBackup !== undefined) {
    await keepBackup(tx, opened?.keys ?? null, change.relayBackup);
  }
  if (opened !== null) {
    await tx.objectStore(VAULT).put(resealKeys(opened.vault, opened.key, opened.keys));
  }
}

/**
 * `keepKeys`' groups: each deleted or put in `tx`, its keys into `sealed`
 * when the device has a vault.
 */
async function keepGroups(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  change: KeyChange,
): Promise<void> {
  const records = tx.objectStore(GROUPS);
  for (const groupId of change.drop ?? []) {
    await records.delete(groupId);
    sealed?.groups.delete(groupId);
  }
  for (const group of change.put ?? []) {
    const { secret, signingKey, kxKey, ...rest } = group;
    sealed?.groups.set(group.groupId, {
      secret,
      signingKey,
      ...(kxKey === undefined ? {} : { kxKey }),
    });
    await records.put(sealed === null ? group : rest);
  }
}

/**
 * `keepKeys`' relay backup: its record put in `tx`, its key into `sealed`
 * when the device has a vault.
 */
async function keepBackup(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  state: RelayBackupState,
): Promise<void> {
  const { key, ...rest } = state;
  if (sealed !== null) sealed.backupKey = Uint8Array.from(key);
  await tx.objectStore(DEVICE).put(sealed === null ? state : rest, RELAY_BACKUP);
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
  const tx = db.transaction([GROUPS, PERSONAL, DEVICE, VAULT], 'readwrite');
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
/** Applies a {@link PlanChange} to a coalition entry's record. */
function replan(group: StoredGroup, { name, joinAs, admitting }: PlanChange): void {
  if (name !== undefined) group.me = { ...group.me, name };
  if (joinAs === null) delete group.joinAs;
  else if (joinAs !== undefined) group.joinAs = joinAs;
  if (admitting === null) delete group.admitting;
  else if (admitting !== undefined) group.admitting = admitting;
}

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

/** The cleared Proposals that `log` already holds a result for. */
function resultsHeld(log: readonly LogRecord[], cleared: readonly string[]): Set<string> {
  const held = new Set<string>();
  for (const record of log) {
    const key = expiryKeyOf(record.bytes);
    if (key?.result === true && cleared.includes(key.proposal)) held.add(key.proposal);
  }
  return held;
}

/**
 * The records of `incoming` that don't expire with a Proposal in `cleared`
 * (#111): no ballot or other expiring record for one, and no result for one
 * once the log, or an earlier record of `incoming`, holds one. So a device
 * keeps the one result it cleared by, and a newcomer whose invite carried
 * `cleared` keeps the first, the one the fold reads ahead.
 */
function withoutCleared(
  log: readonly LogRecord[],
  incoming: readonly LogRecord[],
  cleared: readonly string[],
): LogRecord[] {
  if (cleared.length === 0) return [...incoming];
  let held: Set<string> | null = null;
  return incoming.filter((record) => {
    const key = expiryKeyOf(record.bytes);
    if (key === null || !cleared.includes(key.proposal)) return true;
    if (!key.result) return false;
    held ??= resultsHeld(log, cleared);
    if (held.has(key.proposal)) return false;
    held.add(key.proposal);
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
