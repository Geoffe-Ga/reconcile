/**
 * Linking a second device (#96; spec §3 "Second device", §7; ADR-0044 as cut
 * by ADR-0074): both sides of the handshake and the transfer, over the relay.
 *
 * 1. **The existing device (A)** makes a seed and a one-time X25519 key and
 *    shows the code (`crypto/link.ts`). It lasts 10 minutes, or until the
 *    screen closes.
 * 2. **The new device (B)** reads the code and posts a fresh key `E_B` to the
 *    pairing mailbox.
 * 3. **A** takes the first `E_B` in relay order, ignores any others, and
 *    only then posts `E_A`. It never posts `E_A` before it holds an `E_B`, so
 *    nobody can pick their key after seeing A's.
 * 4. **B** takes the first `E_A` in relay order and stops unless its hash is
 *    the code's commitment, so nobody else can stand in for A.
 * 5. Both show the six-digit number. Only A can confirm: on Match it checks
 *    that this session holds the unlocked keys (`Store.requireUnlocked`,
 *    #95), then posts the bundle (`bundle.ts`) under K; on Don't match, or
 *    when it closes, it drops every secret and sends nothing under K. B
 *    checks the bundle and keeps its groups and personal Documents
 *    (`importSnapshot`, as from a link), and the relay backup key (#97) if it
 *    has none, through the store's one key-writing path, so a B whose keys
 *    are locked with a passkey seals them in its vault. A group entry that
 *    doesn't check out is left out, and B says how many (#336), as a restore
 *    does. Neither side carries a Document's share by link (#105): it stays
 *    on A alone.
 *
 * Every blob is sealed and padded, and every PUT uses `ttl_days=1`. Each
 * handshake message is a 1-byte tag (who posted it) and a 32-byte key. Each
 * side zeroes its seed, one-time secret key and K when it closes. A poll does
 * one round trip at most, and a poll while one is on its way shares its answer.
 */
import { BackupUnreadable } from '../crypto/backup';
import {
  type LinkChannel,
  type LinkCode,
  type LinkKeys,
  type LinkSecrets,
  linkCode,
  LinkRefused,
  linkSecrets,
  linkTranscript,
  matchesCommitment,
  newLinkKeys,
  newLinkSeed,
  pairingChannelOf,
  sharedSecret,
} from '../crypto/link';
import type { Seal } from '../crypto/seal';
import type { Relay, RelayRecord } from '../net/relay';
import type { Store } from '../store/db';
import { importSnapshot, type Restored, takeSnapshot } from '../store/snapshot';
import { openBundle, sealBundle } from './bundle';

/** How long the relay keeps every blob in a link: 1 day, rounded up to the end of the next UTC day. */
export const LINK_TTL_DAYS = 1;

/** How long a code works: 10 minutes, on each side. */
export const LINK_LIFETIME_MS = 10 * 60_000;

/** The tag on a handshake message the new device posts: its `E_B`. */
export const NEW_DEVICE = 0x01;

/** The tag on the handshake message the existing device posts: its `E_A`. */
export const EXISTING_DEVICE = 0x02;

/** A handshake message's length: the tag and a 32-byte key. */
const MESSAGE_BYTES = 33;

/** What a link runs on. */
export interface LinkServices {
  readonly relay: Relay;
  readonly seal: Seal;
  /**
   * A's groups, personal Documents and relay backup key (#97) go out of it,
   * once it says this session holds the unlocked keys (#95); B's come into
   * it, the key kept only if B has none, sealed in B's vault if B has one.
   */
  readonly store: Pick<
    Store,
    | 'listGroups'
    | 'listCoalitions'
    | 'listPersonal'
    | 'getRelayBackup'
    | 'requireUnlocked'
    | 'restoreGroups'
    | 'adoptRelayBackupKey'
  >;
  /** The device clock in milliseconds, for the 10 minutes. */
  readonly now: () => number;
}

/** Where the existing device has got to. */
export type OfferStep =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'compare'; readonly number: string }
  | { readonly kind: 'expired' | 'closed' };

/** The existing device's side of a link. */
export interface LinkOffer {
  /** The code to show, as a QR code and as text. */
  readonly code: string;
  /** When the code stops working, by the device clock. */
  readonly expiresAt: number;
  /** Looks once for the new device's key; once it has one, posts `E_A` and shows the number. */
  readonly poll: () => Promise<OfferStep>;
  /**
   * Match: posts the bundle under K, then closes. Resolves `expired` past the
   * 10 minutes, sending nothing.
   *
   * @throws {Error} before there is a number, once closed, or when a PUT
   *   fails, which closes the link too.
   * @throws {VaultLocked} when this session hasn't unlocked the device's
   *   keys (#95); it sends nothing, and closes the link.
   */
  readonly confirm: () => Promise<'sent' | 'expired'>;
  /** Don't match, or the screen closed: zeroes every secret, and sends nothing more. */
  readonly drop: () => void;
}

/** Where the new device has got to. */
export type JoinStep =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'compare'; readonly number: string }
  | {
      readonly kind: 'linked';
      readonly groups: number;
      readonly skipped: number;
      readonly skippedDocuments: number;
    }
  | { readonly kind: 'mismatch' | 'damaged' | 'expired' | 'closed' };

