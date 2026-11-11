/**
 * The new device's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0008, ADR-0075 §4): someone who has lost every device gets all their
 * groups back.
 *
 * 1. **Start.** {@link startRecovery} makes a 16-byte seed and an X25519
 *    key, keeps both in the store's device record, and shows the code and
 *    its six-digit check (`crypto/recovery.ts`). The same request comes back
 *    after a restart, until a backup opens or the person stops.
 * 2. **Wait.** The person sends the code to their contacts, calls each and
 *    reads them the number. Each contact's device holds its share for 72
 *    hours of relay time (`holder.ts`), while the person's other devices,
 *    if any, can cancel (`alert.ts`).
 * 3. **Collect.** {@link recoverSession}'s poll reads the request mailbox,
 *    opens each blob's Seal under the seed's key and then its box with the
 *    secret key, and keeps every well-shaped share.
 * 4. **Combine.** Shares are grouped by split (and threshold), and only a
 *    split's own shares are ever combined: shares from different splits
 *    rebuild a wrong key, or worse, never the right one. Once a split has
 *    `t`, each `t`-subset is tried in the order the shares came, at most
 *    {@link MAX_SUBSETS} in all, so a corrupted share costs a few tries,
 *    not a lockout. The library checks nothing it rebuilds, so a subset
 *    counts only once `fetchRelayBackup` opens the backup its key names.
 * 5. **Restore.** Only then is anything written: the backup's groups and
 *    personal Documents (`importSnapshot`, from the relay, so no group is
 *    marked as in a backup file), the backup key (`adoptRelayBackupKey`),
 *    and the mark that this device was recovered, which takes the request's
 *    place. The app then asks the person to choose contacts again, which
 *    makes a new key and retires this one.
 *
 * No request carries the seed, the secret key, a share or the backup key:
 * the relay sees the mailbox id, the padded blobs and the backup id the key
 * names. The seed and secret key stay on the device record, outside the
 * vault (#95), from start to restore.
 */
import { BackupUnreadable } from '../crypto/backup';
import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import {
  newRecoveryKeys,
  openRelease,
  recoveryChannel,
  recoveryCheck,
  recoveryCode,
} from '../crypto/recovery';
import type { Seal } from '../crypto/seal';
import { combineShares, type RecoveryShare } from '../crypto/shares';
import type { Relay, RelayRecord } from '../net/relay';
import type { RecoverRequest, Store } from '../store/db';
import { fetchRelayBackup } from '../store/relayBackup';
import { importSnapshot } from '../store/snapshot';

/** The most subsets a device tries to rebuild the key from: every 3-of-7 or 4-of-7 choice. */
export const MAX_SUBSETS = 35;

/** What recovering works with. */
export interface RecoverServices {
  readonly store: Pick<
    Store,
    | 'getRecoverRequest'
    | 'keepRecoverRequest'
    | 'dropRecoverRequest'
    | 'finishRecovery'
    | 'restoreGroups'
    | 'adoptRelayBackupKey'
  >;
  readonly relay: Pick<Relay, 'getBlobs' | 'getBackup'>;
  readonly seal: Seal;
  /** The device clock in milliseconds. */
  readonly now: () => number;
}

/** What the new device shows: the code to send, and the number to read out. */
export interface ShownRequest {
  readonly code: string;
  readonly check: string;
}

/** Where recovering has got to. */
export type RecoverStep =
  /** Waiting: the most shares of one split that have come, and how many that split needs. */
  | { readonly kind: 'waiting'; readonly shares: number; readonly needed: number | null }
  /** A backup opened and its groups are on this device. */
  | { readonly kind: 'restored'; readonly groups: number }
  /** There is no request on this device: it stopped, or another tab finished it. */
  | { readonly kind: 'stopped' };

/** A recovery in progress on this device's screen: each poll reads the mailbox once. */
export interface RecoverSession {
  readonly poll: () => Promise<RecoverStep>;
}

/** The code and check for a kept request. */
function shown({ seed, secretKey }: RecoverRequest): ShownRequest {
  const code = recoveryCode({ seed, publicKey: kxPublicKeyOf(secretKey) });
  return { code, check: recoveryCheck(code) };
}

/**
 * The request this device keeps, or a new one, kept: its code and check.
 * Each call while one is kept shows the same code.
 */
export async function startRecovery(services: RecoverServices): Promise<ShownRequest> {
  const held = await services.store.getRecoverRequest();
  if (held !== undefined) return shown(held);
  const { seed, secretKey } = newRecoveryKeys();
  // Two starts at once, as StrictMode makes them, both show the one the store kept.
  const kept = await services.store.keepRecoverRequest({
    seed,
    secretKey,
    startedAt: services.now(),
  });
  if (kept.seed !== seed) {
    seed.fill(0);
    secretKey.fill(0);
  }
  return shown(kept);
}

