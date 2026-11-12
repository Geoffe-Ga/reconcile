/**
 * What a backup file holds (spec §3 "Backup file"; #78): every group on the
 * device and every personal Document (#93), as JSON with its bytes in
 * unpadded base64url, sealed by `crypto/backup.ts` under the person's
 * passphrase.
 *
 * For each group it keeps the keys, the secret, your name, the log's event
 * bytes with their relay seqs and receipt times, the cursor, the relay's
 * last `now` and `instance`, the last successful sync time, and whether some
 * history may be missing. Format 2 (#98) adds the encryption key, the
 * secret's epoch, and each record's epoch when it isn't 0; a format 1 file,
 * as #78 saved it, reads as epoch 0 with no encryption key, and the sync loop
 * then makes one. A group whose device has cleared ballots (#111) also lists
 * those Proposals as `cleared`, with no new format number: a file without it
 * clears nothing, and a restore folds each listed Proposal's outcome from
 * its result. It leaves out the outbox and drafts, so a restore
 * never sends stale intent, and it leaves out a group this device is
 * leaving, and one whose genesis the relay hasn't returned yet, since
 * neither has anything to come back to. It leaves out a dissolved group's
 * read-only copy too (#108): its ballots are due to be cleared, or the group
 * to be erased, and a file would keep them past that.
 *
 * Each personal Document goes in whole: its id, title, text, and when it
 * was made and last edited, and its share by link while it is shared (#105),
 * so a restore keeps the same link and can stop it; a second device's link
 * (#96) takes `withoutShares`. #93 added them without a new format number,
 * so a format 1 file may hold them or not: one from before #93 has no
 * `personal` field, and reads as holding no personal Documents. A file from
 * before #105 holds no shares.
 *
 * A coalition's entry (#114) goes in beside the groups once its genesis is
 * back, and one kept by following its link (#124) says so with `following:
 * true`, no new format number, so a restore keeps it followed; a file
 * without it holds no followed coalition, and only a coalition's entry may
 * carry it.
 *
 * It also carries the device's relay backup key (#97, ADR-0075 §4), when the
 * device keeps one, so a device restored from the file keeps the relay
 * backup fresh. A restoring device that already keeps a key keeps its own. A
 * file from before #97 has no `backupKey`, and brings no key. The plaintext
 * the relay backup seals is this same snapshot without the key
 * (`relayBackup.ts`), and `importSnapshot` reads it back.
 *
 * Restoring opens the file, then checks everything before it writes
 * anything: the shape of every field, that each key makes its author, that
 * every log record verifies, that each log folds to its own group, and that
 * each personal Document is one the device could keep (`isPersonalDocument`),
 * and that a backup key is 32 bytes. Anything wrong fails as a wrong
 * passphrase does, with `BackupUnreadable`, and the store keeps every group
 * and Document in one transaction (`Store.restoreGroups`), then the key. A
 * group whose log folds to a `dissolve`, as an older app's file could hold,
 * comes back as a read-only copy, so a restore never brings a dissolved group
 * back to life (#108).
 *
 * A second device's link bundle (#96) is the same plaintext without the
 * passphrase layer: `takeSnapshot` makes it and `importSnapshot` checks and
 * keeps it, as from a link, and the link seals it under its own key instead.
 * So a link carries what a backup does, format 2's keys and epochs (#98),
 * every personal Document (#93) and the relay backup key (#97) included, and
 * leaves out what a backup does, a dissolved group's read-only copy (#108)
 * and push (#99) included. It leaves out one thing more: each Document's
 * share by link (#105, `withoutShares`). A share belongs to the device that
 * made it, since personal Documents don't sync, so the new device starts
 * with every Document unshared and the existing one keeps, and alone can
 * stop, its link. Both sides drop it: `takeSnapshot` as for a link, and
 * `importSnapshot` from one.
 */
import { BACKUP_LOG2_N, BackupUnreadable, openBackup, sealBackup } from '../crypto/backup';
import { base64url, canonicalBytes } from '../crypto/base64url';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';
import type { LogRecord } from '../engine/fold';
import { removedFrom } from '../engine/removal';
import type { Archive, BackedUpGroup, Group, RestoredFrom, Store } from './db';
import { deriveCoalitionEntryId } from '../crypto/card';
import { epochOf, secretFits } from './epochs';
import { eventIdOf } from './eventId';
import { foldGroup } from './expiry';
import {
  isPersonalDocument,
  isShareState,
  type PersonalDocument,
  type PersonalText,
  type ShareState,
  textOf,
} from './personal';

