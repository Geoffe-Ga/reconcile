/**
 * The relay backup (spec §3 "Relay backup"; #97; ADR-0043 §3 as ADR-0074
 * and ADR-0075 §4 revised it): an up-to-date, encrypted copy of every group
 * on the device, kept on the relay so recovery contacts (#118) can bring the
 * groups back after every device is lost.
 *
 * - **The key.** {@link startRelayBackup} makes a random 32-byte backup key
 *   when the device has none, or when asked for a new one, and keeps it
 *   device-wide, in no group (`Store.setRelayBackupKey`). It travels in the
 *   passphrase backup file (`snapshot.ts`) and so in #96's link bundle,
 *   which reuses the snapshot, so a restored or linked device keeps the
 *   backup fresh. It never goes to the relay, even sealed: the relay's copy
 *   is the snapshot without it. #109 calls `startRelayBackup` when someone
 *   chooses contacts, since a backup nobody else can unlock helps no one.
 * - **What the relay sees.** One blob under a 43-character id that derives
 *   from the key alone and is linked to no mailbox, in one of five sizes
 *   (`crypto/relayBackup.ts`), written at most once a relay day, and the
 *   connecting IP, which it doesn't keep. Uploads come from the same address
 *   as the device's group syncs, so someone watching the relay live can tie
 *   the backup to those groups (ADR-0075 §2).
 * - **The schedule.** Once a key exists, after the first sync pass of each
 *   UTC day by relay time in which every group synced, the device uploads
 *   if what it would upload has changed since the last upload: never on
 *   every change. The relay day is the latest `relayNow` among the device's
 *   groups, so with no synced group there is no day and nothing is
 *   scheduled. A failed upload tries again after the next complete pass.
 * - **Too large.** Over 16 MiB the device keeps the last good backup on the
 *   relay, and Settings says so.
 * - **Reading it back.** {@link fetchRelayBackup} derives the id, GETs and
 *   opens the blob, and returns the plaintext for `importSnapshot`.
 */
import { sha256 } from '../crypto/hash';
import {
  backupIdFor,
  newBackupKey,
  openRelayBackup,
  RelayBackupTooLarge,
  sealRelayBackup,
} from '../crypto/relayBackup';
import type { Relay } from '../net/relay';
import type { RelayBackupState, Store } from './db';
import { deviceSnapshot, encodeSnapshot, type Snapshot } from './snapshot';

/** Minutes in a UTC day: a relay minute's day is ⌊minute / 1,440⌋. */
const DAY_MINUTES = 1440;

/** What the relay backup works with: `AppServices` has all three. */
export interface RelayBackupServices {
  /** What `deviceSnapshot` reads, and the relay backup's own record. */
  readonly store: Parameters<typeof deviceSnapshot>[0] &
    Pick<Store, 'getRelayBackup' | 'setRelayBackupKey' | 'updateRelayBackup'>;
  readonly relay: Pick<Relay, 'putBackup'>;
  /** The device clock in milliseconds, for when the last upload succeeded. */
  readonly now: () => number;
}

/** Whether to make a new backup key even when the device has one (#109's re-split). */
export interface StartOptions {
  readonly newKey?: boolean;
}

/** What Settings says of the relay backup. */
export type RelayBackupStatus =
  | { readonly kind: 'off' | 'waiting' | 'too-large' }
  | { readonly kind: 'saved'; readonly at: number };

/**
 * Makes a backup key when the device has none or `newKey` is set, keeps it
 * device-wide, and uploads at once. Returns the id the replaced key named,
 * or null when no key was replaced. An upload that fails, offline say, leaves
 * the key kept and the status waiting, and the schedule tries again after the
 * next complete sync pass; one over 16 MiB leaves the status too large.
 */
export async function startRelayBackup(
  services: RelayBackupServices,
  { newKey = false }: StartOptions = {},
): Promise<string | null> {
  const held = await services.store.getRelayBackup();
  if (held !== undefined && !newKey) {
    await upload(services, held.key, await relayCopy(services));
    return null;
  }
  const key = newBackupKey();
  const replaced = await services.store.setRelayBackupKey(key);
  await upload(services, key, await relayCopy(services));
  key.fill(0);
  return replaced === undefined ? null : backupIdFor(replaced.key);
}