/** Stop recovering: forget the seed and key, so nothing sent to the old code is ever read. */
export function stopRecovery(services: Pick<RecoverServices, 'store'>): Promise<void> {
  return services.store.dropRecoverRequest();
}

/** The shares in the request mailbox's `records`, each once, in the order they came. */
function sharesIn(
  { seal }: Pick<RecoverServices, 'seal'>,
  request: RecoverRequest,
  records: readonly RelayRecord[],
): RecoveryShare[] {
  const { mailbox, key } = recoveryChannel(request.seed);
  const seen = new Set<string>();
  const shares: RecoveryShare[] = [];
  for (const record of records) {
    const box = seal.open(mailbox, key, record.data);
    const share = box === null ? null : openRelease(request.secretKey, mailbox, box);
    const id = share === null ? '' : `${share.split} ${base64url(share.share)}`;
    if (share === null || seen.has(id)) continue;
    seen.add(id);
    shares.push(share);
  }
  key.fill(0);
  return shares;
}

/** `shares` by split and threshold, each set in the order its shares came. */
function bySplit(shares: readonly RecoveryShare[]): RecoveryShare[][] {
  const sets = new Map<string, RecoveryShare[]>();
  for (const share of shares) {
    const key = `${share.split} ${String(share.t)}`;
    sets.set(key, [...(sets.get(key) ?? []), share]);
  }
  return [...sets.values()];
}

/** Every `size`-subset of `items`, in order: the first item's subsets first. */
function* subsets<T>(items: readonly T[], size: number, from = 0): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let at = from; at <= items.length - size; at += 1) {
    const head = items.slice(at, at + 1);
    for (const rest of subsets(items, size - 1, at + 1)) yield [...head, ...rest];
  }
}

/** A subset's name among those tried: its split and its shares. */
function subsetKey(subset: readonly RecoveryShare[]): string {
  return subset.map(({ split, share }) => `${split} ${base64url(share)}`).join(' ');
}

/**
 * The groups restored from the backup `key` names, or null when it doesn't
 * open or its contents don't check out; nothing is written then.
 *
 * @throws {RelayError | TypeError} when the relay can't be reached.
 */
async function restoreWith(services: RecoverServices, key: Uint8Array): Promise<number | null> {
  const plaintext = await fetchRelayBackup(services.relay, key);
  if (plaintext === null) return null;
  try {
    const groups = await importSnapshot(services.store, plaintext, 'relay');
    await services.store.adoptRelayBackupKey(key);
    await services.store.finishRecovery(services.now());
    return groups;
  } catch (error) {
    if (error instanceof BackupUnreadable) return null;
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

/** The key `subset` rebuilds and the groups it restores, or null when it rebuilds no backup. */
async function trySubset(
  services: RecoverServices,
  subset: readonly RecoveryShare[],
): Promise<number | null> {
  const key = await combineShares(subset.map(({ share }) => share));
  if (key === null) return null;
  try {
    return await restoreWith(services, key);
  } finally {
    key.fill(0);
  }
}

/** What a waiting device has: the most shares of one split, and that split's threshold. */
function waiting(sets: readonly RecoveryShare[][]): RecoverStep {
  const largest = sets.reduce<RecoveryShare[]>(
    (most, set) => (set.length > most.length ? set : most),
    [],
  );
  return { kind: 'waiting', shares: largest.length, needed: largest[0]?.t ?? null };
}

/**
 * A recovery on this device's screen: each poll reads the request mailbox
 * once, and tries each new subset of a split with enough shares until one
 * restores a backup or {@link MAX_SUBSETS} have been tried. A poll while one
 * is on its way shares its answer.
 */
export function recoverSession(services: RecoverServices): RecoverSession {
  const tried = new Set<string>();

  /** The groups the first untried subset to open a backup restored, or null. */
  const combine = async (sets: readonly RecoveryShare[][]): Promise<number | null> => {
    for (const set of sets) {
      const t = set[0]?.t ?? 0;
      if (set.length < t) continue;
      for (const subset of subsets(set, t)) {
        const key = subsetKey(subset);
        if (tried.size >= MAX_SUBSETS) return null;
        if (tried.has(key)) continue;
        const groups = await trySubset(services, subset);
        tried.add(key);
        if (groups !== null) return groups;
      }
    }
    return null;
  };

  const look = async (): Promise<RecoverStep> => {
    const request = await services.store.getRecoverRequest();
    if (request === undefined) return { kind: 'stopped' };
    const { mailbox } = recoveryChannel(request.seed);
    const page = await services.relay.getBlobs(mailbox, 0);
    const shares = sharesIn(services, request, page.records);
    const sets = bySplit(shares);
    try {
      const groups = await combine(sets);
      return groups === null ? waiting(sets) : { kind: 'restored', groups };
    } finally {
      for (const { share } of shares) share.fill(0);
    }
  };

  let running: Promise<RecoverStep> | null = null;
  return {
    poll: () => {
      running ??= look().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
