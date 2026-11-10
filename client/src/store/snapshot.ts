/**
 * What a backup file holds (spec §3 "Backup file"; #78): every group on the
 * device, as JSON with its bytes in unpadded base64url, sealed by
 * `crypto/backup.ts` under the person's passphrase.
 *
 * For each group it keeps the keys, the secret, your name, the log's event
 * bytes with their relay seqs and receipt times, the cursor, the relay's
 * last `now` and `instance`, the last successful sync time, and whether some
 * history may be missing. It leaves out the outbox and drafts, so a restore
 * never sends stale intent, and it leaves out a group this device is
 * leaving, and one whose genesis the relay hasn't returned yet, since
 * neither has anything to come back to. It leaves out a dissolved group's
 * read-only copy too (#108): its ballots are due to be cleared, or the group
 * to be erased, and a file would keep them past that.
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
 * a backup key is 32 bytes. Anything wrong fails as a wrong passphrase does,
 * with `BackupUnreadable`, and the store keeps every group in one
 * transaction (`Store.restoreGroups`), then the key. A group whose log folds
 * to a `dissolve`, as an older app's file could hold, comes back as a
 * read-only copy, so a restore never brings a dissolved group back to life
 * (#108).
 */
import { BACKUP_LOG2_N, BackupUnreadable, openBackup, sealBackup } from '../crypto/backup';
import { base64url, fromBase64url } from '../crypto/base64url';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';
import { fold, type LogRecord } from '../engine/fold';
import type { Archive, BackedUpGroup, Group, Store } from './db';
import { eventIdOf } from './eventId';

/** The plaintext's format number, which a later layout would change. */
export const SNAPSHOT_FORMAT = 1;

/** The largest file a restore reads: 64 MiB, far past any pilot group's history. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** A group id: a SHA-256 event id in unpadded base64url. */
const GROUP_ID = /^[A-Za-z0-9_-]{43}$/;

/** A group's secret and signing key are 32 bytes each. */
const KEY_BYTES = 32;

/** Everything a backup holds: the groups it keeps, and the relay backup key, if any (#97). */
export interface Snapshot {
  readonly groups: readonly BackedUpGroup[];
  /** The device's relay backup key; absent when it keeps none, and from the relay's own copy. */
  readonly backupKey?: Uint8Array;
}

/** A saved backup: the sealed file, and the groups it holds. */
export interface SavedBackup {
  readonly file: Uint8Array<ArrayBuffer>;
  readonly groupIds: readonly string[];
}

/** Whether the relay has returned the group's genesis: its log folds to the group itself. */
function isFounded(group: Pick<Group, 'groupId' | 'log' | 'relayNow'>): boolean {
  return fold(group.log, group.relayNow).group === group.groupId;
}

/**
 * What a backup keeps of `groups`: each founded group that isn't leaving or
 * a read-only archive (#108), without its outbox, drafts, chat claims (#119)
 * or marks.
 */
export function backedUpGroups(groups: readonly Group[]): BackedUpGroup[] {
  return groups
    .filter((group) => group.leaving === undefined && group.archived === undefined)
    .filter(isFounded)
    .map((group) => ({
      groupId: group.groupId,
      secret: group.secret,
      signingKey: group.signingKey,
      me: { author: group.me.author, name: group.me.name },
      log: group.log,
      cursor: group.cursor,
      relayNow: group.relayNow,
      instance: group.instance,
      lastSyncAt: group.lastSyncAt,
      missingHistory: group.missingHistory === true,
    }));
}

/** What a backup keeps of everything on `store`: its groups, and its relay backup key. */
export async function deviceSnapshot(
  store: Pick<Store, 'listGroups' | 'getRelayBackup'>,
): Promise<Snapshot> {
  const [groups, relayBackup] = await Promise.all([store.listGroups(), store.getRelayBackup()]);
  const kept = backedUpGroups(groups);
  return relayBackup === undefined
    ? { groups: kept }
    : { groups: kept, backupKey: relayBackup.key };
}

/** `snapshot` as the backup's plaintext: UTF-8 JSON, bytes in unpadded base64url. */
export function encodeSnapshot({ groups, backupKey }: Snapshot): Uint8Array<ArrayBuffer> {
  const json = {
    format: SNAPSHOT_FORMAT,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      secret: base64url(group.secret),
      signingKey: base64url(group.signingKey),
      me: { author: group.me.author, name: group.me.name },
      log: group.log.map(({ seq, received, bytes }) => ({
        seq,
        received,
        bytes: base64url(bytes),
      })),
      cursor: group.cursor,
      relayNow: group.relayNow,
      instance: group.instance,
      lastSyncAt: group.lastSyncAt,
      missingHistory: group.missingHistory,
    })),
    ...(backupKey === undefined ? {} : { backupKey: base64url(backupKey) }),
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/**
 * Seals every group on the device that a backup keeps, and its relay backup
 * key, under `passphrase`, at scrypt cost `log2N` (17 unless a test asks for
 * less).
 */
