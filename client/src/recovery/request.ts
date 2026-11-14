/**
 * The new device's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0008, ADR-0075 §4): someone who has lost every device gets all their
 * groups back.
 *
 * 1. **Start.** {@link startRecovery} makes a 16-byte seed and an X25519
 *    key, keeps both in the store's device record, and shows the code, its
 *    six-digit check and the second number (#398), which comes from the
 *    secret key, never from the code (`crypto/recovery.ts`). The same
 *    request comes back after a restart, until a backup opens and the person
 *    confirms it, or they stop.
 * 2. **Wait.** The person sends the code to their contacts, calls each and
 *    reads them the number. Each contact's device holds its share for 72
 *    hours of relay time (`holder.ts`), while the person's other devices,
 *    if any, can cancel (`alert.ts`).
 * 3. **Collect.** {@link recoverSession}'s poll reads the request mailbox,
 *    opens each blob's Seal under the seed's key and then its box with the
 *    secret key, and keeps every well-shaped share whose release carries this
 *    request's second number (#398). One that carries another number is left
 *    out and counted, so the screen can say a contact typed it wrong; nothing
 *    left out reaches the combine, so someone who holds only the code can't
 *    use up its tries or have their own backup restored.
 * 4. **Combine.** Shares are grouped by split (and threshold), and only a
 *    split's own shares are ever combined: shares from different splits
 *    rebuild a wrong key, or worse, never the right one. Once a split has
 *    `t`, each `t`-subset is tried in the order the shares came, at most
 *    {@link MAX_SUBSETS} in all, so a corrupted share costs a few tries,
 *    not a lockout. The library checks nothing it rebuilds, so a subset
 *    counts only once `fetchRelayBackup` opens the backup its key names.
 * 5. **Confirm** (#398). Nothing is written yet: the poll answers `found`
 *    with the names of the backup's groups, and waits for the person. No
 *    ({@link RecoverSession.decline}) forgets that backup, never opens it
 *    again this session, and keeps the request, so their real contacts'
 *    shares can still bring them back. Yes ({@link RecoverSession.confirm})
 *    restores it.
 * 6. **Restore.** Only then is anything written: the backup's groups and
 *    personal Documents (`importSnapshot`, from the relay, so no group is
 *    marked as in a backup file), less any group entry (#336) or personal
 *    Document (#351) that doesn't check out, which it counts, the backup key
 *    (`adoptRelayBackupKey`), and the mark that this device was recovered,
 *    which takes the request's place. The app then asks the person to choose
 *    contacts again, which makes a new key and retires this one.
 *
 * No request carries the seed, the secret key, a share or the backup key:
 * the relay sees the mailbox id, the padded blobs and the backup id the key
 * names. The seed and secret key stay on the device record from start to
 * restore, sealed in the passkey vault on a device that has one (#95), which
 * a new device may make at the offer after the pilot notice or during the
 * wait (`store/recoverRequest.ts`).
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
  recoveryNumber,
} from '../crypto/recovery';
import type { Seal } from '../crypto/seal';
import { combineShares, type RecoveryShare } from '../crypto/shares';
import type { Relay, RelayRecord } from '../net/relay';
import type { RecoverRequest, Store } from '../store/db';
import { backupIdFor } from '../crypto/relayBackup';
import { foldGroup } from '../store/expiry';
import { fetchRelayBackup } from '../store/relayBackup';
import { decodeSnapshot, importSnapshot, type Restored } from '../store/snapshot';

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

/** What the new device shows: the code to send, and the two numbers to read out. */
export interface ShownRequest {
  readonly code: string;
  readonly check: string;
  /** The second number (#398), from the request's secret key: never from the code. */
  readonly number: string;
}

/** Where recovering has got to. */
export type RecoverStep =
  /**
   * Waiting: the most shares of one split that have come, how many that split
   * needs, and how many releases came with a second number that isn't this
   * request's (#398), which count for nothing.
   */
  | {
      readonly kind: 'waiting';
      readonly shares: number;
      readonly needed: number | null;
      readonly mismatched: number;
    }
  /**
   * A backup opened (#398): the names of the groups it holds, for the person
   * to confirm before anything is written.
   */
  | { readonly kind: 'found'; readonly groups: readonly string[] }
  /**
   * A backup opened and its groups are on this device: how many came back,
   * and how many group entries (#336) and personal Documents (#351) were left
   * out because they didn't check out. The screen says none of it: it shows
   * no count, and the person's groups are back either way.
   */
  | ({ readonly kind: 'restored' } & Restored)
  /** There is no request on this device: it stopped, or another tab finished it. */
  | { readonly kind: 'stopped' };