/** The plaintext's format number: 2 since #98 added encryption keys and epochs. */
export const SNAPSHOT_FORMAT = 2;

/** The format #78 wrote, which a restore still reads. */
const FORMAT_1 = 1;

/** The largest epoch: a u32 carries it. */
const MAX_EPOCH = 0xffff_ffff;

/** The largest file a restore reads: 64 MiB, far past any pilot group's history. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** A group id: a SHA-256 event id in unpadded base64url. */
const GROUP_ID = /^[A-Za-z0-9_-]{43}$/;

/** A group's secret and signing key are 32 bytes each. */
const KEY_BYTES = 32;

/**
 * Everything a backup holds: the groups it keeps, every personal Document
 * (#93), and the relay backup key, if any (#97).
 */
export interface Snapshot {
  readonly groups: readonly BackedUpGroup[];
  readonly personal: readonly PersonalDocument[];
  /** The device's relay backup key; absent when it keeps none, and from the relay's own copy. */
  readonly backupKey?: Uint8Array;
}

/** A saved backup: the sealed file, and the groups it holds. */
export interface SavedBackup {
  readonly file: Uint8Array<ArrayBuffer>;
  readonly groupIds: readonly string[];
}

/**
 * Whether the relay has returned the group's genesis: its log folds to the
 * group itself, or for a coalition's entry (#114), to a coalition whose
 * entry id is the one its secret derives.
 */
function isFounded(
  group: Pick<Group, 'groupId' | 'log' | 'relayNow' | 'cleared' | 'kind' | 'secret'>,
): boolean {
  const state = foldGroup(group);
  if (group.kind !== 'coalition') return state.group === group.groupId;
  return state.coalition !== null && deriveCoalitionEntryId(group.secret) === group.groupId;
}

/**
 * What a backup keeps of `groups`: each founded group that isn't leaving or
 * a read-only archive (#108), without its outbox, drafts, chat claims (#119),
 * what the chat bot learned of the webhook (#123) or marks.
 */
export function backedUpGroups(groups: readonly Group[]): BackedUpGroup[] {
  return groups
    .filter((group) => group.leaving === undefined && group.archived === undefined)
    .filter(isFounded)
    .map((group) => ({
      ...(group.kind === undefined ? {} : { kind: group.kind }),
      ...(group.following === true ? { following: true as const } : {}),
      groupId: group.groupId,
      secret: group.secret,
      signingKey: group.signingKey,
      ...(group.kxKey === undefined ? {} : { kxKey: group.kxKey }),
      ...(epochOf(group) === 0 ? {} : { epoch: epochOf(group) }),
      me: { author: group.me.author, name: group.me.name },
      log: group.log,
      cursor: group.cursor,
      relayNow: group.relayNow,
      instance: group.instance,
      lastSyncAt: group.lastSyncAt,
      missingHistory: group.missingHistory === true,
      ...(group.cleared === undefined || group.cleared.length === 0
        ? {}
        : { cleared: [...group.cleared] }),
    }));
}

/**
 * What a backup keeps of everything on `store`: its groups, every personal
 * Document, and its relay backup key.
 */
export async function deviceSnapshot(
  store: Pick<Store, 'listGroups' | 'listCoalitions' | 'listPersonal' | 'getRelayBackup'>,
): Promise<Snapshot> {
  const [groups, coalitions, personal, relayBackup] = await Promise.all([
    store.listGroups(),
    store.listCoalitions(),
    store.listPersonal(),
    store.getRelayBackup(),
  ]);
  const kept = { groups: backedUpGroups([...groups, ...coalitions]), personal };
  return relayBackup === undefined ? kept : { ...kept, backupKey: relayBackup.key };
}

/**
 * The snapshot a second device takes (#96): everything `snapshot` holds, its
 * relay backup key (#97) included, less each Document's share by link
 * (#105). Personal Documents don't sync between devices, so two devices
 * posting one share would roll its link back and forth; the linked device
 * can make its own link instead.
 */
export function withoutShares(snapshot: Snapshot): Snapshot {
  return { ...snapshot, personal: snapshot.personal.map(textOf) };
}

/** A share by link (#105) as the backup's JSON holds it: its bytes in unpadded base64url. */
function shareJson(share: ShareState) {
  const { seed, secretKey, publicKey, n, lastPostedAt, pending } = share;
  return {
    seed: base64url(seed),
    secretKey: base64url(secretKey),
    publicKey: base64url(publicKey),
    n,
    lastPostedAt,
    pending,
  };
}