export async function exportGroups(
  store: Pick<Store, 'listGroups' | 'getRelayBackup'>,
  passphrase: string,
  log2N = BACKUP_LOG2_N,
): Promise<SavedBackup> {
  const snapshot = await deviceSnapshot(store);
  const { groups } = snapshot;
  const plaintext = encodeSnapshot(snapshot);
  try {
    const file = await sealBackup(plaintext, passphrase, log2N);
    return { file, groupIds: groups.map((group) => group.groupId) };
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Opens `file` under `passphrase`, checks every group in it, and keeps them
 * all in one transaction. Returns how many groups the file held.
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
 * Checks every group in a backup's `plaintext`, keeps them all in one
 * transaction, then keeps its relay backup key if the device has none.
 * Returns how many groups it held. `importGroups` calls it once a file is
 * open, and the relay backup's restore (#118) once `fetchRelayBackup` has.
 *
 * @throws {BackupUnreadable} when anything in it doesn't check out; nothing is written then.
 */
export async function importSnapshot(
  store: Pick<Store, 'restoreGroups' | 'adoptRelayBackupKey'>,
  plaintext: Uint8Array,
): Promise<number> {
  const snapshot = decodeSnapshot(plaintext);
  if (snapshot === null) throw new BackupUnreadable();
  await store.restoreGroups(snapshot.groups);
  if (snapshot.backupKey !== undefined) await store.adoptRelayBackupKey(snapshot.backupKey);
  return snapshot.groups.length;
}

/** Everything in a backup's plaintext, or null when anything in it doesn't check out. */
export function decodeSnapshot(plaintext: Uint8Array): Snapshot | null {
  const json = parseJson(plaintext);
  if (!isObject(json) || json.format !== SNAPSHOT_FORMAT || !Array.isArray(json.groups)) {
    return null;
  }
  const groups = json.groups.map(groupIn);
  const ids = new Set(groups.map((group) => group?.groupId));
  if (groups.some((group) => group === null) || ids.size !== groups.length) return null;
  const kept = groups.filter((group) => group !== null);
  if (!('backupKey' in json)) return { groups: kept };
  // A file from before #97 has no key; one that has a key holds a well-formed one.
  const backupKey = keyIn(json.backupKey);
  return backupKey === null ? null : { groups: kept, backupKey };
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

/** The bytes `value` spells in canonical unpadded base64url, or null. */
function bytesIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64url(value);
    return base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** A 32-byte key in `value`, or null. */
function keyIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = bytesIn(value);
  return bytes?.length === KEY_BYTES ? bytes : null;
}

/** One log record in `value`: a whole seq and receipt time, and a signed record that verifies. */
function recordIn(value: unknown): LogRecord | null {
  if (!isObject(value) || !isCount(value.seq) || !isCount(value.received)) return null;
  const bytes = bytesIn(value.bytes);
  if (bytes === null || bytes.length > MAX_RECORD_BYTES || eventIdOf(bytes) === null) return null;
  return { seq: value.seq, received: value.received, bytes };
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

/** One backed-up group in `value`, or null when any part of it doesn't check out. */
function groupIn(value: unknown): BackedUpGroup | null {
  if (!isObject(value) || typeof value.groupId !== 'string' || !GROUP_ID.test(value.groupId)) {
    return null;
  }
  const secret = keyIn(value.secret);
  const signingKey = keyIn(value.signingKey);
  const log = logIn(value.log);
  if (secret === null || signingKey === null || log === null || !hasSyncState(value)) return null;
  const me = meIn(value.me, signingKey);
  if (me === null) return null;
  return restoredAs({
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
  });
}

/** A dissolved group's read-only mark (#108). */
const DISSOLVED: Archive = { reason: 'dissolved' };

/**
 * `group` as a restore keeps it, or null when its log doesn't fold to the
 * group itself. A log holding a `dissolve` comes back read-only (#108).
 */
function restoredAs(group: BackedUpGroup): BackedUpGroup | null {
  const state = fold(group.log, group.relayNow);
  if (state.group !== group.groupId) return null;
  return state.dissolved === null ? group : { ...group, archived: DISSOLVED };
}
