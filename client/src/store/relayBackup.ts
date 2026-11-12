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
 *   (`crypto/relayBackup.ts`), written at most once a relay day by each
 *   device that keeps the key, and read once before each write, and the
 *   connecting IP, which it doesn't keep. Uploads come from the same address
 *   as the device's group syncs, so someone watching the relay live can tie
 *   the backup to those groups (ADR-0075 §2).
 * - **Linked devices (#247).** A phone and a laptop linked by #96 share the
 *   key, so they keep one relay copy, but each keeps its own personal
 *   Documents (#93). So before each upload a device reads the relay copy,
 *   opens it, and merges its personal Documents into its own
 *   ({@link mergePersonal}): by id, the later edit winning as a restore's
 *   does, so neither device's upload drops what only the other holds. Its
 *   groups are the device's own, as before: both hold the same signed logs.
 *   A read that fails, or a blob that doesn't open under the key or holds no
 *   snapshot this device reads, leaves nothing to merge, and the device
 *   uploads its own copy as before. The state notes every Document id this
 *   device has uploaded (`uploaded`), so one it deleted leaves the copy.
 * - **The schedule.** Once a key exists, after the first sync pass of each
 *   UTC day by relay time in which every group synced, the device reads the
 *   relay copy and uploads if what it would upload has changed since its
 *   last upload, the relay holds nothing under the id, or the relay copy's
 *   personal Documents aren't the merge's: never on every change. The relay
 *   day is the latest `relayNow` among the device's groups, so with no
 *   synced group there is no day and nothing is scheduled. A failed upload
 *   tries again after the next complete pass.
 * - **Key changes (#98).** The refresh runs after the pass's key changes, so
 *   its copy holds each group at the epoch it moved to. While any group
 *   still has a key change due that this device should write (`hasDuty`),
 *   nothing is read or uploaded, not even by `startRelayBackup`, and the day
 *   stays unchecked: the next complete pass, once the change has landed,
 *   uploads. So the relay never holds a copy taken mid-change, whose groups
 *   would come back on the secret the member who left still holds, until a
 *   sync after the restore found the change. A group this device can't move
 *   on from, as when it missed the new key, doesn't hold the backup up.
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
import { mayStillOpen } from '../share/shareLink';
import type { RelayBackupState, Store } from './db';
import { hasDuty } from './epochs';
import { foldGroup } from './expiry';
import { byCreation, keepsHeldCopy, keptShare, type PersonalDocument, textOf } from './personal';
import { decodePersonal, deviceSnapshot, encodeSnapshot, type Snapshot } from './snapshot';

/** Minutes in a UTC day: a relay minute's day is ⌊minute / 1,440⌋. */
const DAY_MINUTES = 1440;

/** What the relay backup works with: `AppServices` has all three. */
export interface RelayBackupServices {
  /** What `deviceSnapshot` reads, and the relay backup's own record. */
  readonly store: Parameters<typeof deviceSnapshot>[0] &
    Pick<Store, 'getRelayBackup' | 'setRelayBackupKey' | 'updateRelayBackup'>;
  /** The relay's backup routes: a GET before each upload (#247), then the PUT. */
  readonly relay: Pick<Relay, 'putBackup' | 'getBackup'>;
  /** The device clock in milliseconds: when an upload succeeded, and whether a share's link may still open. */
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

/** What an upload needs of the relay backup's state: its key, and the Documents it uploaded before. */
type Uploader = Pick<RelayBackupState, 'key' | 'uploaded'>;

/**
 * What the relay held under the backup's id when the device read it before
 * an upload (#247): a copy the key opens, read for its personal Documents
 * alone; nothing, its 404; or a copy the device can't read, which leaves it
 * uploading its own as before.
 */
type OnRelay =
  | { readonly kind: 'copy'; readonly personal: readonly PersonalDocument[] }
  | { readonly kind: 'none' | 'unreadable' };

const NOTHING: OnRelay = { kind: 'none' };
const UNREADABLE: OnRelay = { kind: 'unreadable' };

/** What one upload holds, and the ids of this device's own personal Documents in it. */
interface Planned {
  readonly copy: Snapshot;
  readonly mine: readonly string[];
}

/** What the merge needs besides the two lists (#247). */
export interface MergeContext {
  /** Every Document id this device held at an upload: one only the relay copy now holds, it deleted. */
  readonly uploaded: ReadonlySet<string>;
  /** The device clock in milliseconds, for whether a share's link may still open. */
  readonly now: number;
}

/**
 * Makes a backup key when the device has none or `newKey` is set, keeps it
 * device-wide, and uploads at once, unless a key change is due (#98), when
 * the next complete sync pass uploads instead. With the key it already
 * keeps, it reads the relay copy and merges it first, as the refresh does
 * (#247); a new key names an id that holds nothing yet, so nothing is read.
 * Returns the id the replaced key named, or null when no key was replaced.
 * An upload that fails, offline say, leaves the key kept and the status
 * waiting, and the schedule tries again after the next complete sync pass;
 * one over 16 MiB leaves the status too large.
 */
export async function startRelayBackup(
  services: RelayBackupServices,
  { newKey = false }: StartOptions = {},
): Promise<string | null> {
  const held = await services.store.getRelayBackup();
  if (held !== undefined && !newKey) {
    await uploadUnlessChanging(services, held, true);
    return null;
  }
  const key = newBackupKey();
  const replaced = await services.store.setRelayBackupKey(key);
  await uploadUnlessChanging(services, { key, uploaded: [] }, false);
  key.fill(0);
  return replaced === undefined ? null : backupIdFor(replaced.key);
}

/**
 * Uploads the relay copy under `state`'s key now, merged with what the relay
 * holds when `read` is set, unless a key change is due (`keyChangeDue`).
 */
async function uploadUnlessChanging(
  services: RelayBackupServices,
  state: Uploader,
  read: boolean,
): Promise<void> {
  if (await keyChangeDue(services.store)) return;
  const own = await relayCopy(services);
  const onRelay = read ? await readRelay(services.relay, state.key) : NOTHING;
  await upload(services, state, merged(own, onRelay, state, services.now()));
}

/**
 * Whether any group on the device has a key change due that this device
 * should write (#98, `hasDuty`): one the next sync pass will make, so a copy
 * now would hold the secret it replaces.
 */
async function keyChangeDue(store: Pick<Store, 'listGroups'>): Promise<boolean> {
  const groups = await store.listGroups();
  return groups.some((group) => hasDuty(group, foldGroup(group)));
}

/**
 * The daily refresh, run after every sync pass in which every group synced:
 * the first such pass of each relay day reads the relay copy, merges it
 * (#247), and uploads if anything changed since the last upload or the relay
 * doesn't hold what this device would upload, and every later pass that day
 * does nothing. A pass with a key change still due (#98) does nothing and
 * checks no day.
 */
export async function refreshRelayBackup(services: RelayBackupServices): Promise<void> {
  const state = await services.store.getRelayBackup();
  // Mid key change (#98), the day stays unchecked, so the pass after it lands uploads.
  if (state === undefined || (await keyChangeDue(services.store))) return;
  const own = await relayCopy(services);
  const day = relayDayOf(own);
  if (day === null || (state.checkedDay !== null && day <= state.checkedDay)) return;
  const onRelay = await readRelay(services.relay, state.key);
  const planned = merged(own, onRelay, state, services.now());
  const digest = digestOf(planned.copy);
  if (digest === state.digest && holdsAlready(onRelay, planned.copy)) {
    await services.store.updateRelayBackup(state.key, { checkedDay: day });
    return;
  }
  await upload(services, state, planned, digest);
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

/**
 * What the relay holds under `key`'s id (#247): its personal Documents when
 * the blob opens under `key` and holds a snapshot this device reads, which
 * it zeroes once read; nothing for a 404; and unreadable when the relay
 * can't be reached or refuses, or the blob doesn't open or read.
 */
async function readRelay(relay: Pick<Relay, 'getBackup'>, key: Uint8Array): Promise<OnRelay> {
  const blob = await relay.getBackup(backupIdFor(key)).catch(() => undefined);
  if (blob === null) return NOTHING;
  const plaintext = blob === undefined ? null : openRelayBackup(key, blob);
  if (plaintext === null) return UNREADABLE;
  const personal = decodePersonal(plaintext);
  plaintext.fill(0);
  return personal === null ? UNREADABLE : { kind: 'copy', personal };
}

/**
 * What to upload (#247): this device's own copy, with the relay copy's
 * personal Documents merged in when the device could read it. A state from
 * before #247 never noted what it uploaded, so it takes the relay copy's
 * Documents as its own: one it deleted meanwhile stays out.
 */
function merged(own: Snapshot, onRelay: OnRelay, state: Uploader, now: number): Planned {
  const mine = own.personal.map((document) => document.id);
  if (onRelay.kind !== 'copy') return { copy: own, mine };
  const uploaded = new Set(state.uploaded ?? onRelay.personal.map((document) => document.id));
  return {
    copy: { ...own, personal: mergePersonal(own.personal, onRelay.personal, { uploaded, now }) },
    mine,
  };
}

/**
 * Whether the relay already holds what an upload of `copy` would, as far as
 * the digest can't tell (#247): it does unless it holds nothing, or a copy
 * whose personal Documents aren't `copy`'s, as when a linked device wrote
 * its own. One this device can't read counts as held, as before #247, so
 * only a change here uploads over it.
 */
function holdsAlready(onRelay: OnRelay, copy: Snapshot): boolean {
  if (onRelay.kind !== 'copy') return onRelay.kind === 'unreadable';
  return personalDigest(onRelay.personal) === personalDigest(copy.personal);
}

/**
 * The personal Documents to upload when this device holds `own` and the
 * relay copy `relay` (#247), oldest first:
 *
 * - one only this device holds goes as it is;
 * - one only the relay copy holds goes as it is, unless this device has
 *   uploaded it before (`uploaded`), so deleted it;
 * - one both hold takes the later edit, a tie keeping this device's, as a
 *   restore does (`keepsHeldCopy`), with this device's share by link (#105)
 *   if it has one, else the relay copy's while its link may still open
 *   (`mayStillOpen`), each marked pending when the words it carries changed
 *   (`keptShare`), as a restore marks one (`restoredCopy`).
 *
 * A share in the relay copy on a Document this device holds unshared may be
 * a linked device's live link, which a restore must bring back so it can be
 * stopped, or one this device stopped. Once its link can no longer open,
 * nothing is lost by leaving it out; until then, a device restored from the
 * copy gets it back paused (#328, `restoredCopy`), so nothing posts to it,
 * even once its tombstone has lapsed, unless the person keeps it.
 */
export function mergePersonal(
  own: readonly PersonalDocument[],
  relay: readonly PersonalDocument[],
  { uploaded, now }: MergeContext,
): PersonalDocument[] {
  const held = new Map(own.map((document) => [document.id, document]));
  const kept = new Map(held);
  for (const theirs of relay) {
    const mine = held.get(theirs.id);
    if (mine !== undefined) kept.set(theirs.id, unionCopy(mine, theirs, now));
    else if (!uploaded.has(theirs.id)) kept.set(theirs.id, theirs);
  }
  return [...kept.values()].sort(byCreation);
}

/** One Document both copies hold, as {@link mergePersonal} keeps it. */
function unionCopy(
  mine: PersonalDocument,
  theirs: PersonalDocument,
  now: number,
): PersonalDocument {
  const words = textOf(keepsHeldCopy(mine, theirs) ? mine : theirs);
  const live = theirs.share !== undefined && mayStillOpen(theirs.share, now);
  const share = keptShare(mine.share === undefined && live ? theirs : mine, words);
  return share === undefined ? words : { ...words, share };
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

/** The SHA-256 of `bytes`, in hex. */
function hexDigest(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The SHA-256, in hex, of what an upload would hold, leaving out each
 * group's `relayNow` and `lastSyncAt`, which every sync pass moves, so a day
 * with no change has the same digest as the day before.
 */
function digestOf(copy: Snapshot): string {
  const groups = copy.groups.map((group) => ({ ...group, relayNow: null, lastSyncAt: null }));
  return hexDigest(encodeSnapshot({ ...copy, groups }));
}

/**
 * The SHA-256, in hex, of `personal` as a snapshot holds it. Every copy
 * lists them oldest first (`listPersonal`, {@link mergePersonal}), so two
 * lists of the same Documents hash alike.
 */
function personalDigest(personal: readonly PersonalDocument[]): string {
  return hexDigest(encodeSnapshot({ groups: [], personal }));
}

/**
 * Seals `planned`'s copy for `state`'s key and PUTs it, then records the
 * upload, its `digest` (`digestOf(copy)`, unless the caller has it already)
 * and the ids of this device's Documents it held (#247), unless the key
 * changed meanwhile. Too large, it records that and keeps the last good
 * backup; a failed PUT records nothing, so the next pass tries again.
 */
async function upload(
  services: RelayBackupServices,
  { key, uploaded }: Uploader,
  { copy, mine }: Planned,
  digest?: string,
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
    digest: digest ?? digestOf(copy),
    checkedDay: day,
    uploadedAt: services.now(),
    tooLarge: false,
    uploaded: [...new Set([...(uploaded ?? []), ...mine])].sort(),
  });
}
