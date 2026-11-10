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
 * neither has anything to come back to.
 *
 * Restoring opens the file, then checks everything before it writes
 * anything: the shape of every field, that each key makes its author, that
 * every log record verifies, and that each log folds to its own group.
 * Anything wrong fails as a wrong passphrase does, with `BackupUnreadable`,
 * and the store keeps every group in one transaction (`Store.restoreGroups`).
 *
 * A second device's link bundle (#96) is the same plaintext without the
 * passphrase layer: `takeSnapshot` makes it and `restoreSnapshot` checks and
 * keeps it, and the link seals it under its own key instead.
 */
import { BACKUP_LOG2_N, BackupUnreadable, openBackup, sealBackup } from '../crypto/backup';
import { base64url, fromBase64url } from '../crypto/base64url';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { publicKeyOf } from '../crypto/sign';
import { fold, type LogRecord } from '../engine/fold';
import type { BackedUpGroup, Group, RestoredFrom, Store } from './db';
import { eventIdOf } from './eventId';

/** The plaintext's format number, which a later layout would change. */
export const SNAPSHOT_FORMAT = 1;

/** The largest file a restore reads: 64 MiB, far past any pilot group's history. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** A group id: a SHA-256 event id in unpadded base64url. */
const GROUP_ID = /^[A-Za-z0-9_-]{43}$/;

/** A group's secret and signing key are 32 bytes each. */
const KEY_BYTES = 32;

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
 * What a backup keeps of `groups`: each founded group that isn't leaving,
 * without its outbox, drafts, chat claims (#119) or marks.
 */
export function backedUpGroups(groups: readonly Group[]): BackedUpGroup[] {
  return groups
    .filter((group) => group.leaving === undefined && isFounded(group))
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

/** `groups` as the backup's plaintext: UTF-8 JSON, bytes in unpadded base64url. */
export function encodeSnapshot(groups: readonly BackedUpGroup[]): Uint8Array<ArrayBuffer> {
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
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/** Every group a backup keeps, as the plaintext a backup file or a link bundle carries. */
export interface Snapshot {
  /** The UTF-8 JSON, which the caller zeroes once it's sealed. */
  readonly plaintext: Uint8Array<ArrayBuffer>;
  /** The groups it holds. */
  readonly groupIds: readonly string[];
}

/** The plaintext of every group on the device that a backup keeps (#96: a link's bundle). */
export async function takeSnapshot(store: Pick<Store, 'listGroups'>): Promise<Snapshot> {
  const groups = backedUpGroups(await store.listGroups());
  return { plaintext: encodeSnapshot(groups), groupIds: groups.map((group) => group.groupId) };
}

/**
 * Checks every group in `plaintext` and keeps them all in one transaction,
 * marked as `from` says (`Store.restoreGroups`). Returns how many it held.
 *
 * @throws {BackupUnreadable} when anything in it doesn't check out; nothing is written then.
 */
export async function restoreSnapshot(
  store: Pick<Store, 'restoreGroups'>,
  plaintext: Uint8Array,
  from: RestoredFrom,
): Promise<number> {
  const groups = decodeSnapshot(plaintext);
  if (groups === null) throw new BackupUnreadable();
  await store.restoreGroups(groups, from);
  return groups.length;
}

/**
 * Seals every group on the device that a backup keeps under `passphrase`, at
 * scrypt cost `log2N` (17 unless a test asks for less).
 */
export async function exportGroups(
  store: Pick<Store, 'listGroups'>,
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
 * Opens `file` under `passphrase`, checks every group in it, and keeps them
 * all in one transaction. Returns how many groups the file held.
 *
 * @throws {BackupUnreadable} for a wrong passphrase, a damaged or oversized
 *   file, or contents that don't check out; nothing is written then.
 */
export async function importGroups(
  store: Pick<Store, 'restoreGroups'>,
  file: Uint8Array,
  passphrase: string,
): Promise<number> {
  if (file.length > MAX_BACKUP_BYTES) throw new BackupUnreadable();
  const plaintext = await openBackup(file, passphrase);
  try {
    return await restoreSnapshot(store, plaintext, 'backup');
  } finally {
    plaintext.fill(0);
  }
}

/** The groups in a backup's plaintext, or null when anything in it doesn't check out. */
export function decodeSnapshot(plaintext: Uint8Array): BackedUpGroup[] | null {
  const json = parseJson(plaintext);
  if (!isObject(json) || json.format !== SNAPSHOT_FORMAT || !Array.isArray(json.groups)) {
    return null;
  }
  const groups = json.groups.map(groupIn);
  const ids = new Set(groups.map((group) => group?.groupId));
  if (groups.some((group) => group === null) || ids.size !== groups.length) return null;
  return groups.filter((group) => group !== null);
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
  const group = {
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
  };
  return me !== null && isFounded(group) ? { ...group, me } : null;
}