/** The new device's side of a link. It has no way to confirm: only the existing device can. */
export interface LinkJoin {
  /** Looks once for `E_A`, and then for the bundle; keeps the groups once it checks out. */
  readonly poll: () => Promise<JoinStep>;
  /** Cancel: zeroes every secret and reads nothing more. */
  readonly drop: () => void;
}

/** A side's status once it stops: any step but the open ones. */
type Ended<Step> = Exclude<Step, { readonly kind: 'waiting' | 'compare' }>;

/** Thrown by `confirm` once the link has closed. */
class LinkClosed extends Error {
  constructor() {
    super('This link is closed.');
    this.name = 'LinkClosed';
  }
}

/** Zeroes every one of `secrets`. */
function wipe(...secrets: readonly (Uint8Array | undefined)[]): void {
  for (const secret of secrets) secret?.fill(0);
}

/** The handshake message for `key`, posted under `tag`. */
function message(tag: number, key: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(MESSAGE_BYTES);
  bytes[0] = tag;
  bytes.set(key, 1);
  return bytes;
}

/** The key in an opened handshake message posted under `tag`, or null for anything else. */
function keyIn(plaintext: Uint8Array | null, tag: number): Uint8Array | null {
  if (plaintext?.length !== MESSAGE_BYTES || plaintext[0] !== tag) return null;
  return plaintext.slice(1);
}

/** Posts `key` under `tag` to the pairing mailbox. */
async function postKey(
  { relay, seal }: LinkServices,
  pairing: LinkChannel,
  tag: number,
  key: Uint8Array,
): Promise<void> {
  const blob = seal.seal(pairing.mailbox, pairing.key, message(tag, key));
  await relay.putBlob(pairing.mailbox, blob, LINK_TTL_DAYS);
}

/**
 * `run`, one call at a time: a call while one is on its way gets that one's
 * answer instead of starting another, so a screen polling twice at once (as
 * React's StrictMode does) never takes two keys or posts `E_A` twice.
 */
function oneAtATime<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}

/** The highest seq in `records`, or `after` when there are none. */
function lastSeq(records: readonly RelayRecord[], after: number): number {
  return records.at(-1)?.seq ?? after;
}

/**
 * Starts a link on the existing device: a fresh seed and one-time key, and
 * the code that carries them. Nothing goes to the relay until a poll finds
 * the new device's key. `keys` is for tests; the app always makes fresh ones.
 */
export function offerLink(services: LinkServices, keys: LinkKeys = newLinkKeys()): LinkOffer {
  const seed = newLinkSeed();
  const pairing = pairingChannelOf(seed);
  const expiresAt = services.now() + LINK_LIFETIME_MS;
  let ended: Ended<OfferStep> | null = null;
  let cursor = 0;
  let taken: LinkSecrets | null = null;
  let replied = false;

  const close = (kind: Ended<OfferStep>['kind']): void => {
    ended ??= { kind };
    wipe(seed, keys.secretKey, pairing.key, taken?.key);
  };
  const check = (): Ended<OfferStep> | null => {
    if (ended === null && services.now() >= expiresAt) close('expired');
    return ended;
  };

  /** The secrets for the first usable new device key in `records`, or null. */
  const firstNewDevice = (records: readonly RelayRecord[]): LinkSecrets | null => {
    for (const record of records) {
      const publicB = keyIn(
        services.seal.open(pairing.mailbox, pairing.key, record.data),
        NEW_DEVICE,
      );
      const shared = publicB === null ? null : sharedOrNull(keys.secretKey, publicB);
      if (publicB !== null && shared !== null) {
        return linkSecrets(shared, linkTranscript(seed, keys.publicKey, publicB));
      }
    }
    return null;
  };

  /** One GET of the pairing mailbox, taking the first new device key in it. */
  const lookForNewDevice = async (): Promise<void> => {
    const page = await services.relay.getBlobs(pairing.mailbox, cursor);
    if (ended !== null) return;
    cursor = lastSeq(page.records, cursor);
    taken = firstNewDevice(page.records);
  };

  const poll = oneAtATime(async (): Promise<OfferStep> => {
    if (check() === null && taken === null) await lookForNewDevice();
    const stop = check();
    if (stop !== null) return stop;
    if (taken === null) return { kind: 'waiting' };
    if (!replied) {
      await postKey(services, pairing, EXISTING_DEVICE, keys.publicKey);
      replied = true;
    }
    return check() ?? { kind: 'compare', number: taken.number };
  });

  const send = async (secrets: LinkSecrets): Promise<void> => {
    // Like Save a backup, nothing hands keys on before this session holds them unlocked (#95).
    await services.store.requireUnlocked();
    // A share by link stays on this device alone (#105): the bundle leaves every one out.
    const { plaintext } = await takeSnapshot(services.store, 'link');
    try {
      if (ended !== null) throw new LinkClosed();
      for (const blob of sealBundle(services.seal, secrets.bundle, plaintext)) {
        await services.relay.putBlob(secrets.bundle.mailbox, blob, LINK_TTL_DAYS);
      }
    } finally {
      plaintext.fill(0);
    }
  };

  const confirm = async (): Promise<'sent' | 'expired'> => {
    const stop = check();
    if (stop?.kind === 'expired') return 'expired';
    if (stop !== null) throw new LinkClosed();
    if (taken === null || !replied) throw new Error('There is no number to confirm yet.');
    try {
      await send(taken);
      return 'sent';
    } finally {
      close('closed');
    }
  };

  return {
    code: linkCode(seed, keys.publicKey),
    expiresAt,
    poll,
    confirm,
    drop: () => {
      close('closed');
    },
  };
}