/**
 * The daily refresh, run after every sync pass in which every group synced:
 * the first such pass of each relay day uploads if anything changed since
 * the last upload, and every later pass that day does nothing.
 */
export async function refreshRelayBackup(services: RelayBackupServices): Promise<void> {
  const state = await services.store.getRelayBackup();
  if (state === undefined) return;
  const copy = await relayCopy(services);
  const day = relayDayOf(copy);
  if (day === null || (state.checkedDay !== null && day <= state.checkedDay)) return;
  if (digestOf(copy) === state.digest) {
    await services.store.updateRelayBackup(state.key, { checkedDay: day });
    return;
  }
  await upload(services, state.key, copy);
}

/**
 * The plaintext of the backup `key` names, read from the relay and opened,
 * or null when the relay holds none (404), its tag fails, or its frame is
 * bad. #118 hands it to `importSnapshot`.
 *
 * @throws {RelayError | TypeError} when the relay can't be reached or refuses
 *   otherwise, so no backup and no network never read alike.
 */
export async function fetchRelayBackup(
  relay: Pick<Relay, 'getBackup'>,
  key: Uint8Array,
): Promise<Uint8Array | null> {
  const blob = await relay.getBackup(backupIdFor(key));
  return blob === null ? null : openRelayBackup(key, blob);
}

/** What Settings says of `state`: too large first, then the last upload, else waiting. */
export function relayBackupStatus(state: RelayBackupState | undefined): RelayBackupStatus {
  if (state === undefined) return { kind: 'off' };
  if (state.tooLarge) return { kind: 'too-large' };
  return state.uploadedAt === null ? { kind: 'waiting' } : { kind: 'saved', at: state.uploadedAt };
}

/**
 * What the relay holds: the device's snapshot (`deviceSnapshot`, the one
 * place a snapshot is gathered) without the backup key, so the relay backup
 * carries whatever a backup file does, and never its own key.
 */
async function relayCopy(services: RelayBackupServices): Promise<Snapshot> {
  const copy: { -readonly [K in keyof Snapshot]: Snapshot[K] } = {
    ...(await deviceSnapshot(services.store)),
  };
  delete copy.backupKey;
  return copy;
}

/** The relay's UTC day by the latest `relayNow` among the copy's groups, or null before any synced. */
function relayDayOf({ groups }: Snapshot): number | null {
  const latest = Math.max(...groups.map((group) => group.relayNow ?? -1));
  return latest < 0 ? null : Math.floor(latest / DAY_MINUTES);
}

/**
 * The SHA-256, in hex, of what an upload would hold, leaving out each
 * group's `relayNow` and `lastSyncAt`, which every sync pass moves, so a day
 * with no change has the same digest as the day before.
 */
function digestOf(copy: Snapshot): string {
  const groups = copy.groups.map((group) => ({ ...group, relayNow: null, lastSyncAt: null }));
  const digest = sha256(encodeSnapshot({ ...copy, groups }));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Seals the groups for `key` and PUTs them, then records the upload, unless
 * the key changed meanwhile. Too large, it records that and keeps the last
 * good backup; a failed PUT records nothing, so the next pass tries again.
 */
async function upload(
  services: RelayBackupServices,
  key: Uint8Array,
  copy: Snapshot,
): Promise<void> {
  const { store } = services;
  const day = relayDayOf(copy);
  const plaintext = encodeSnapshot(copy);
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = sealRelayBackup(key, plaintext);
  } catch (error) {
    if (!(error instanceof RelayBackupTooLarge)) throw error;
    await store.updateRelayBackup(key, { tooLarge: true, checkedDay: day });
    return;
  } finally {
    plaintext.fill(0);
  }
  const sent = await services.relay.putBackup(backupIdFor(key), blob).then(
    () => true,
    () => false,
  );
  if (!sent) return;
  await store.updateRelayBackup(key, {
    digest: digestOf(copy),
    checkedDay: day,
    uploadedAt: services.now(),
    tooLarge: false,
  });
}