/** One personal Document as the backup's JSON holds it: its five fields, and its share when shared. */
function personalJson(document: PersonalDocument) {
  const { share } = document;
  return { ...textOf(document), ...(share === undefined ? {} : { share: shareJson(share) }) };
}

/** `snapshot` as the backup's plaintext: UTF-8 JSON, bytes in unpadded base64url. */
export function encodeSnapshot({ groups, personal, backupKey }: Snapshot): Uint8Array<ArrayBuffer> {
  const json = {
    format: SNAPSHOT_FORMAT,
    groups: groups.map((group) => ({
      ...(group.kind === undefined ? {} : { kind: group.kind }),
      ...(group.following === true ? { following: true } : {}),
      groupId: group.groupId,
      secret: base64url(group.secret),
      signingKey: base64url(group.signingKey),
      ...(group.kxKey === undefined ? {} : { kxKey: base64url(group.kxKey) }),
      epoch: epochOf(group),
      me: { author: group.me.author, name: group.me.name },
      log: group.log.map(({ seq, received, bytes, epoch = 0 }) => ({
        seq,
        received,
        bytes: base64url(bytes),
        ...(epoch === 0 ? {} : { epoch }),
      })),
      cursor: group.cursor,
      relayNow: group.relayNow,
      instance: group.instance,
      lastSyncAt: group.lastSyncAt,
      missingHistory: group.missingHistory,
      ...(group.cleared === undefined || group.cleared.length === 0
        ? {}
        : { cleared: group.cleared }),
    })),
    personal: personal.map(personalJson),
    ...(backupKey === undefined ? {} : { backupKey: base64url(backupKey) }),
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/** Everything a backup keeps, as the plaintext a backup file or a link bundle carries (#96). */
export interface SnapshotPlaintext {
  /** The UTF-8 JSON, which the caller zeroes once it's sealed. */
  readonly plaintext: Uint8Array<ArrayBuffer>;
  /** The groups it holds. */
  readonly groupIds: readonly string[];
}

/**
 * The plaintext of everything on the device that a backup keeps: its groups,
 * every personal Document and its relay backup key (`deviceSnapshot`). It is
 * a backup file's plaintext, and, `to` a link, a link's bundle (#96), which
 * leaves out every share by link (`withoutShares`, #105).
 */
export async function takeSnapshot(
  store: Parameters<typeof deviceSnapshot>[0],
  to: RestoredFrom = 'backup',
): Promise<SnapshotPlaintext> {
  const held = await deviceSnapshot(store);
  const snapshot = to === 'link' ? withoutShares(held) : held;
  return {
    plaintext: encodeSnapshot(snapshot),
    groupIds: snapshot.groups.map((group) => group.groupId),
  };
}

/**
 * Seals every group on the device that a backup keeps, every personal
 * Document, and its relay backup key, under `passphrase`, at scrypt cost
 * `log2N` (17 unless a test asks for less).
 */
export async function exportGroups(
  store: Pick<Store, 'listGroups' | 'listCoalitions' | 'listPersonal' | 'getRelayBackup'>,
  passphrase: string,
  log2N = BACKUP_LOG2_N,
): Promise<SavedBackup> {
  const { plaintext, groupIds } = await takeSnapshot(store);
  try {
    const file = await sealBackup(plaintext, passphrase, log2N);
    return { file, groupIds };
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Everything in `file`, opened under `passphrase` and every part checked.
 *
 * @throws {BackupUnreadable} for a wrong passphrase, a damaged or oversized
 *   file, or contents that don't check out.
 */
async function readBackup(file: Uint8Array, passphrase: string): Promise<Snapshot> {
  if (file.length > MAX_BACKUP_BYTES) throw new BackupUnreadable();
  const plaintext = await openBackup(file, passphrase);
  const snapshot = decodeSnapshot(plaintext);
  plaintext.fill(0);
  if (snapshot === null) throw new BackupUnreadable();
  return snapshot;
}

/**
 * Opens `file` under `passphrase`, checks every group and personal Document
 * in it, and keeps them all in one transaction. Returns how many groups the
 * file held.
 *
 * @throws {BackupUnreadable} for a wrong passphrase, a damaged or oversized
 *   file, or contents that don't check out; nothing is written then.
 */
export async function importGroups(
  store: Pick<Store, 'restoreGroups' | 'adoptRelayBackupKey'>,
  file: Uint8Array,
  passphrase: string,
): Promise<number> {
  if (file.length > MAX_BACKUP_BYTES) throw new BackupUnreadable();
  const plaintext = await openBackup(file, passphrase);
  try {
    return await importSnapshot(store, plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Checks every group and personal Document in a backup's or a link bundle's
 * `plaintext`, keeps them all in one transaction, marked as `from` says
 * (`Store.restoreGroups`), then keeps its relay backup key if the device has
 * none. From a link it keeps no share by link (#105), even one a bundle
 * holds, so the device keeps any share of its own (`restoredCopy`) and takes
 * none of another's. Returns how many groups it held. `importGroups` calls
 * it once a file is open, a second device's link (#96) once the bundle is
 * in, and the relay backup's restore (#118) once `fetchRelayBackup` has.
 *
 * @throws {BackupUnreadable} when anything in it doesn't check out; nothing is written then.
 */
export async function importSnapshot(
  store: Pick<Store, 'restoreGroups' | 'adoptRelayBackupKey'>,
  plaintext: Uint8Array,
  from: RestoredFrom = 'backup',
): Promise<number> {
  const decoded = decodeSnapshot(plaintext);
  if (decoded === null) throw new BackupUnreadable();
  const snapshot = from === 'link' ? withoutShares(decoded) : decoded;
  await store.restoreGroups(snapshot.groups, snapshot.personal, from);
  if (snapshot.backupKey !== undefined) await store.adoptRelayBackupKey(snapshot.backupKey);
  return snapshot.groups.length;
}

/**
 * Opens and checks `file` as {@link importGroups} does, then puts its groups
 * in place of every group on the device and its vault, in one transaction
 * (#95): Restore on the unlock screen, once the passkey no longer opens the
 * vault and so nothing in it can be read. The relay backup's key (#97) went
 * with the vault, so its state goes too, and the file's key, if it holds
 * one, is kept instead. Its personal Documents, which hold no key, merge as
 * {@link importGroups} merges them. Returns how many groups the file held.
 *
 * @throws {BackupUnreadable} as {@link importGroups} does; nothing is written then.
 */
export async function replaceWithBackup(
  store: Pick<Store, 'replaceGroups' | 'adoptRelayBackupKey'>,
  file: Uint8Array,
  passphrase: string,
): Promise<number> {
  const snapshot = await readBackup(file, passphrase);
  await store.replaceGroups(snapshot.groups, snapshot.personal);
  if (snapshot.backupKey !== undefined) await store.adoptRelayBackupKey(snapshot.backupKey);
  return snapshot.groups.length;
}

/** A backup plaintext's JSON object, or null when it isn't one of a format a restore reads. */
function snapshotJson(plaintext: Uint8Array): Record<string, unknown> | null {
  const json = parseJson(plaintext);
  if (!isObject(json)) return null;
  return json.format === SNAPSHOT_FORMAT || json.format === FORMAT_1 ? json : null;
}

/**
 * The personal Documents in a backup's `json`, or null when any doesn't
 * check out. A file from before #93 has no `personal` field: it holds none.
 */
function personalOf(json: Record<string, unknown>): PersonalDocument[] | null {
  return json.personal === undefined ? [] : personalIn(json.personal);
}

/** Everything in a backup's plaintext, or null when anything in it doesn't check out. */
export function decodeSnapshot(plaintext: Uint8Array): Snapshot | null {
  const json = snapshotJson(plaintext);
  if (json === null) return null;
  const groups = groupsIn(json.groups, json.format === FORMAT_1 ? groupIn : groupWithKeysIn);
  const personal = personalOf(json);
  if (groups === null || personal === null) return null;
  if (!('backupKey' in json)) return { groups, personal };
  // A file from before #97 has no key; one that has a key holds a well-formed one.
  const backupKey = keyIn(json.backupKey);
  return backupKey === null ? null : { groups, personal, backupKey };
}

/**
 * Only the personal Documents in a backup's plaintext, each checked as a
 * restore checks it, or null when the plaintext isn't a snapshot a restore
 * reads or any of them doesn't check out. The relay backup reads the relay
 * copy with it before an upload (#247): it merges only that copy's
 * Documents, so it checks none of its groups.
 */
export function decodePersonal(plaintext: Uint8Array): PersonalDocument[] | null {
  const json = snapshotJson(plaintext);
  return json === null ? null : personalOf(json);
}

/** Each of `values` read by `read`, or null when any is null or two share a key. */
function allUnique<T>(
  values: readonly unknown[],
  read: (value: unknown) => T | null,
  key: (item: T) => string,
): T[] | null {
  const items = values.map(read);
  const kept = items.filter((item) => item !== null);
  const keys = new Set(kept.map(key));
  return kept.length === items.length && keys.size === kept.length ? kept : null;
}

/**
 * The groups in `value`, each read by `read` as its file's format has it, or
 * null when it isn't a list of valid groups, each once.
 */
function groupsIn(
  value: unknown,
  read: (value: unknown) => BackedUpGroup | null,
): BackedUpGroup[] | null {
  return Array.isArray(value) ? allUnique(value, read, (group) => group.groupId) : null;
}

/** The personal Documents in `value`, or null when it isn't a list of valid ones, each once. */
function personalIn(value: unknown): PersonalDocument[] | null {
  if (!Array.isArray(value)) return null;
  return allUnique(value, documentIn, (document) => document.id);
}

/** One personal Document in `value`, with its share when it has one (#105), or null. */
function documentIn(value: unknown): PersonalDocument | null {
  if (!isObject(value)) return null;
  const share = value.share === undefined ? undefined : shareIn(value.share);
  if (share === null) return null;
  // Read only through isPersonalDocument, which checks every field this picks.
  const words = textOf(value as unknown as PersonalText);
  const document: PersonalDocument = share === undefined ? words : { ...words, share };
  return isPersonalDocument(document) ? document : null;
}

/** A share by link in `value` (#105), or null when any part of it doesn't check out. */
function shareIn(value: unknown): ShareState | null {
  if (!isObject(value)) return null;
  const share = {
    seed: keyIn(value.seed),
    secretKey: keyIn(value.secretKey),
    publicKey: keyIn(value.publicKey),
    n: value.n,
    lastPostedAt: value.lastPostedAt,
    pending: value.pending,
  };
  return isShareState(share) ? share : null;
}

/** The JSON value `bytes` spell in UTF-8, or undefined when they don't. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a whole number from 0 to 2^53 − 1. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether `value` is a whole number from 0 up, or null. */
function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value);
}

/** A 32-byte key in `value`, or null. */
function keyIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = canonicalBytes(value);
  return bytes?.length === KEY_BYTES ? bytes : null;
}

/** Whether `value` is an epoch from 1 up, as a record that names its epoch has (#98). */
function isLaterEpoch(value: unknown): value is number {
  return isCount(value) && value >= 1 && value <= MAX_EPOCH;
}

/**
 * One log record in `value`: a whole seq and receipt time, a signed record
 * that verifies, and the epoch it was read from when that isn't 0 (#98).
 */
function recordIn(value: unknown): LogRecord | null {
  if (!isObject(value) || !isCount(value.seq) || !isCount(value.received)) return null;
  const bytes = canonicalBytes(value.bytes);
  if (bytes === null || bytes.length > MAX_RECORD_BYTES || eventIdOf(bytes) === null) return null;
  const { epoch } = value;
  if (epoch !== undefined && !isLaterEpoch(epoch)) return null;
  return {
    seq: value.seq,
    received: value.received,
    bytes,
    ...(epoch === undefined ? {} : { epoch }),
  };
}

/** The log in `value`, or null when it isn't a list of valid records. */
function logIn(value: unknown): LogRecord[] | null {
  if (!Array.isArray(value)) return null;
  const log = value.map(recordIn);
  return log.some((record) => record === null) ? null : log.filter((record) => record !== null);
}

/** Your membership in `value`, when `signingKey` makes its author and its name is text. */
function meIn(value: unknown, signingKey: Uint8Array): BackedUpGroup['me'] | null {
  if (!isObject(value) || typeof value.name !== 'string') return null;
  return value.author === base64url(publicKeyOf(signingKey))
    ? { author: value.author, name: value.name }
    : null;
}

/** Whether a group's sync state in `value` is well formed. */
function hasSyncState(value: Record<string, unknown>): boolean {
  return (
    isCount(value.cursor) &&
    isCountOrNull(value.relayNow) &&
    (value.instance === null || typeof value.instance === 'string') &&
    isCountOrNull(value.lastSyncAt) &&
    typeof value.missingHistory === 'boolean'
  );
}

/** A coalition entry's kind (#114) as its own field, none for a group, or null for any other. */
function kindIn(value: unknown): Pick<BackedUpGroup, 'kind'> | null {
  if (value === undefined) return {};
  return value === 'coalition' ? { kind: value } : null;
}

/**
 * Whether a coalition entry is only followed (#124), as its own field: none
 * when absent, and null for anything but `true` on a coalition's entry.
 */
function followingIn(
  value: unknown,
  kind: Pick<BackedUpGroup, 'kind'>,
): Pick<BackedUpGroup, 'following'> | null {
  if (value === undefined) return {};
  return value === true && kind.kind === 'coalition' ? { following: value } : null;
}

/**
 * What a backed-up group says of who it is and what it holds: your
 * membership, its kind (#114), whether it's only followed (#124) and its
 * cleared Proposals (#111), or null when any of them doesn't check out.
 */
function marksIn(value: Record<string, unknown>, signingKey: Uint8Array) {
  const me = meIn(value.me, signingKey);
  const kind = kindIn(value.kind);
  const following = kind === null ? null : followingIn(value.following, kind);
  const cleared = clearedIn(value.cleared);
  if (me === null || kind === null || following === null || cleared === null) return null;
  return { me, kind: { ...kind, ...following }, cleared };
}

/** One backed-up group in `value`, or null when any part of it doesn't check out. */
function groupIn(value: unknown): BackedUpGroup | null {
  if (!isObject(value) || typeof value.groupId !== 'string' || !GROUP_ID.test(value.groupId)) {
    return null;
  }
  const secret = keyIn(value.secret);
  const signingKey = keyIn(value.signingKey);
  const log = logIn(value.log);
  if (secret === null || signingKey === null || log === null || !hasSyncState(value)) return null;
  const marks = marksIn(value, signingKey);
  if (marks === null) return null;
  const { me, kind, cleared } = marks;
  return restoredAs({
    ...kind,
    groupId: value.groupId,
    secret,
    signingKey,
    me,
    log,
    cursor: value.cursor as number,
    relayNow: value.relayNow as number | null,
    instance: value.instance as string | null,
    lastSyncAt: value.lastSyncAt as number | null,
    missingHistory: value.missingHistory as boolean,
    ...cleared,
  });
}

/**
 * The Proposals a group's device had cleared (#111), as the group keeps
 * them: none for a file without them, as every file from before #111 is, or
 * an empty list, and null unless it's a list of distinct event ids.
 */
function clearedIn(value: unknown): Pick<BackedUpGroup, 'cleared'> | null {
  if (value === undefined) return {};
  if (!Array.isArray(value)) return null;
  const list: readonly unknown[] = value;
  const ids = list.filter((id): id is string => typeof id === 'string' && GROUP_ID.test(id));
  if (ids.length !== list.length || new Set(ids).size !== ids.length) return null;
  return ids.length === 0 ? {} : { cleared: ids };
}

/** A dissolved group's read-only mark (#108). */
const DISSOLVED: Archive = { reason: 'dissolved' };

/** The read-only mark of a group a vote removed this member from (#115). */
const REMOVED: Archive = { reason: 'removed' };

/**
 * `group` as a restore keeps it, or null when its log doesn't fold to the
 * group itself. A log holding a `dissolve` comes back read-only (#108), and
 * so does one holding a `remove` of this member (#115).
 */
function restoredAs(group: BackedUpGroup): BackedUpGroup | null {
  const state = foldGroup(group);
  if (!isFounded(group)) return null;
  if (state.dissolved !== null) return { ...group, archived: DISSOLVED };
  return removedFrom(state, group.me.author) === undefined
    ? group
    : { ...group, archived: REMOVED };
}

/**
 * One backed-up group of a format 2 file (#98): a format 1 group, plus its
 * encryption key when it has one and the epoch of its secret, which must be
 * 0 or the epoch of a key change in its log that commits to that secret.
 */
function groupWithKeysIn(value: unknown): BackedUpGroup | null {
  const group = groupIn(value);
  if (group === null || !isObject(value)) return null;
  const { epoch } = value;
  const kxKey = value.kxKey === undefined ? undefined : keyIn(value.kxKey);
  if (kxKey === null || !(epoch === 0 || isLaterEpoch(epoch))) return null;
  if (!secretFits(foldGroup(group), epoch, group.secret)) return null;
  return {
    ...group,
    ...(kxKey === undefined ? {} : { kxKey }),
    ...(epoch === 0 ? {} : { epoch }),
  };
}