/** X25519 of `secretKey` with `publicKey`, or null for a key no link can use. */
function sharedOrNull(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  try {
    return sharedSecret(secretKey, publicKey);
  } catch (error) {
    if (error instanceof LinkRefused) return null;
    throw error;
  }
}

/**
 * Joins a link on the new device: a fresh one-time key, posted to the code's
 * pairing mailbox. Resolves once the relay has it; rejects, keeping no key,
 * when it can't be reached. `keys` is for tests; the app always makes fresh ones.
 */
export async function joinLink(
  services: LinkServices,
  code: LinkCode,
  keys: LinkKeys = newLinkKeys(),
): Promise<LinkJoin> {
  const seed = Uint8Array.from(code.seed);
  const commitment = Uint8Array.from(code.commitment);
  const pairing = pairingChannelOf(seed);
  try {
    await postKey(services, pairing, NEW_DEVICE, keys.publicKey);
  } catch (error) {
    wipe(seed, keys.secretKey, pairing.key);
    throw error;
  }
  const expiresAt = services.now() + LINK_LIFETIME_MS;
  let ended: Ended<JoinStep> | null = null;
  let cursor = 0;
  let secrets: LinkSecrets | null = null;

  const close = (step: Ended<JoinStep>): Ended<JoinStep> => {
    ended ??= step;
    wipe(seed, keys.secretKey, pairing.key, secrets?.key);
    return ended;
  };

  /**
   * The step for the first existing device key in `records`: the number when
   * it matches the commitment, mismatch when it doesn't, or null when none
   * is there yet. New device keys and blobs that don't open are skipped.
   */
  const firstExistingDevice = (records: readonly RelayRecord[]): JoinStep | null => {
    for (const record of records) {
      const opened = services.seal.open(pairing.mailbox, pairing.key, record.data);
      const publicA = keyIn(opened, EXISTING_DEVICE);
      if (publicA === null) continue;
      const shared = matchesCommitment(publicA, commitment)
        ? sharedOrNull(keys.secretKey, publicA)
        : null;
      if (shared === null) return close({ kind: 'mismatch' });
      secrets = linkSecrets(shared, linkTranscript(seed, publicA, keys.publicKey));
      return { kind: 'compare', number: secrets.number };
    }
    return null;
  };

  /** One GET of the pairing mailbox, for `E_A`. */
  const lookForExistingDevice = async (): Promise<JoinStep> => {
    const page = await services.relay.getBlobs(pairing.mailbox, cursor);
    if (ended !== null) return ended;
    cursor = lastSeq(page.records, cursor);
    return firstExistingDevice(page.records) ?? { kind: 'waiting' };
  };

  /** One GET of the bundle mailbox; keeps the groups once the whole bundle checks out. */
  const lookForBundle = async (held: LinkSecrets): Promise<JoinStep> => {
    const page = await services.relay.getBlobs(held.bundle.mailbox, 0);
    if (ended !== null) return ended;
    const bundle = openBundle(
      services.seal,
      held.bundle,
      page.records.map((record) => record.data),
    );
    if (bundle.kind === 'waiting') return { kind: 'compare', number: held.number };
    if (bundle.kind === 'damaged') return close({ kind: 'damaged' });
    return close(await keep(services.store, bundle.plaintext));
  };

  const poll = oneAtATime(async (): Promise<JoinStep> => {
    if (ended === null && services.now() >= expiresAt) close({ kind: 'expired' });
    if (ended !== null) return ended;
    return secrets === null ? lookForExistingDevice() : lookForBundle(secrets);
  });

  return {
    poll,
    drop: () => {
      close({ kind: 'closed' });
    },
  };
}

/**
 * Keeps the bundle's groups, as from a link, and says how many groups the
 * device now has, and how many of the bundle's group entries (#336) and
 * personal Documents (#351) it left out because they didn't check out.
 */
async function keep(store: LinkServices['store'], plaintext: Uint8Array): Promise<Ended<JoinStep>> {
  let left: Pick<Restored, 'skipped' | 'skippedDocuments'>;
  try {
    left = await importSnapshot(store, plaintext, 'link');
  } catch (error) {
    if (error instanceof BackupUnreadable) return { kind: 'damaged' };
    throw error;
  } finally {
    plaintext.fill(0);
  }
  const { skipped, skippedDocuments } = left;
  return { kind: 'linked', groups: (await store.listGroups()).length, skipped, skippedDocuments };
}