/** A recovery in progress on this device's screen: each poll reads the mailbox once. */
export interface RecoverSession {
  readonly poll: () => Promise<RecoverStep>;
  /** Yes, these are my groups (#398): restores the backup found, and ends the recovery. */
  readonly confirm: () => Promise<RecoverStep>;
  /**
   * No, they aren't (#398): forgets the backup found, opens it no more this
   * session, and keeps the request.
   */
  readonly decline: () => void;
}

/** The code, check and second number for a kept request. */
function shown({ seed, secretKey }: RecoverRequest): ShownRequest {
  const code = recoveryCode({ seed, publicKey: kxPublicKeyOf(secretKey) });
  return { code, check: recoveryCheck(code), number: recoveryNumber(secretKey) };
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

/** What the request mailbox held: each share with this request's second number, and how many came with another. */
interface Collected {
  readonly shares: RecoveryShare[];
  readonly mismatched: number;
}

/**
 * The shares in the request mailbox's `records` whose release carries this
 * request's second number, each once, in the order they came (#398), and how
 * many opened with another number. Nothing else reaches a split.
 */
function sharesIn(
  { seal }: Pick<RecoverServices, 'seal'>,
  request: RecoverRequest,
  records: readonly RelayRecord[],
): Collected {
  const { mailbox, key } = recoveryChannel(request.seed);
  const number = recoveryNumber(request.secretKey);
  const seen = new Set<string>();
  const shares: RecoveryShare[] = [];
  let mismatched = 0;
  for (const record of records) {
    const box = seal.open(mailbox, key, record.data);
    const release = box === null ? null : openRelease(request.secretKey, mailbox, box);
    if (release === null) continue;
    const { share } = release;
    const id = `${share.split} ${base64url(share.share)}`;
    if (release.number !== number) mismatched += 1;
    if (release.number !== number || seen.has(id)) {
      share.share.fill(0);
      continue;
    }
    seen.add(id);
    shares.push(share);
  }
  key.fill(0);
  return { shares, mismatched };
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

/** A backup a subset's key opened, held for the person to confirm (#398): nothing is written yet. */
interface Found {
  readonly key: Uint8Array;
  /** The backup id the key names, so a declined one isn't opened again. */
  readonly id: string;
  /** The split the shares that rebuilt it came from (#272). */
  readonly split: string;
  readonly plaintext: Uint8Array;
  /** The name of each group it holds, in its order. */
  readonly groups: readonly string[];
}

/** Zeroes what `found` holds. */
function forget(found: Found): void {
  found.key.fill(0);
  found.plaintext.fill(0);
}

/**
 * The backup the `key` names, opened and read but not kept, or null when it
 * doesn't open or anything in it but a group entry (#336) or a personal
 * Document (#351) doesn't check out. Its groups are named as their own logs
 * fold, coalitions and rooms left out.
 *
 * @throws {RelayError | TypeError} when the relay can't be reached.
 */
async function findWith(
  services: RecoverServices,
  key: Uint8Array,
  split: string,
): Promise<Found | null> {
  const plaintext = await fetchRelayBackup(services.relay, key);
  if (plaintext === null) return null;
  const decoded = decodeSnapshot(plaintext);
  if (decoded === null) {
    plaintext.fill(0);
    return null;
  }
  const groups = decoded.groups
    .filter((group) => group.kind === undefined)
    .map((group) => foldGroup(group).name);
  return { key: Uint8Array.from(key), id: backupIdFor(key), split, plaintext, groups };
}

/**
 * What restoring `found` brought back, once the person has confirmed it:
 * its groups and personal Documents (`importSnapshot`, from the relay), less
 * any group entry (#336) or personal Document (#351) that doesn't check out,
 * which it counts, then the key with its split (#272), and the mark that
 * this device was recovered, which takes the request's place. Null when it
 * no longer reads.
 */
async function restoreFound(services: RecoverServices, found: Found): Promise<Restored | null> {
  try {
    const restored = await importSnapshot(services.store, found.plaintext, 'relay');
    await services.store.adoptRelayBackupKey(found.key, found.split);
    await services.store.finishRecovery(services.now());
    return restored;
  } catch (error) {
    if (error instanceof BackupUnreadable) return null;
    throw error;
  }
}

/**
 * The backup the key `subset` rebuilds, found and not kept, or null when it
 * rebuilds no backup or one the person has `declined` (#398), which isn't
 * fetched again.
 */
async function trySubset(
  services: RecoverServices,
  subset: readonly RecoveryShare[],
  declined: ReadonlySet<string>,
): Promise<Found | null> {
  const [first] = subset;
  if (first === undefined) return null;
  const key = await combineShares(subset.map(({ share }) => share));
  if (key === null) return null;
  try {
    return declined.has(backupIdFor(key)) ? null : await findWith(services, key, first.split);
  } finally {
    key.fill(0);
  }
}

/**
 * What a waiting device has: the most shares of one split, that split's
 * threshold, and how many releases came with another second number (#398).
 */
function waiting(sets: readonly RecoveryShare[][], mismatched: number): RecoverStep {
  const largest = sets.reduce<RecoveryShare[]>(
    (most, set) => (set.length > most.length ? set : most),
    [],
  );
  return { kind: 'waiting', shares: largest.length, needed: largest[0]?.t ?? null, mismatched };
}

/**
 * A recovery on this device's screen: each poll reads the request mailbox
 * once, and tries each new subset of a split with enough shares until one
 * opens a backup or {@link MAX_SUBSETS} have been tried. A backup that opens
 * is held, unwritten, for the person to confirm (#398): until they answer,
 * each poll answers `found` again without reading the relay. A poll while
 * one is on its way shares its answer.
 */
export function recoverSession(services: RecoverServices): RecoverSession {
  const tried = new Set<string>();
  /** The ids of the backups the person said weren't theirs (#398). */
  const declined = new Set<string>();
  let found: Found | null = null;

  /** The first untried subset's backup to open, found and not kept, or null. */
  const combine = async (sets: readonly RecoveryShare[][]): Promise<Found | null> => {
    for (const set of sets) {
      const t = set[0]?.t ?? 0;
      if (set.length < t) continue;
      for (const subset of subsets(set, t)) {
        const key = subsetKey(subset);
        if (tried.size >= MAX_SUBSETS) return null;
        if (tried.has(key)) continue;
        const opened = await trySubset(services, subset, declined);
        tried.add(key);
        if (opened !== null) return opened;
      }
    }
    return null;
  };

  /** Forgets the backup held for the person, if any. */
  const drop = (): void => {
    if (found !== null) forget(found);
    found = null;
  };

  const look = async (): Promise<RecoverStep> => {
    const request = await services.store.getRecoverRequest();
    if (request === undefined) {
      drop();
      return { kind: 'stopped' };
    }
    if (found !== null) return { kind: 'found', groups: found.groups };
    const { mailbox } = recoveryChannel(request.seed);
    const page = await services.relay.getBlobs(mailbox, 0);
    const { shares, mismatched } = sharesIn(services, request, page.records);
    const sets = bySplit(shares);
    try {
      found = await combine(sets);
      return found === null ? waiting(sets, mismatched) : { kind: 'found', groups: found.groups };
    } finally {
      for (const { share } of shares) share.fill(0);
    }
  };

  let running: Promise<RecoverStep> | null = null;
  const poll = (): Promise<RecoverStep> => {
    running ??= look().finally(() => {
      running = null;
    });
    return running;
  };

  const confirm = async (): Promise<RecoverStep> => {
    const held = found;
    if (held === null) return poll();
    if ((await services.store.getRecoverRequest()) === undefined) {
      drop();
      return { kind: 'stopped' };
    }
    try {
      const restored = await restoreFound(services, held);
      if (restored !== null) return { kind: 'restored', ...restored };
      declined.add(held.id);
    } finally {
      if (found === held) drop();
    }
    return poll();
  };

  const decline = (): void => {
    if (found !== null) declined.add(found.id);
    drop();
  };

  return { poll, confirm, decline };
}
