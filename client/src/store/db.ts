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
 * push registration (#99) included. Only the push DELETEs the device still
 * owes the relay outlive it (#356): the endpoint and each mailbox id, no
 * secret or name, in a device record of their own until each is sent, within
 * the day. A backup file's groups come back in one
 * transaction too (#78), and the store closes itself when another tab
 * deletes or upgrades its database, so Erase never waits on a connection
 * left open. Personal Documents (#93) sit in a store of their own beside the
 * groups (`./personal.ts`), and a backup file brings them back in that same
 * transaction; a shared one keeps its share state on its own record (#105).
 * A dissolved group stays as a read-only archive (#108): nothing
 * more is queued, claimed or sent for it, and its ballots and notes can be
 * cleared while its outcomes stay. So does a group a vote removed this
 * member from (#115), which keeps what it already had. A group a restore
 * brings back reads only until it hears from the group (#231), since it may
 * have dissolved since its copy was made. The relay backup's key and state
 * (#97) are one record in a store of their own, in no group, so no group's
 * record ever holds the key. Under a vault that record keeps its state, and
 * the vault its key. A front door's applications (#121) stay on the device
 * too: those a member's device read from its group's inbox on the group's
 * record, and those this device sent, with the reply keys only it holds, in
 * a store of their own (`./applications.ts`).
 *
 * Once the device locks its keys with a passkey (#95), every group secret and
 * the relay backup key leave their records for one sealed vault record
 * (`./vault.ts`), and the records keep the rest. So do a shared personal
 * Document's seed, signing key and public key (#255), its record keeping the
 * share's mark, and a sent application's reply seed, reply key and invite
 * seed (#265), its record keeping the door, the group's name and when it was
 * sent, and a recovering device's request seed and X25519 secret key (#118),
 * its record keeping when it started: one mechanism, `./sealing.ts`, serves
 * all three. A store opened on such a
 * device reads nothing that holds a key until {@link Store.unlock} gets the
 * vault key from the passkey; it keeps that key in memory for the session,
 * opens the vault inside each read's transaction and hands back whole groups,
 * Documents and applications, so nothing else in the app changes. Personal
 * and its editor read each Document's words and share mark with no key
 * (`listPersonalEntries`), so a locked device still shows them. Every write
 * of key material (Create group and Join, a backup's or a link's import, a
 * group leaving or removed, the relay backup's key, a share set, changed or
 * dropped, an application kept, changed or forgotten, and a recovery request
 * kept, stopped or finished) goes through one
 * function, `keepKeys`, which seals the keys into the vault when there is
 * one and refuses while it's locked, in the same transaction as the records
 * it writes. Every read of the relay backup's state opens the vault too, so
 * a locked device neither reads nor writes its key. Share, reply and request
 * keys a device kept on their records, before #255, #265 and #118's sealing
 * or before it had a vault, move into the vault when it seals, or at its
 * first unlock after them. The person's recovery contacts (#109) are
 * another record in the device store, under its own key: the one place the
 * device lists them, which no backup file, link bundle or relay copy
 * carries. They hold no key, so they stay out of the vault. The Bedfellows
 * history (#480, `./bedfellows.ts`) is the vault store's other record: one
 * slot sealed under the vault key, always 64 KiB, which every vault has from
 * the start, so nothing about it sits in a plain record or shows on a
 * locked device; a device with no vault keeps none.
 *
 * Once a decided Proposal's ballots expire (#111), `clearBallots` deletes
 * them, its other results and anything else that expires with them from the
 * log and the outbox, and marks the Proposal `cleared`. From then on every
 * ingest drops such records for it, a pull, an invite's merge and a backup
 * file's or a link's restore alike, so none comes back.
 */

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';

import { openHistory, sealHistory } from '../crypto/history';
import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import type { BotMoment } from '../engine/chatPosts';
import type { Ceiling, Score } from '../engine/event';
import { expiryKeyOf } from '../engine/expiry';
import { keptInRoom } from '../engine/room';
import {
  type DoorInbox,
  replySealing,
  SENT_CHANGED,
  type SentApplication,
  type SentStore,
  type StoredSent,
} from './applications';
import type { GroupState, LogRecord } from '../engine/fold';
import type { TallyDetail } from '../engine/tally';
import {
  BEDFELLOWS_CLEARED,
  type BedfellowsState,
  decodeHistory,
  EMPTY_HISTORY,
  encodeHistory,
  expireHistory,
  type HistoryStore,
} from './bedfellows';
import { type Draft, draftIn, type DraftShelf, type DraftStore, withDraft } from './drafts';
import { placedInLog } from './logOrder';
import {
  type GroupKeys,
  newVault,
  openKeys,
  resealKeys,
  type Secrets,
  VAULT_ID,
  type VaultKeys,
  type VaultLock,
  type VaultRecord,
  zeroVaultKeys,
} from './vault';
import {
  byCreation,
  entryOf,
  isPersonalDocument,
  isShareState,
  keepsHeldCopy,
  keptShare,
  type PersonalDocument,
  restoredCopy,
  type PersonalStore,
  shareSealing,
  type ShareState,
  type StoredDocument,
  textOf,
} from './personal';
import { type RecoverRequest, requestSealing, type StoredRecoverRequest } from './recoverRequest';
import { type StewardKey, stewardSealing, type StoredStewardKey } from './stewardKey';
import {
  type KeptRemovals,
  prunedRemovals,
  type RemovalKeep,
  type SentToDoor,
  withDismissed,
  withSentCard,
} from '../shelf/affected';
import type { InboxKeep, KeptInbox } from '../shelf/inbox';
import type { KeptShelf, ShelfKeep } from '../shelf/read';
import { plainRecords, type Sealing, type Split, wholeRecord } from './sealing';

export type { RecoverRequest } from './recoverRequest';

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
 * A score this device's member in a group gave a Dispatch that may rise
 * (#126; ADR-0037), kept on that group's record so it can be carried up:
 * the Dispatch's id and ceiling, the score, the relay minute of the ballot
 * that gave it, and the minute it is kept until, 30 days after the last
 * decision on that Dispatch this device has seen, or null before one. No
 * note: a carried ballot never copies one (ADR-0065). It is never in a
 * backup file or a link, and goes when the group does.
 */
export interface KeptScore {
  readonly dispatch: string;
  readonly score: Score;
  readonly ceiling: Ceiling;
  readonly at: number;
  readonly until: number | null;
}

/**
 * A carried score this device means to cast in a group (#126; ADR-0037),
 * kept on that group's record: the promotion motion it opened there, the
 * Dispatch's id, the score, the relay minute drawn at random in the rest of
 * the window that it is cast at or after, and the motion's deadline. A 0 is
 * never cast on its own: the ballot asks for a fresh reason. `skipped` is
 * set once the person chose Don't cast.
 */
export interface CarryPlan {
  readonly motion: string;
  readonly dispatch: string;
  readonly score: Score;
  readonly castAt: number;
  readonly deadline: number;
  readonly skipped?: true;
}

/** A group's carried scores (#126): those its member gave, and those planned to cast there. */
export interface Carried {
  readonly scores: readonly KeptScore[];
  readonly carries: readonly CarryPlan[];
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
   * Set on a coalition's entry kept by following its link (#124): the person
   * reads it without joining any member group, and posts nothing to it, so
   * nothing outside this device records that they follow. Its `signingKey`
   * signs nothing. Unfollow purges the entry. Absent for a group, and for an
   * entry a group on the device holds the secret of.
   */
  following?: true;
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
   * Set while the group is read-only on this device: absent while it goes
   * on. A dissolved group's archive (#108), or the copy of a member a vote
   * removed (#115), is for good, and nothing is queued, claimed or synced
   * for it from then on. A copy a restore brought back (#231) reads only
   * until it hears from the group: the sync loop reads it and sends nothing
   * for it, and nothing is queued or claimed.
   */
  archived?: Archive | Unconfirmed;
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
   * The scores this member gave Dispatches that may rise (#126), which the
   * device carries to its other groups. Absent until the first. Never in a
   * backup file or a link.
   */
  scores?: KeptScore[];
  /** The carried scores this device means to cast here (#126). Absent until the first. */
  carries?: CarryPlan[];
  /**
   * The Proposals whose ballots this device has deleted (#111), which `fold`
   * takes, oldest first. Absent until the first. #73's invite marks the
   * result each keeps (#269), and #78's backup file and #96's link carry it,
   * so a newcomer or a restored device knows which it can't check.
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
 * A dissolved archive once this device has cleared its ballots, notes and
 * vouches (#108, #222; ADR-0075 §5): the group as the device last folded it,
 * every ballot, note and vouch taken out, with each decided Proposal's totals
 * and outcome from the device's own tally. The log that held them is gone.
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
 * A group this device keeps read-only for good: why (#108, #115), and its
 * cleared state once its ballots are cleared.
 */
export interface Archive {
  readonly reason: ArchiveReason;
  readonly cleared?: ClearedArchive;
  readonly since?: never;
}

/**
 * A copy of a group that a restore brought back, from a backup file (#78), a
 * second device's link (#96) or the relay backup (#97), and that hasn't heard
 * from the group since it was made (#231; ADR-0051's 2026-11-11 amendment).
 * The group may have dissolved meanwhile, with the relay's copy of the
 * `dissolve` expired, so it reads only until a pull shows the relay still
 * held everything since `since` (`applyPull`), brings a record the copy
 * didn't hold, or an invite's merge brings word from someone in the group
 * (`mergeLog`). A `dissolve`, or a `remove` naming this member (#115), makes
 * it an {@link Archive} instead.
 */
export interface Unconfirmed {
  readonly reason: 'unconfirmed';
  /** The relay minute its copy last synced: the copy's `relayNow`, or 0 for one that had none. */
  readonly since: number;
  readonly cleared?: never;
}

/**
 * Whether `archived`, a group's read-only mark, keeps it read-only for good:
 * a dissolved group's archive (#108) or the copy of a member a vote removed
 * (#115). False for a group that goes on, and for a copy a restore brought
 * back that reads until it hears from its group (#231): the sync loop still
 * reads that one, and it opens again. Every kind is named, so a new one
 * can't compile until it says which it is.
 */
export function isArchive(archived: Group['archived']): archived is Archive {
  switch (archived?.reason) {
    case 'dissolved':
    case 'removed':
      return true;
    case 'unconfirmed':
    case undefined:
      return false;
  }
}

/**
 * Whether the group takes new events on this device: it isn't leaving
 * (#77), nor read-only, for good (#108, #115) or for now (#231).
 */
export function takesNew(group: Pick<Group, 'leaving' | 'archived'>): boolean {
  return group.leaving === undefined && group.archived === undefined;
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
 * `dissolve` (#108), or to a `remove` of this member (#115), so the group
 * comes back read-only for good, and the store marks every other group it
 * takes read-only until it hears from the group (#231). `cleared` lists the
 * Proposals whose ballots the device had deleted (#111).
 */
export type BackedUpGroup = Pick<
  Group,
  | 'kind'
  | 'following'
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

/** {@link HISTORY_GAP_MS} in relay minutes: 40,320. */
const HISTORY_GAP_MINUTES = HISTORY_GAP_MS / 60_000;

/**
 * What a device knows about a group when it creates or joins it: Create group
 * and Join hand over its encryption key too, a joiner the epoch of the
 * secret its invite carried (#98), and through an invite the Proposals the
 * inviter has cleared (#111).
 */
export type NewGroup = Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'me'> &
  Partial<
    Pick<Group, 'kxKey' | 'epoch' | 'cleared' | 'kind' | 'following' | 'joinAs' | 'admitting'>
  >;

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
  /**
   * Outbox entries the relay took this pass, by their bytes, each dropped in
   * the change that saves the records this pull read back. Every entry stays
   * queued until then (#343, #349), so a screen shows it once throughout:
   * pending from the outbox, then folded from the log, never neither.
   */
  sent?: readonly Uint8Array[];
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
  /**
   * The relay's UTC day of the last daily check, or null before one, and
   * again once a group is purged (#327), so the next complete pass checks.
   */
  readonly checkedDay: number | null;
  /** When the last upload succeeded, in device milliseconds, or null before one. */
  readonly uploadedAt: number | null;
  /** Whether the last try found the groups too large for the largest backup. */
  readonly tooLarge: boolean;
  /**
   * The id of every personal Document this device held at a successful
   * upload, sorted (#247), so a later upload can leave out one the relay
   * copy still holds but this device deleted, and keep one only a linked
   * device wrote. Absent on a record from before #247.
   */
  readonly uploaded?: readonly string[];
  /**
   * A tag of each group this device held at a successful upload, sorted
   * (#327): `groupTagFor` of the backup key, the group's id and this
   * member's author, never the id itself. A later upload leaves out a group
   * the relay copy holds whose tag is here and that this device no longer
   * holds, since it left or removed it, or a dissolve wiped it, and keeps
   * one only a linked device joined. A tag goes once a read finds the copy
   * without its group. Absent on a record from before #327.
   */
  readonly uploadedGroups?: readonly string[];
  /**
   * The split the key was cut into (#272): the recovery plan's `split`, which
   * travels with the key in a backup file and a link bundle, never with the
   * contacts. Absent before the key is split, on a key adopted without one,
   * and on a record from before #272.
   */
  readonly split?: string;
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
 * chose them. `retired` lists the relay backup id of every key a choice on
 * this device replaced, which the device keeps overwritten with random bytes
 * so every older share opens nothing (#272).
 */
export interface RecoveryPlan {
  readonly split: string;
  readonly t: number;
  readonly n: number;
  readonly contacts: readonly ChosenContact[];
  /** When this device chose them, in device milliseconds. */
  readonly chosenAt: number;
  readonly retired: readonly string[];
  /** The relay's UTC day it last found every retired id overwritten, or absent before (#272). */
  readonly retiredCheckedDay?: number;
  /**
   * When this device found the plan's key retired by a later choice on
   * another of the person's devices, in device milliseconds (#272): these
   * contacts' shares then rebuild a key whose backup is gone. Absent while
   * the plan is the person's latest.
   */
  readonly supersededAt?: number;
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
 * names, the code that says where the share goes, and the second number the
 * person read out, which goes inside the release (#398). A stopped hold drops
 * the code and number at once; a sent one keeps them while the relay keeps
 * the release, so the contact can send it again with a corrected number.
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
  /** The recovery code, while the share waits to go or may go again. */
  readonly code?: string;
  /** The second number the person read out, six digits, kept with the code (#398). */
  readonly number?: string;
  /** When this device approved, in device ms. */
  readonly approvedAt: number;
  /** How the hold ended; absent while it holds. */
  readonly ended?: HoldEnd;
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

/**
 * What {@link Store.subscribe}'s listeners hear when the steward's key comes
 * or goes (#488): never a group id either.
 */
export const STEWARD_CHANGED = 'steward';

/**
 * What {@link Store.subscribe}'s listeners hear when a card is noted or a
 * removal dismissed (#491): never a group id either.
 */
export const REMOVALS_CHANGED = 'shelf-removals';

/** The steward's secret, on the one device that holds it (#488, `./stewardKey.ts`). */
export interface StewardKeyStore {
  /** Whether this device holds the steward's key: read without opening the vault. */
  holdsStewardKey(): Promise<boolean>;
  /**
   * The steward's 32-byte secret, or undefined on a device without it.
   *
   * @throws {VaultLocked} when it is sealed in a vault this session hasn't opened.
   */
  getStewardKey(): Promise<Uint8Array | undefined>;
  /** Keep `secret` as the steward's, through `keepKeys`, in place of any earlier one. */
  keepStewardKey(secret: Uint8Array, at: number): Promise<void>;
  /** Forget the steward's key on this device. */
  dropStewardKey(): Promise<void>;
}

/** The recovery contacts' one device-wide record (#109). */
export interface RecoveryStore {
  /** The person's recovery contacts, or undefined while they've chosen none on this device. */
  getRecoveryPlan(): Promise<RecoveryPlan | undefined>;
  /** Keep `plan` in place of any earlier one. */
  setRecoveryPlan(plan: RecoveryPlan): Promise<void>;
  /** Note `day`, the relay's UTC day, as the last one every retired backup id was found overwritten (#272). */
  markRetiredChecked(day: number): Promise<void>;
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
 * One push DELETE this device still owes the relay (#356): `endpoint`'s
 * registration under `mailbox`, a weekly mailbox of a group this device left
 * or was removed from, sent at the first push upkeep at or after `due`, a
 * device time in milliseconds drawn at random within the next day.
 */
export interface PushForget {
  readonly endpoint: string;
  readonly mailbox: string;
  readonly due: number;
}

/**
 * The push DELETEs this device owes (#356): one device-wide record in no
 * group, so it outlives the Leave that purges its group, and a reload. It
 * holds no key, so it stays out of the vault, and no listener hears of it.
 */
export interface PushForgetStore {
  /** Every DELETE owed, in the order kept. */
  listPushForgets(): Promise<PushForget[]>;
  /** Keep `edit` of the DELETEs owed in place of them, in one transaction; none left drops the record. */
  updatePushForgets(edit: (held: readonly PushForget[]) => readonly PushForget[]): Promise<void>;
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
   * Keep `key` as the backup key, cut into `split` once given (#272), with
   * nothing uploaded or checked yet, in place of any earlier one, and forget
   * that an earlier key was retired. Returns the state it replaced, if any.
   */
  setRelayBackupKey(key: Uint8Array, split?: string): Promise<RelayBackupState | undefined>;
  /**
   * Keep `key`, with the `split` it was cut into when it came with one, as
   * the backup key only when the device holds none, as a restored backup
   * file's key is (#97, ADR-0075 §4), and then forget that an earlier key was
   * retired (#272). Returns whether it did.
   */
  adoptRelayBackupKey(key: Uint8Array, split?: string): Promise<boolean>;
  /**
   * In one key transaction, only while the backup key is still `key`: forget
   * the key and its state, the vault's copy included, note `at` (device ms)
   * as when it was retired, and mark a plan of this device's superseded
   * (#272). Returns whether it did.
   */
  retireRelayBackup(key: Uint8Array, at: number): Promise<boolean>;
  /** When this device's last backup key was retired by a choice on another device (#272), or undefined. */
  getRelayBackupRetiredAt(): Promise<number | undefined>;
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
/**
 * The device's copy of its last read of the public shelf (#431,
 * `shelf/read.ts`): one device-wide record in no group. It is the public
 * shelf, the same for every device, so it holds no key and stays out of the
 * vault; no listener hears of it, and no backup file or link carries it.
 */
export type ShelfCopyStore = ShelfKeep;

/**
 * What the steward's device keeps of the steward's inbox (#490,
 * `shelf/inbox.ts`): its cursor, the reports and appeals it opened and the
 * keys of those the steward dismissed, one device-wide record. They name only public listings and entries, a clause
 * and a note, so no key: it stays out of the vault, no listener hears of it,
 * and no backup file or link carries it.
 */
export type StewardInboxStore = InboxKeep;

/**
 * What a device keeps to tell its reader a door it sent to was removed from
 * the shelf (#491, `shelf/affected.ts`): the doors it left reconcile cards
 * at and the lines its reader dismissed, one device-wide record, read beside
 * the doors of the applications it sent. They name only public doors, so no
 * key: it stays out of the vault, and no backup file or link carries it.
 */
export type RemovalStore = RemovalKeep;

export interface Store
  extends
    DraftStore,
    PersonalStore,
    RelayBackupStore,
    RecoveryStore,
    PushForgetStore,
    SentStore,
    ShelfCopyStore,
    StewardInboxStore,
    StewardKeyStore,
    RemovalStore,
    HistoryStore {
  /**
   * Forget each Bedfellows history record 30 days past its first day by the
   * device clock's `now` (#480), as the store's other expiries run after each
   * sync pass: one write, only when a record went. A device with no vault, or
   * a locked one, has nothing this session may read, so it does nothing.
   */
  sweepBedfellows(now: number): Promise<void>;
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
   * (#108). A group that is already gone is left alone. In the same
   * transaction it sets the relay backup's `checkedDay` back to null (#327),
   * so the next complete pass, the leave's own, reads the relay copy and
   * takes the group out of it, and Erase or a lost phone later that day
   * can't leave it there for a linked device to carry.
   */
  purgeGroup(groupId: string): Promise<void>;
  /**
   * Keep the group read-only on this device, in one change: once it has
   * dissolved (#108), or a vote has removed this member (#115). Drop its
   * outbox, its drafts, any leave, the chat bot's claims (#119) and what it
   * learned of the webhook (#123), and mark it archived for `reason`. From
   * then on nothing is queued or claimed for it, and the sync loop sends,
   * reads and posts nothing for it. A group already archived for good keeps
   * its archive; a restored copy that hadn't heard from its group (#231)
   * takes the new one.
   */
  markArchived(groupId: string, reason: ArchiveReason): Promise<void>;
  /**
   * Clear an archived group's ballots, notes and vouches, in one change (#108, #222): keep
   * `cleared`, the state to show from now on, and drop the log that held
   * them. Refuses a group that isn't archived for good (`isArchive`): a
   * dissolved group's, or a removed member's copy (#115).
   */
  clearArchive(groupId: string, cleared: ClearedArchive): Promise<void>;
  /**
   * Add each record whose event id isn't in the log yet for its epoch, in
   * relay order (`logOrder.ts`, #110), and save the sync state: the cursors
   * the pull gives, if any, in place of the group's. A pull from a relay
   * instance the group hasn't read before, a fresh relay database, puts its
   * records after the whole log and starts every cursor over from 0. A pull
   * more than {@link HISTORY_GAP_MS} after the last sync sets
   * `missingHistory`. Each entry the pull says the relay took (`sent`) leaves
   * the outbox in the same change (#343, #349). A pull that carries an
   * `advance` moves the group to its next epoch in the same change too (#98):
   * the new secret and base cursor with no other cursors, and the records to
   * post again ahead of the outbox, each once, after the sent entries left it.
   * A ballot, a result or anything else that expires with ballots, for a
   * Proposal in `cleared`, is dropped (#111). A restored copy that hasn't
   * heard from its group (#231) goes live in the same change when the
   * pull's relay minute is at most 28 days after the copy last synced, or
   * the pull adds a record received at or after then.
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
   * (#73). The cursor and sync state stay as they are. A group archived for
   * good takes nothing, a dissolved one (#108) or a removed member's copy
   * (#115), so a cleared one never gets its ballots back. A restored copy
   * that hasn't heard from its group (#231) takes the records and goes live:
   * someone in the group made the link from a copy that takes new things.
   * Like `applyPull`, it drops what expired with a Proposal in `cleared`
   * (#111).
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
   * (#119), and every group the restore takes reads only until it hears
   * from the group (#231), unless it comes back archived for good, dissolved
   * (#108) or removed (#115). For a group
   * already here, whichever whole copy synced later stays: the file's
   * replaces the device's only when its last sync is later, and a group this
   * device is leaving or keeps read-only (#108, #231) stays as it is. From a
   * backup file, either way the group is marked `saved`, since
   * the file holds it; from a link, no file holds it, so a new group has no
   * mark and one already here keeps its own. A personal Document merges by
   * id the same way: the file's replaces the device's only when it was
   * edited later (`keepsHeldCopy`), keeping the device's share when the
   * file's copy holds none (`restoredCopy`, #105), as a link bundle's never
   * does, and pausing any share the file brings until the person keeps it
   * (#328). Nothing is stamped with the time now. A restored copy keeps the
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
  /**
   * End the hold of `alert` as `end` says, unless it has ended already
   * (#118): a stopped hold drops its code and second number, and a sent one
   * keeps them, so it can go again (#398).
   */
  endHold(groupId: string, alert: string, end: HoldEnd): Promise<void>;
  /** Give the sent hold of `alert` a corrected second `number`, while it has its code (#398). */
  setHoldNumber(groupId: string, alert: string, number: string): Promise<void>;
  /** Drop the code and second number of the ended hold of `alert` (#398). */
  forgetHoldCode(groupId: string, alert: string): Promise<void>;
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
   * Replace the group's carried scores with `edit` of them (#126), in one
   * change. A group this device is leaving or keeps read-only takes none
   * (#77, #108).
   */
  updateCarried(groupId: string, edit: (held: Carried) => Carried): Promise<void>;
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
   * group's keys, the relay backup's key (#97), each shared personal
   * Document's share keys (#255) and each sent application's reply keys
   * (#265). From then on this session holds the key, and every later secret
   * goes into the vault.
   *
   * @throws {Error} when the device already has a vault; nothing changes.
   */
  sealKeys(lock: VaultLock, key: Uint8Array): Promise<void>;
  /**
   * Open the vault under `key` for this session, keeping a copy of it, and
   * return true; false, keeping nothing and writing nothing, when the device
   * has no vault or the key doesn't open it. Its one write moves into the
   * vault any share key or reply key a record still holds in the clear, as a
   * device sealed before #255 and #265 does, in one transaction; with none,
   * it writes nothing.
   *
   * @throws {Error} when that move fails; the session keeps no key then.
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
   * state goes too (#97), since its key went with the vault, and so does
   * each sent application whose reply keys it held (#265), whose reply can
   * no longer open. A shared personal Document whose share keys it held
   * (#255) takes the file's share of that Document, marked pending, or none;
   * then the file's personal Documents merge as {@link Store.restoreGroups}
   * merges them.
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

/** The mark a device keeps once a later choice on another device retired its backup key (#272). */
interface RetiredMark {
  readonly retiredAt: number;
}

/** The push DELETEs a device owes (#356). */
interface PushForgets {
  readonly forgets: readonly PushForget[];
}

/**
 * A record of the device store, each under its own key: the relay backup's
 * (#97), the recovery contacts' (#109), a recovering device's request and
 * the mark it leaves (#118), and the push DELETEs it owes (#356).
 */
type DeviceRecord =
  | StoredRelayBackup
  | RecoveryPlan
  | StoredRecoverRequest
  | RecoveredMark
  | RetiredMark
  | PushForgets
  | KeptShelf
  | StoredStewardKey
  | KeptInbox
  | KeptRemovals;

/**
 * The Bedfellows history's slot in the vault store (#480): sealed under the
 * vault key, always {@link HISTORY_SEALED_BYTES} long (`../crypto/history.ts`).
 * Every vault has one, empty or not, so its being there says nothing.
 */
interface HistorySlot {
  readonly id: typeof HISTORY_ID;
  readonly sealed: Uint8Array;
}

/** The vault's own record in a vault store record, or undefined: only it names a credential. */
function vaultIn(record: VaultRecord | HistorySlot | undefined): VaultRecord | undefined {
  return record !== undefined && 'credentialId' in record ? record : undefined;
}

interface Schema extends DBSchema {
  groups: { key: string; value: StoredGroup };
  personal: { key: string; value: StoredDocument };
  device: { key: string; value: DeviceRecord };
  vault: { key: string; value: VaultRecord | HistorySlot };
  sent: { key: string; value: StoredSent };
}

/** The relay backup's record in a device record read from its key, or undefined: only it is checked daily. */
function relayBackupIn(record: DeviceRecord | undefined): StoredRelayBackup | undefined {
  return record !== undefined && 'checkedDay' in record ? record : undefined;
}

/** The recovery contacts in a device record read from their key, or undefined: only they have contacts. */
function recoveryPlanIn(record: DeviceRecord | undefined): RecoveryPlan | undefined {
  return record !== undefined && 'contacts' in record ? record : undefined;
}

/** A recovering device's request in a device record read from its key, or undefined: only it has a start (#118). */
function recoverRequestIn(record: DeviceRecord | undefined): StoredRecoverRequest | undefined {
  return record !== undefined && 'startedAt' in record ? record : undefined;
}

/** The steward's key in a device record read from its key, or undefined: only it has `stewardSince` (#488). */
function stewardKeyIn(record: DeviceRecord | undefined): StoredStewardKey | undefined {
  return record !== undefined && 'stewardSince' in record ? record : undefined;
}

/** When the device was recovered, in a device record read from its key, or undefined (#118). */
function recoveredAtIn(record: DeviceRecord | undefined): number | undefined {
  return record !== undefined && 'recoveredAt' in record ? record.recoveredAt : undefined;
}

/** When the device's backup key was retired, in a device record read from its key, or undefined (#272). */
function retiredAtIn(record: DeviceRecord | undefined): number | undefined {
  return record !== undefined && 'retiredAt' in record ? record.retiredAt : undefined;
}

/** The shelf's copy in a device record read from its key, or undefined: only it has a read time (#431). */
function shelfCopyIn(record: DeviceRecord | undefined): KeptShelf | undefined {
  return record !== undefined && 'readAt' in record ? record : undefined;
}

/** The steward's inbox in a device record read from its key, or undefined: only it has items (#490). */
function stewardInboxIn(record: DeviceRecord | undefined): KeptInbox | undefined {
  return record !== undefined && 'items' in record ? record : undefined;
}

/**
 * The removals record in a device record read from its key, or none yet: only it has sent
 * cards (#491). Not dismissals: the steward's inbox keeps those too (#490).
 */
function removalsIn(record: DeviceRecord | undefined): KeptRemovals {
  return record !== undefined && 'cards' in record ? record : { cards: [], dismissed: [] };
}

/** The push DELETEs owed in a device record read from their key, or none (#356). */
function pushForgetsIn(record: DeviceRecord | undefined): PushForget[] {
  return record !== undefined && 'forgets' in record ? [...record.forgets] : [];
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
 *
 * Version 8 adds nothing but marks the vault's format 2 (#255, #265; #391):
 * each new vault format bumps the version, so a build from before it, as
 * after a rolled-back deploy, can't open the database at all, rather than
 * read the vault as one that doesn't open and offer Restore, which clears it.
 * `db.version.test.ts` pins which version each format came with.
 */
const VERSION = 8;
const GROUPS = 'groups';
const PERSONAL = 'personal';
const DEVICE = 'device';
/** The device store's key for the relay backup's record. */
const RELAY_BACKUP = 'relay-backup';
/** The device store's key for the recovery contacts' record (#109): a key of its own, so no new version. */
const RECOVERY = 'recovery';
/** The device store's key for a recovering device's request (#118). */
const RECOVER_REQUEST = 'recover-request';
/** The device store's key for the steward's key (#488): a key of its own, so no new version. */
const STEWARD_KEY = 'steward-key';
/** The device store's key for the mark a recovered device keeps (#118). */
const RECOVERED = 'recovered';
/** The device store's key for the mark a device keeps once its backup key was retired (#272). */
const RELAY_BACKUP_RETIRED = 'relay-backup-retired';
/** The device store's key for the push DELETEs a device owes (#356): a key of its own, so no new version. */
const PUSH_FORGETS = 'push-forgets';
/** The device store's key for its copy of the public shelf (#431): a key of its own, so no new version. */
const SHELF_COPY = 'shelf';
/** The device store's key for the steward's inbox (#490): a key of its own, so no new version. */
const STEWARD_INBOX = 'steward-inbox';
/** The device store's key for the removals record (#491): a key of its own, so no new version. */
const REMOVALS = 'shelf-removals';
const VAULT = 'vault';
/** The vault store's key for the Bedfellows history's sealed slot (#480): beside the vault, so no new version. */
const HISTORY_ID = 'history';
const SENT = 'sent';

/**
 * The stores a key transaction spans: the records, the personal Documents,
 * the relay backup's record, the vault and the sent applications (#265).
 */
type Stores = ('groups' | 'personal' | 'device' | 'vault' | 'sent')[];

/** A read-write transaction over those stores, the only kind that writes key material. */
type KeyTransaction = IDBPTransaction<Schema, Stores, 'readwrite'>;

/**
 * Brings a database at `oldVersion` up to {@link VERSION}, one version at a
 * time: groups from before version 3 are deleted, then the personal store,
 * the device store, the vault and the sent applications' store (#121) are
 * added, in that order, beside whatever
 * groups version 3 kept. Version 8 changes no store.
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
        await checkBackupAgain(tx);
        return true;
      });
      if (found) notify(groupId);
    },
    markArchived: (groupId, reason) =>
      change(groupId, (group) => {
        // A copy that hadn't heard from its group (#231) gives way to a dissolve or a removal.
        if (isArchive(group.archived)) return;
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
        // Nothing is cast in a read-only group, and its scores are carried no more (#126).
        delete group.scores;
        delete group.carries;
      }),
    clearArchive: (groupId, cleared) =>
      change(groupId, (group) => {
        if (!isArchive(group.archived)) throw new Error('This group isn’t archived.');
        group.archived = { ...group.archived, cleared };
        group.log = [];
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
        if (isArchive(group.archived)) return;
        const kept = withoutCleared(group.log, records, group.cleared ?? []);
        group.log = inSeqOrder(group.log, unseen(group.log, kept, idOf));
        group.missingHistory = false;
        // Someone in the group made the link from a copy that takes new things (#231).
        delete group.archived;
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
    setHoldNumber: (groupId, alert, number) =>
      change(groupId, (group) => {
        group.recoveryHolds = (group.recoveryHolds ?? []).map((hold) =>
          hold.alert === alert && hold.ended?.kind === 'sent' && hold.code !== undefined
            ? { ...hold, number }
            : hold,
        );
      }),
    forgetHoldCode: (groupId, alert) =>
      change(groupId, (group) => {
        group.recoveryHolds = (group.recoveryHolds ?? []).map((hold) =>
          hold.alert === alert && hold.ended !== undefined ? withoutCode(hold) : hold,
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
    updateCarried: (groupId, edit) =>
      change(groupId, (group) => {
        if (group.leaving !== undefined || group.archived !== undefined) return;
        const { scores, carries } = edit({
          scores: group.scores ?? [],
          carries: group.carries ?? [],
        });
        if (scores.length === 0) delete group.scores;
        else group.scores = [...scores];
        if (carries.length === 0) delete group.carries;
        else group.carries = [...carries];
      }),
    updateInbox: (groupId, edit) =>
      change(groupId, (group) => {
        if (group.leaving !== undefined || group.archived !== undefined) return;
        const door = edit(group.door);
        if (door === undefined) delete group.door;
        else group.door = door;
      }),
    ...sentStore(db, session, () => {
      notify(SENT_CHANGED);
    }),
    async listPersonal() {
      const tx = db.transaction([PERSONAL, VAULT]);
      const stored = await tx.objectStore(PERSONAL).getAll();
      return (await wholeIn(SHARES, stored, () => vaultKeys(tx, session))).sort(byCreation);
    },
    async getPersonal(id) {
      const tx = db.transaction([PERSONAL, VAULT]);
      const stored = await tx.objectStore(PERSONAL).get(id);
      const held = stored === undefined ? [] : [stored];
      const [document] = await wholeIn(SHARES, held, () => vaultKeys(tx, session));
      return document;
    },
    async listPersonalEntries() {
      return (await db.getAll(PERSONAL)).map(entryOf).sort(byCreation);
    },
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
    updateShare: (id, edit) =>
      writeKeys(db, async (tx) => {
        // The vault opens first, so a locked device refuses even a share it would drop (#255).
        const opened = await vaultKeys(tx, session);
        const stored = await tx.objectStore(PERSONAL).get(id);
        if (stored === undefined) return undefined;
        const held = wholeRecord(shareSealing, stored, sealedFor(opened, PERSONAL, id));
        const kept = withShare(held, edit(held));
        await keepKeys(tx, session, { personal: { put: [kept] } });
        return kept;
      }),
    async deletePersonal(id) {
      // A Document that isn't shared holds no key, so it goes in one change of its own store.
      const tx = db.transaction(PERSONAL, 'readwrite');
      const stored = await tx.store.get(id);
      const shared = stored !== undefined && shareSealing.hasSecrets(stored);
      if (!shared) await tx.store.delete(id);
      await tx.done;
      // A shared one's keys leave the vault with it, through the one key-writing path (#255).
      if (shared)
        await writeKeys(db, (keys) => keepKeys(keys, session, { personal: { drop: [id] } }));
    },
    ...relayBackupStore(db, session, (plan) => {
      notify(RELAY_BACKUP_CHANGED);
      if (plan) notify(RECOVERY_CHANGED);
    }),
    ...recoveryStore(db, session, () => {
      notify(RECOVERY_CHANGED);
    }),
    ...pushForgetStore(db),
    ...shelfCopyStore(db),
    ...stewardInboxStore(db),
    ...removalStore(db, () => {
      notify(REMOVALS_CHANGED);
    }),
    ...stewardKeyStore(db, session, () => {
      notify(STEWARD_CHANGED);
    }),
    ...historyStore(db, session, () => {
      notify(BEDFELLOWS_CLEARED);
    }),
    async readVault() {
      const vault = vaultIn(await db.get(VAULT, VAULT_ID));
      return vault === undefined
        ? null
        : { credentialId: vault.credentialId, prfSalt: vault.prfSalt };
    },
    async sealKeys(lock, key) {
      const sealing: Session = { key: Uint8Array.from(key) };
      try {
        await writeKeys(db, async (tx) => {
          if ((await tx.objectStore(VAULT).getKey(VAULT_ID)) !== undefined) {
            throw new Error('This device’s keys are already locked with a passkey.');
          }
          const records = await tx.objectStore(GROUPS).getAll();
          const backup = relayBackupIn(await tx.objectStore(DEVICE).get(RELAY_BACKUP));
          const change = {
            put: records.map((record) => wholeGroup(record, null)),
            ...(backup === undefined ? {} : { relayBackup: wholeBackup(backup, null) }),
            ...(await plainSecrets(tx)),
          };
          // The new vault is written once, already holding every key (#391).
          const empty = { groups: new Map(), records: new Map() };
          await keepKeysIn(tx, { vault: newVault(lock, key), keys: empty, key }, change);
          // Every vault has the Bedfellows history's slot from the start, used or not (#480).
          await tx.objectStore(VAULT).put(emptySlot(key));
        });
      } catch (error) {
        sealing.key?.fill(0);
        throw error;
      }
      session.key = sealing.key;
    },
    async unlock(key) {
      const vault = vaultIn(await db.get(VAULT, VAULT_ID));
      const check = vault === undefined ? null : openKeys(vault, key);
      if (check === null) return false;
      // Opened only to check the key, so zeroed at once, best effort (#391).
      zeroVaultKeys(check);
      const opening: Session = { key: Uint8Array.from(key) };
      try {
        await writeKeys(db, async (tx) => {
          await sealPlain(tx, opening);
          await slotFor(tx, key);
        });
      } catch (error) {
        opening.key?.fill(0);
        throw error;
      }
      session.key = opening.key;
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
        const lost = await forgetSealed(tx, session, personal);
        const request = await forgetSealedRequest(tx);
        const steward = await forgetSealedSteward(tx);
        await restoreInto(tx, session, { groups, personal, from: 'backup' });
        return { backup: held, sent: lost, request, steward };
      });
      session.key?.fill(0);
      session.key = null;
      for (const { groupId } of groups) notify(groupId);
      if (dropped.backup) notify(RELAY_BACKUP_CHANGED);
      if (dropped.sent) notify(SENT_CHANGED);
      if (dropped.request) notify(RECOVERY_CHANGED);
      if (dropped.steward) notify(STEWARD_CHANGED);
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
 * The applications this device sent, in `db`'s sent store (#121), telling
 * `changed` after each write. Their reply keys are secrets (#265): with a
 * vault, every read opens it and every write goes through `keepKeys`, so a
 * locked session gets {@link VaultLocked} and changes nothing.
 */
function sentStore(db: IDBPDatabase<Schema>, session: Session, changed: () => void): SentStore {
  return {
    async listSent() {
      const tx = db.transaction([SENT, VAULT]);
      const stored = await tx.objectStore(SENT).getAll();
      const sent = await wholeIn(REPLIES, stored, () => vaultKeys(tx, session));
      return sent.sort((a, b) => a.sentAt - b.sentAt);
    },
    async addSent(application) {
      await writeKeys(db, (tx) => keepKeys(tx, session, { sent: { put: [application] } }));
      changed();
    },
    async updateSent(id, edit) {
      const updated = await writeKeys(db, async (tx) => {
        const stored = await tx.objectStore(SENT).get(id);
        if (stored === undefined) return false;
        const opened = await vaultKeys(tx, session);
        const held = wholeRecord(replySealing, stored, sealedFor(opened, SENT, id));
        await keepKeys(tx, session, { sent: { put: [{ ...edit(held), id }] } });
        return true;
      });
      if (updated) changed();
    },
    async dropSent(id) {
      await writeKeys(db, (tx) => keepKeys(tx, session, { sent: { drop: [id] } }));
      changed();
    },
  };
}

/** Drops the first outbox entry of `group` with exactly `bytes`, once the relay has it. */
function dropSent(group: Pick<Group, 'outbox'>, bytes: Uint8Array): void {
  // Bytes are enough: a record's bytes fix its event, and the outbox posts in order.
  const index = group.outbox.findIndex((entry) => sameBytes(entry, bytes));
  if (index >= 0) {
    group.outbox.splice(index, 1);
  }
}

/**
 * Saves what a sync pass read into `group`'s record: its new log records, in
 * relay order, and sync state, dropping from the outbox each entry the pull
 * says the relay took (#343, #349), before any `advance` queues records to
 * post again (`applyPull`), so none is skipped as queued and then dropped. A
 * copy a restore brought back opens in the same change once the pull brings
 * word from its group (#231, `hearsFrom`). A room (#125) then keeps only the
 * records received at most 30 days of relay time before the pull's `now`, so
 * each sync deletes the rest in the same change.
 */
function pulled(group: StoredGroup, pull: Pull, idOf: EventIdOf): void {
  if (group.lastSyncAt !== null && pull.lastSyncAt - group.lastSyncAt > HISTORY_GAP_MS) {
    group.missingHistory = true;
  }
  const added = takePull(group, pull, idOf);
  for (const bytes of pull.sent ?? []) dropSent(group, bytes);
  if (hearsFrom(group.archived, pull, added)) delete group.archived;
  if (isRoomEntry(group)) {
    group.log = group.log.filter((record) => keptInRoom(record.received, pull.relayNow));
  }
  group.relayNow = pull.relayNow;
  group.instance = pull.instance;
  group.lastSyncAt = pull.lastSyncAt;
}

/**
 * Whether a pull brings word from the group to a copy a restore brought back
 * (#231): its relay minute is at most 28 days after the copy last synced, so
 * the relay still held everything since and the pass read it, a `dissolve`
 * included; or it `added` a record the copy didn't hold, received at or
 * after that, since every record from before was in the copy. Never for
 * anything else, a dissolved archive included.
 */
function hearsFrom(archived: Group['archived'], pull: Pull, added: readonly LogRecord[]): boolean {
  if (archived?.reason !== 'unconfirmed') return false;
  const { since } = archived;
  return (
    pull.relayNow - since <= HISTORY_GAP_MINUTES || added.some(({ received }) => received >= since)
  );
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
  changed: (plan: boolean) => void,
): RelayBackupStore {
  /**
   * Writes `next(held)` in one key transaction, unless it's undefined, and
   * with `fresh` set also forgets that an earlier key was retired (#272);
   * returns the state held before.
   */
  const write = async (
    next: (held: RelayBackupState | undefined) => RelayBackupState | undefined,
    fresh = false,
  ): Promise<{ held: RelayBackupState | undefined; wrote: boolean }> => {
    const result = await writeKeys(db, async (tx) => {
      const held = await backupIn(tx, session);
      const state = next(held);
      if (state !== undefined) await keepKeys(tx, session, { relayBackup: state });
      if (state !== undefined && fresh) await tx.objectStore(DEVICE).delete(RELAY_BACKUP_RETIRED);
      return { held, wrote: state !== undefined };
    });
    if (result.wrote) changed(false);
    return result;
  };
  const fresh = (key: Uint8Array, split?: string): RelayBackupState => ({
    key: Uint8Array.from(key),
    digest: null,
    checkedDay: null,
    uploadedAt: null,
    tooLarge: false,
    uploaded: [],
    uploadedGroups: [],
    ...(split === undefined ? {} : { split }),
  });
  return {
    getRelayBackup: () => backupIn(db.transaction([DEVICE, VAULT]), session),
    async setRelayBackupKey(key, split) {
      return (await write(() => fresh(key, split), true)).held;
    },
    async adoptRelayBackupKey(key, split) {
      return (await write((held) => (held === undefined ? fresh(key, split) : undefined), true))
        .wrote;
    },
    async updateRelayBackup(key, update) {
      const result = await write((held) =>
        held !== undefined && sameBytes(held.key, key) ? { ...held, ...update } : undefined,
      );
      return result.wrote;
    },
    async retireRelayBackup(key, at) {
      const result = await writeKeys(db, async (tx) => {
        const held = await backupIn(tx, session);
        if (held === undefined || !sameBytes(held.key, key)) return { wrote: false, plan: false };
        await keepKeys(tx, session, { relayBackup: null });
        const devices = tx.objectStore(DEVICE);
        await devices.put({ retiredAt: at }, RELAY_BACKUP_RETIRED);
        const plan = recoveryPlanIn(await devices.get(RECOVERY));
        const supersedes = plan !== undefined && plan.supersededAt === undefined;
        if (supersedes) await devices.put({ ...plan, supersededAt: at }, RECOVERY);
        return { wrote: true, plan: supersedes };
      });
      if (result.wrote) changed(result.plan);
      return result.wrote;
    },
    getRelayBackupRetiredAt: async () => retiredAtIn(await db.get(DEVICE, RELAY_BACKUP_RETIRED)),
  };
}

/** The push DELETEs owed, one record in `db`'s device store (#356); no listener hears of a change. */
function pushForgetStore(db: IDBPDatabase<Schema>): PushForgetStore {
  return {
    listPushForgets: async () => pushForgetsIn(await db.get(DEVICE, PUSH_FORGETS)),
    async updatePushForgets(edit) {
      const tx = db.transaction(DEVICE, 'readwrite');
      const forgets = [...edit(pushForgetsIn(await tx.store.get(PUSH_FORGETS)))];
      if (forgets.length === 0) await tx.store.delete(PUSH_FORGETS);
      else await tx.store.put({ forgets }, PUSH_FORGETS);
      await tx.done;
    },
  };
}

/** The shelf's copy, one record in `db`'s device store (#431); no listener hears of a change. */
function shelfCopyStore(db: IDBPDatabase<Schema>): ShelfCopyStore {
  return {
    getShelfCopy: async () => shelfCopyIn(await db.get(DEVICE, SHELF_COPY)),
    async keepShelfCopy(copy) {
      if (copy === null) await db.delete(DEVICE, SHELF_COPY);
      else await db.put(DEVICE, copy, SHELF_COPY);
    },
  };
}

/** The steward's inbox, one record in `db`'s device store (#490). */
function stewardInboxStore(db: IDBPDatabase<Schema>): StewardInboxStore {
  return {
    getStewardInbox: async () => stewardInboxIn(await db.get(DEVICE, STEWARD_INBOX)),
    async keepStewardInbox(kept) {
      if (kept === null) await db.delete(DEVICE, STEWARD_INBOX);
      else await db.put(DEVICE, kept, STEWARD_INBOX);
    },
  };
}

/**
 * The removals record, one record in `db`'s device store (#491), read with
 * the doors of the applications in the sent store, whose records keep their
 * door and time outside the vault (#265), so no vault is opened. Each write
 * tells `changed`.
 */
function removalStore(db: IDBPDatabase<Schema>, changed: () => void): RemovalStore {
  /** Applies `edit` to the record in one change. */
  async function edit(change: (kept: KeptRemovals) => KeptRemovals): Promise<void> {
    const tx = db.transaction(DEVICE, 'readwrite');
    const devices = tx.objectStore(DEVICE);
    await devices.put(change(removalsIn(await devices.get(REMOVALS))), REMOVALS);
    await tx.done;
    changed();
  }
  return {
    async removalsAt(now) {
      const tx = db.transaction([SENT, DEVICE], 'readwrite');
      const applications = (await tx.objectStore(SENT).getAll()).map(
        ({ door, sentAt }): SentToDoor => ({ door, sentAt, kind: 'application' }),
      );
      const devices = tx.objectStore(DEVICE);
      const held = await devices.get(REMOVALS);
      const kept = prunedRemovals(removalsIn(held), applications, now);
      if (held !== undefined) await devices.put(kept, REMOVALS);
      await tx.done;
      const cards = kept.cards.map(({ door, sentAt }): SentToDoor => ({
        door,
        sentAt,
        kind: 'card',
      }));
      return {
        sent: [...applications, ...cards].sort((a, b) => a.sentAt - b.sentAt),
        dismissed: kept.dismissed.map(({ key }) => key),
      };
    },
    noteSentCard: (card) => edit((kept) => withSentCard(kept, card)),
    dismissRemoval: (dismissal) => edit((kept) => withDismissed(kept, dismissal)),
  };
}

/** The steward's key, one record in `db`'s device store (#488), telling `changed` after each write. */
function stewardKeyStore(
  db: IDBPDatabase<Schema>,
  session: Session,
  changed: () => void,
): StewardKeyStore {
  return {
    holdsStewardKey: async () => stewardKeyIn(await db.get(DEVICE, STEWARD_KEY)) !== undefined,
    async getStewardKey() {
      const tx = db.transaction([DEVICE, VAULT]);
      const stored = stewardKeyIn(await tx.objectStore(DEVICE).get(STEWARD_KEY));
      if (stored === undefined) return undefined;
      const opened = await vaultKeys(tx, session);
      return wholeRecord(stewardSealing, stored, sealedFor(opened, DEVICE, STEWARD_KEY)).secret;
    },
    async keepStewardKey(secret, at) {
      const key = { secret: Uint8Array.from(secret), stewardSince: at };
      await writeKeys(db, (tx) => keepKeys(tx, session, { steward: key }));
      changed();
    },
    async dropStewardKey() {
      await writeKeys(db, (tx) => keepKeys(tx, session, { steward: null }));
      changed();
    },
  };
}

/** The recovery contacts' record in `db`'s device store (#109), telling `changed` after each write. */
function recoveryStore(
  db: IDBPDatabase<Schema>,
  session: Session,
  changed: () => void,
): RecoveryStore {
  return {
    getRecoveryPlan: async () => recoveryPlanIn(await db.get(DEVICE, RECOVERY)),
    async setRecoveryPlan(plan) {
      await db.put(DEVICE, plan, RECOVERY);
      changed();
    },
    async markRetiredChecked(day) {
      const tx = db.transaction(DEVICE, 'readwrite');
      const held = recoveryPlanIn(await tx.store.get(RECOVERY));
      if (held !== undefined) await tx.store.put({ ...held, retiredCheckedDay: day }, RECOVERY);
      await tx.done;
      if (held !== undefined) changed();
    },
    async getRecoverRequest() {
      const tx = db.transaction([DEVICE, VAULT]);
      const stored = recoverRequestIn(await tx.objectStore(DEVICE).get(RECOVER_REQUEST));
      return stored && wholeRequest(stored, await vaultKeys(tx, session));
    },
    async keepRecoverRequest(fresh) {
      const kept = await writeKeys(db, async (tx) => {
        // The vault opens first, so a locked device refuses even a request it holds already.
        const opened = await vaultKeys(tx, session);
        const stored = recoverRequestIn(await tx.objectStore(DEVICE).get(RECOVER_REQUEST));
        if (stored !== undefined) return { request: wholeRequest(stored, opened), wrote: false };
        await keepKeys(tx, session, { recoverRequest: fresh });
        return { request: fresh, wrote: true };
      });
      if (kept.wrote) changed();
      return kept.request;
    },
    async dropRecoverRequest() {
      await writeKeys(db, (tx) => keepKeys(tx, session, { recoverRequest: null }));
      changed();
    },
    async finishRecovery(at) {
      await writeKeys(db, async (tx) => {
        await keepKeys(tx, session, { recoverRequest: null });
        await tx.objectStore(DEVICE).put({ recoveredAt: at }, RECOVERED);
      });
      changed();
    },
    getRecoveredAt: async () => recoveredAtIn(await db.get(DEVICE, RECOVERED)),
  };
}

/**
 * `stored` whole (#118): with the seed and secret key it holds itself, or
 * else the vault's for it in `opened`.
 *
 * @throws {Error} when its keys are in neither.
 */
function wholeRequest(stored: StoredRecoverRequest, opened: OpenedVault | null): RecoverRequest {
  return wholeRecord(requestSealing, stored, sealedFor(opened, DEVICE, RECOVER_REQUEST));
}

/** `hold` without its code and second number (#118, #398). */
function withoutCode(hold: RecoveryHold): RecoveryHold {
  const bare: RecoveryHold & { code?: string; number?: string } = { ...hold };
  delete bare.code;
  delete bare.number;
  return bare;
}

/**
 * `hold` ended as `end` says, when it is the hold of `alert` and still holds
 * (#118): without its code and number once stopped, and with them once sent,
 * so it can go again (#398).
 */
function endedHold(hold: RecoveryHold, alert: string, end: HoldEnd): RecoveryHold {
  if (hold.alert !== alert || hold.ended !== undefined) return hold;
  const ended = { ...hold, ended: end };
  return end.kind === 'stopped' ? withoutCode(ended) : ended;
}

/**
 * Adds a pull's records that `group`'s log lacks, but none that expired with
 * a Proposal it has cleared (#111), and takes its cursors. A
 * pull from a relay instance the group hasn't read before is a fresh relay
 * database's, whose seqs start again from 1: its records go after the whole
 * log, and every mailbox is read from that relay's start, from its base
 * cursor of 0 (#110). Otherwise each record goes in relay order
 * (`logOrder.ts`). Returns the records it added.
 */
function takePull(
  group: Pick<Group, 'log' | 'cursor' | 'cursors' | 'instance' | 'cleared'>,
  pull: Pull,
  idOf: EventIdOf,
): LogRecord[] {
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
  return added;
}

/**
 * Moves `group` to the epoch `advance` names: its secret and base cursor, with
 * no cursor of the old epoch's mailboxes (#110), and its records to post
 * again ahead of the outbox, skipping any already queued. A restored copy
 * that still reads only (#231) moves its keys and queues none: it sends
 * nothing until it hears from its group.
 */
function advanceTo(group: Group, { epoch, secret, cursor, repost }: EpochAdvance): void {
  group.epoch = epoch;
  group.secret = secret;
  group.cursor = cursor;
  delete group.cursors;
  if (group.archived !== undefined) return;
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
  const documents = tx.objectStore(PERSONAL);
  const keptDocuments: PersonalDocument[] = [];
  for (const restored of personal) {
    const stored = await documents.get(restored.id);
    const held =
      stored && wholeRecord(shareSealing, stored, sealedFor(opened, PERSONAL, restored.id));
    if (!keepsHeldCopy(held, restored)) keptDocuments.push(restoredCopy(held, restored));
  }
  await keepKeys(tx, session, { put: kept, personal: { put: keptDocuments } });
}

/**
 * What Restore on the unlock screen does before it restores (#95, #255,
 * #265): the vault and every key in it are gone, so a shared Document whose
 * keys it held takes the file's share of it, marked pending and paused, or
 * none, and a sent application whose reply keys it held is forgotten, since
 * its reply can't open. A record that still holds its own keys keeps them.
 * Returns whether any sent application went.
 *
 * The file's share is one the restore brought: with the vault gone, nothing
 * says it's the one the device held, and the person may have stopped it
 * since the file was saved. So it waits, paused, until they keep it (#328).
 */
async function forgetSealed(
  tx: KeyTransaction,
  session: Session,
  personal: readonly PersonalDocument[],
): Promise<boolean> {
  const shares = new Map(personal.map(({ id, share }) => [id, share]));
  const orphaned = (await tx.objectStore(PERSONAL).getAll()).filter(isSealedShare);
  // Through the one key-writing path, as every write of a share's keys goes (#391).
  const put = orphaned.map((document): PersonalDocument => {
    const share = shares.get(document.id);
    return {
      ...textOf(document),
      ...(share && { share: { ...share, pending: true, paused: true } }),
    };
  });
  await keepKeys(tx, session, { personal: { put } });
  const sent = tx.objectStore(SENT);
  const lost = (await sent.getAll()).filter(
    (record) => replySealing.split(record).secrets === null,
  );
  for (const { id } of lost) await sent.delete(id);
  return lost.length > 0;
}

/**
 * What Restore on the unlock screen does with a recovering device's request
 * (#118): its seed and secret key went with the vault, so its record goes
 * too, and the person starts again. One that still holds its own keys stays.
 * Returns whether it went.
 */
async function forgetSealedRequest(tx: KeyTransaction): Promise<boolean> {
  const devices = tx.objectStore(DEVICE);
  const request = recoverRequestIn(await devices.get(RECOVER_REQUEST));
  const lost = request !== undefined && requestSealing.split(request).secrets === null;
  if (lost) await devices.delete(RECOVER_REQUEST);
  return lost;
}

/**
 * What Restore on the unlock screen does with the steward's key (#488): a
 * secret that went with the vault takes its record with it, and the steward
 * imports it again. One that still holds its own secret stays. Returns
 * whether it went.
 */
async function forgetSealedSteward(tx: KeyTransaction): Promise<boolean> {
  const devices = tx.objectStore(DEVICE);
  const key = stewardKeyIn(await devices.get(STEWARD_KEY));
  const lost = key !== undefined && stewardSealing.split(key).secrets === null;
  if (lost) await devices.delete(STEWARD_KEY);
  return lost;
}

/** Whether `document` is shared with its keys in the vault, not on its record (#255). */
function isSealedShare(document: StoredDocument): boolean {
  return shareSealing.hasSecrets(document) && shareSealing.split(document).secrets === null;
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
 * back to life (#108). A restored copy reads only until it hears from the
 * group (#231, `readOnlyFor`), and also clears what `held` had cleared
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
    ...readOnlyFor(restored),
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
 * How a restored copy reads until it hears from its group (#231): a copy
 * whose log holds a `dissolve`, or a `remove` naming this member, stays
 * archived for good (#108, #115), and any other group's copy reads only,
 * from the relay minute it last synced, since the group may have dissolved
 * after it was made. A coalition's entry never dissolves (#114), so it's
 * kept as it is.
 */
function readOnlyFor(restored: BackedUpGroup): Pick<Group, 'archived'> {
  if (restored.archived !== undefined || isCoalitionEntry(restored)) return {};
  return { archived: { reason: 'unconfirmed', since: restored.relayNow ?? 0 } };
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
  return opened(vaultIn(await tx.objectStore(VAULT).get(VAULT_ID)), session);
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
  const keys = plain ? null : opened(vaultIn(await tx.objectStore(VAULT).get(VAULT_ID)), session);
  return read.flatMap((record) => (record === undefined ? [] : [wholeGroup(record, keys)]));
}

/** Records of one sealed store to put whole, and ids to delete (#255, #265). */
interface RecordChange<Whole> {
  readonly put?: readonly Whole[];
  readonly drop?: readonly string[];
}

/**
 * The stores whose records keep their secrets in the vault, as the vault
 * names them: personal Documents (#255), sent applications (#265), and the
 * device store, for a recovering device's request (#118).
 */
type SealedStore = typeof PERSONAL | typeof SENT | typeof DEVICE;

/** A store whose records keep their secrets in the vault, and how each splits (#255, #265). */
interface SealedKind<Whole extends Kept, Kept extends { readonly id: string }> {
  readonly store: SealedStore;
  readonly sealing: Sealing<Whole, Kept>;
}

/** Personal Documents, whose shares' keys the vault keeps (#255). */
const SHARES: SealedKind<PersonalDocument, StoredDocument> = {
  store: PERSONAL,
  sealing: shareSealing,
};

/** Sent applications, whose reply keys the vault keeps (#265). */
const REPLIES: SealedKind<SentApplication, StoredSent> = { store: SENT, sealing: replySealing };

/**
 * Each of `records` of `kind`, whole (#255, #265): with the secrets it holds
 * itself, or else the vault's. `vault` opens the vault, and runs only when
 * one of them has secrets, so a Document that isn't shared reads while it's
 * locked.
 *
 * @throws {VaultLocked} when one has secrets and the device has a vault this session hasn't opened.
 */
async function wholeIn<Whole extends Kept, Kept extends { readonly id: string }>(
  kind: SealedKind<Whole, Kept>,
  records: readonly Kept[],
  vault: () => Promise<OpenedVault | null>,
): Promise<Whole[]> {
  const { store, sealing } = kind;
  const keys = records.some((record) => sealing.hasSecrets(record)) ? await vault() : null;
  return records.map((record) => wholeRecord(sealing, record, sealedFor(keys, store, record.id)));
}

/**
 * What one write of key material does: the groups to put, whole, the ones to
 * delete, the relay backup's state to keep, key and all (#97), the personal
 * Documents (#255) and sent applications (#265) to put, whole, or delete, and
 * a recovering device's request (#118) to keep, whole, or with null forget.
 */
interface KeyChange {
  readonly put?: readonly Group[];
  readonly drop?: readonly string[];
  /** The relay backup's state to keep, or null to forget it, key and all (#272). */
  readonly relayBackup?: RelayBackupState | null;
  readonly personal?: RecordChange<PersonalDocument>;
  readonly sent?: RecordChange<SentApplication>;
  readonly recoverRequest?: RecoverRequest | null;
  /** The steward's key to keep, whole, or null to forget it (#488). */
  readonly steward?: StewardKey | null;
}

/** One write `keepKeys` makes, planned before it makes any (#391). */
type KeyWrite = () => Promise<unknown>;

/**
 * `keepKeys`' writes, in the order that never leaves a key in neither place
 * (#391, S4): each delete before the vault lets go of its keys, and each put
 * after the vault holds them.
 */
interface KeyWrites {
  readonly drops: KeyWrite[];
  readonly puts: KeyWrite[];
}

/**
 * The one write path for key material (#95). Inside `tx`, deletes each group
 * in `drop`, puts each in `put`, and keeps `relayBackup`. Without a vault,
 * each record holds its own keys, as before the vault. With one, every key
 * goes into the vault, resealed under the session's key in the same
 * transaction, and each record goes without them, so no secret is ever
 * written outside it.
 *
 * It plans every write first, so a refusal writes nothing, then deletes, then
 * reseals the vault, then puts (#391). Should the transaction commit early,
 * as an await of anything but IndexedDB inside it would make it, every key
 * is still in its record or in the vault: never in neither.
 *
 * @throws {VaultLocked} when the device has a vault this session hasn't opened.
 * @throws {UnsealableKeys} when a key wouldn't read back from the vault (#390).
 * @throws {Error} when, with a vault, a record holds only some of its keys (#391).
 */
async function keepKeys(tx: KeyTransaction, session: Session, change: KeyChange): Promise<void> {
  await keepKeysIn(tx, await vaultKeys(tx, session), change);
}

/**
 * {@link keepKeys} with the vault `opened` already, or null without one: a
 * vault `sealKeys` makes goes in only once it holds every key.
 */
async function keepKeysIn(
  tx: KeyTransaction,
  opened: OpenedVault | null,
  change: KeyChange,
): Promise<void> {
  const sealed = opened?.keys ?? null;
  const writes: KeyWrites = { drops: [], puts: [] };
  planGroups(tx, sealed, change, writes);
  if (change.relayBackup !== undefined) planBackup(tx, sealed, change.relayBackup, writes);
  planRecords(tx.objectStore(PERSONAL), SHARES, sealed, change.personal, writes);
  planRecords(tx.objectStore(SENT), REPLIES, sealed, change.sent, writes);
  if (change.recoverRequest !== undefined) planRequest(tx, sealed, change.recoverRequest, writes);
  if (change.steward !== undefined) planSteward(tx, sealed, change.steward, writes);
  const vault = opened === null ? null : resealKeys(opened.vault, opened.key, opened.keys);
  for (const write of writes.drops) await write();
  if (vault !== null) await tx.objectStore(VAULT).put(vault);
  for (const write of writes.puts) await write();
}

/** Where the vault keeps the secrets of `store`'s records, made when it holds none yet; null without a vault. */
function entriesIn(sealed: VaultKeys | null, store: SealedStore): Map<string, Secrets> | null {
  if (sealed === null) return null;
  const entries = sealed.records.get(store) ?? new Map<string, Secrets>();
  sealed.records.set(store, entries);
  return entries;
}

/** The vault's secrets for the record `id` of `store`, or undefined without a vault or any. */
function sealedFor(
  opened: OpenedVault | null,
  store: SealedStore,
  id: string,
): Secrets | undefined {
  return opened?.keys.records.get(store)?.get(id);
}

/** Just what `keepKeys` asks of a sealed store: to put a record, and delete one by id. */
interface RecordStore<Kept> {
  put(value: Kept): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/**
 * `whole` split by `sealing` for the vault (#391): its record without its
 * secrets, and the secrets.
 *
 * @throws {Error} when it has secrets the split doesn't take, which would
 * otherwise be written in the clear: a record holding only some of its keys.
 */
function sealedSplit<Whole extends Kept, Kept>(
  sealing: Sealing<Whole, Kept>,
  whole: Kept,
): Split<Kept> {
  const split = sealing.split(whole);
  if (split.secrets === null && sealing.hasSecrets(whole)) {
    throw new Error('A record’s keys are incomplete, so nothing was written.');
  }
  return split;
}

/**
 * `keepKeys`' records of one sealed store (#255, #265): each in `drop`
 * deleted, and each in `put` kept whole without a vault, or split by its
 * kind's sealing with one, its secrets into `sealed` and the rest into its
 * record. The vault's side is done here; the records' writes go in `writes`.
 */
function planRecords<Whole extends Kept, Kept extends { readonly id: string }>(
  records: RecordStore<Kept>,
  { store, sealing }: SealedKind<Whole, Kept>,
  sealed: VaultKeys | null,
  change: RecordChange<Whole> = {},
  writes: KeyWrites,
): void {
  const entries = entriesIn(sealed, store);
  for (const id of change.drop ?? []) {
    entries?.delete(id);
    writes.drops.push(() => records.delete(id));
  }
  for (const whole of change.put ?? []) {
    if (entries === null) {
      writes.puts.push(() => records.put(whole));
      continue;
    }
    const { kept, secrets } = sealedSplit(sealing, whole);
    if (secrets === null) entries.delete(whole.id);
    else entries.set(whole.id, secrets);
    writes.puts.push(() => records.put(kept));
  }
}

/**
 * `keepKeys`' recovery request (#118): deleted for null, or put whole without
 * a vault, or split by {@link requestSealing} with one, its seed and secret
 * key into `sealed` and when it started into its record.
 */
function planRequest(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  request: RecoverRequest | null,
  writes: KeyWrites,
): void {
  const records = tx.objectStore(DEVICE);
  const entries = entriesIn(sealed, DEVICE);
  if (request === null) {
    entries?.delete(RECOVER_REQUEST);
    writes.drops.push(() => records.delete(RECOVER_REQUEST));
    return;
  }
  if (entries === null) {
    writes.puts.push(() => records.put(request, RECOVER_REQUEST));
    return;
  }
  const { kept, secrets } = sealedSplit(requestSealing, request);
  if (secrets === null) entries.delete(RECOVER_REQUEST);
  else entries.set(RECOVER_REQUEST, secrets);
  writes.puts.push(() => records.put(kept, RECOVER_REQUEST));
}

/**
 * `keepKeys`' steward key (#488): deleted for null, or put whole without a
 * vault, or split by {@link stewardSealing} with one, its secret into
 * `sealed` and when it was imported into its record.
 */
function planSteward(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  key: StewardKey | null,
  writes: KeyWrites,
): void {
  const records = tx.objectStore(DEVICE);
  const entries = entriesIn(sealed, DEVICE);
  if (key === null) {
    entries?.delete(STEWARD_KEY);
    writes.drops.push(() => records.delete(STEWARD_KEY));
    return;
  }
  if (entries === null) {
    writes.puts.push(() => records.put(key, STEWARD_KEY));
    return;
  }
  const { kept, secrets } = sealedSplit(stewardSealing, key);
  if (secrets === null) entries.delete(STEWARD_KEY);
  else entries.set(STEWARD_KEY, secrets);
  writes.puts.push(() => records.put(kept, STEWARD_KEY));
}

/**
 * The personal Documents, sent applications and recovery request that still
 * hold their keys in the clear, whole: records kept before #255, #265 and
 * #118's sealing, or on a device with no vault, for `keepKeys` to seal.
 */
async function plainSecrets(tx: KeyTransaction): Promise<PlainSecrets> {
  const documents = await tx.objectStore(PERSONAL).getAll();
  const sent = await tx.objectStore(SENT).getAll();
  const request = recoverRequestIn(await tx.objectStore(DEVICE).get(RECOVER_REQUEST));
  const [plainRequest] = plainRecords(requestSealing, request === undefined ? [] : [request]);
  const steward = stewardKeyIn(await tx.objectStore(DEVICE).get(STEWARD_KEY));
  const [plainSteward] = plainRecords(stewardSealing, steward === undefined ? [] : [steward]);
  return {
    personal: { put: plainRecords(SHARES.sealing, documents) },
    sent: { put: plainRecords(REPLIES.sealing, sent) },
    ...(plainRequest === undefined ? {} : { recoverRequest: plainRequest }),
    ...(plainSteward === undefined ? {} : { steward: plainSteward }),
  };
}

/** The records `plainSecrets` finds, as a {@link KeyChange} puts them. */
interface PlainSecrets {
  readonly personal: { readonly put: readonly PersonalDocument[] };
  readonly sent: { readonly put: readonly SentApplication[] };
  readonly recoverRequest?: RecoverRequest;
  readonly steward?: StewardKey;
}

/**
 * Seals into the vault, under `session`'s key, every share key, reply key and
 * recovery request key a record still holds in the clear: what a device #95
 * sealed before #255, #265 and #118's sealing holds until its first unlock
 * after them. Writes nothing when there are none.
 */
async function sealPlain(tx: KeyTransaction, session: Session): Promise<void> {
  const plain = await plainSecrets(tx);
  const records = plain.personal.put.length + plain.sent.put.length;
  const keys = plain.recoverRequest !== undefined || plain.steward !== undefined;
  if (records > 0 || keys) await keepKeys(tx, session, plain);
}

/**
 * `keepKeys`' groups: each deleted or put in `tx`, its keys into `sealed`
 * when the device has a vault, the records' writes in `writes`.
 */
function planGroups(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  change: KeyChange,
  writes: KeyWrites,
): void {
  const records = tx.objectStore(GROUPS);
  for (const groupId of change.drop ?? []) {
    sealed?.groups.delete(groupId);
    writes.drops.push(() => records.delete(groupId));
  }
  for (const group of change.put ?? []) {
    const { secret, signingKey, kxKey, ...rest } = group;
    sealed?.groups.set(group.groupId, {
      secret,
      signingKey,
      ...(kxKey === undefined ? {} : { kxKey }),
    });
    writes.puts.push(() => records.put(sealed === null ? group : rest));
  }
}

/**
 * Sets the relay backup's `checkedDay` back to null in `tx`, when the device
 * keeps one, so the next complete pass reads and checks the relay copy
 * (#327). It touches nothing else of the record, so it needs no key, and no
 * listener hears of it: Settings shows nothing of the day.
 */
async function checkBackupAgain(tx: KeyTransaction): Promise<void> {
  const records = tx.objectStore(DEVICE);
  const record = await records.get(RELAY_BACKUP);
  if (record !== undefined) await records.put({ ...record, checkedDay: null }, RELAY_BACKUP);
}

/**
 * `keepKeys`' relay backup: its record put in `tx`, its key into `sealed`
 * when the device has a vault; or, for null, both gone (#272). The record's
 * write goes in `writes`.
 */
function planBackup(
  tx: KeyTransaction,
  sealed: VaultKeys | null,
  state: RelayBackupState | null,
  writes: KeyWrites,
): void {
  const records = tx.objectStore(DEVICE);
  if (state === null) {
    if (sealed !== null) delete sealed.backupKey;
    writes.drops.push(() => records.delete(RELAY_BACKUP));
    return;
  }
  const { key, ...rest } = state;
  if (sealed !== null) sealed.backupKey = Uint8Array.from(key);
  writes.puts.push(() => records.put(sealed === null ? state : rest, RELAY_BACKUP));
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
  const tx = db.transaction([GROUPS, PERSONAL, DEVICE, VAULT, SENT], 'readwrite');
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

/** The Bedfellows history's slot holding `plaintext`, sealed under the vault `key` (#480). */
function slotOf(key: Uint8Array, plaintext: Uint8Array): HistorySlot {
  return { id: HISTORY_ID, sealed: sealHistory(key, plaintext) };
}

/** An empty Bedfellows history's slot, sealed under the vault `key` (#480). */
function emptySlot(key: Uint8Array): HistorySlot {
  return slotOf(key, encodeHistory(EMPTY_HISTORY));
}

/**
 * Gives a vault that has none an empty Bedfellows history's slot, as one
 * sealed before #480 lacks (#480): written at its first unlock after, so
 * every vault has one whether Bedfellows was opened or not.
 */
async function slotFor(tx: KeyTransaction, key: Uint8Array): Promise<void> {
  const slots = tx.objectStore(VAULT);
  if ((await slots.getKey(HISTORY_ID)) === undefined) await slots.put(emptySlot(key));
}

/**
 * The vault key this session may seal the Bedfellows history under, read
 * inside `tx`, or null when the device has no vault.
 *
 * @throws {VaultLocked} when it has one this session hasn't opened.
 */
async function historyKey<Mode extends IDBTransactionMode>(
  tx: IDBPTransaction<Schema, [typeof VAULT], Mode>,
  session: Session,
): Promise<Uint8Array | null> {
  if ((await tx.objectStore(VAULT).getKey(VAULT_ID)) === undefined) return null;
  if (session.key === null) throw new VaultLocked();
  return session.key;
}

/** The history `slot` holds under `key`: empty when there's none, or it doesn't open or check out. */
function historyIn(slot: VaultRecord | HistorySlot | undefined, key: Uint8Array): BedfellowsState {
  const sealed = slot !== undefined && !('credentialId' in slot) ? slot.sealed : undefined;
  const plaintext = sealed === undefined ? null : openHistory(key, sealed);
  const state = plaintext === null ? null : decodeHistory(plaintext);
  plaintext?.fill(0);
  return state ?? EMPTY_HISTORY;
}

/**
 * The Bedfellows history (#480; `./bedfellows.ts`): one sealed slot beside
 * the vault, read and written only under this session's vault key, in the
 * vault store alone. Nothing about it sits in a plain record, no snapshot
 * reads the vault store, and Restore's `replaceGroups` clears that store, so
 * the history never leaves the device and a restored one starts without it.
 * `cleared` hears each clear.
 */
function historyStore(
  db: IDBPDatabase<Schema>,
  session: Session,
  cleared: () => void,
): Omit<HistoryStore, 'subscribe'> & Pick<Store, 'sweepBedfellows'> {
  /** Seals `state` into the slot, in place of what it held: false without a vault. */
  const keep = async (state: BedfellowsState): Promise<boolean> => {
    const plaintext = encodeHistory(state);
    try {
      // A refusal throws before any write, so the transaction commits nothing.
      const tx = db.transaction(VAULT, 'readwrite');
      const key = await historyKey(tx, session);
      if (key !== null) await tx.objectStore(VAULT).put(slotOf(key, plaintext));
      await tx.done;
      return key !== null;
    } finally {
      plaintext.fill(0);
    }
  };
  return {
    async readBedfellows() {
      const tx = db.transaction(VAULT);
      const key = await historyKey(tx, session);
      return key === null ? null : historyIn(await tx.objectStore(VAULT).get(HISTORY_ID), key);
    },
    keepBedfellows: keep,
    async clearBedfellows() {
      await keep(EMPTY_HISTORY);
      cleared();
    },
    async sweepBedfellows(now) {
      // Without the key, the device has no vault or a locked one: nothing to sweep either way.
      const { key } = session;
      if (key === null) return;
      const tx = db.transaction(VAULT, 'readwrite');
      const slots = tx.objectStore(VAULT);
      const held = historyIn(await slots.get(HISTORY_ID), key);
      const swept = expireHistory(held, now);
      if (swept !== held) await slots.put(slotOf(key, encodeHistory(swept)));
      await tx.done;
    },
  };
}
