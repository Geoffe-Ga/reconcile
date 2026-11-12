/**
 * Passkey unlock for this device's keys (#95; ADR-0008, ADR-0030, ADR-0042),
 * apart from any screen.
 *
 * **Setup** takes two taps, since iOS allows one WebAuthn call per tap.
 * {@link Passkey.create} makes the passkey, and {@link Passkey.protect} asks
 * it once for PRF output on a fresh 32-byte salt. That second answer decides,
 * once: the keys are sealed only when it is 32 bytes, the user was verified,
 * and `prfTrusted` holds for this device (`platform/prfPolicy.ts`). Then the
 * vault key derives from it (`crypto/keyVault.ts`) and the store seals the
 * device's keys under it (`Store.sealKeys`), deleting the plain copies in the
 * same transaction.
 * Otherwise nothing is sealed and the keys stay as they are. Either way the
 * PRF output is zeroed.
 *
 * **Launch** ({@link openDeviceLock}): a device whose keys aren't locked
 * opens at once: the dissolved archives' sweep (#108), then the sync loop,
 * then posting shares that are due (#105) ({@link whenOpen}). One whose keys
 * are locked starts nothing until {@link DeviceLock.unlock} gets PRF output
 * from the same passkey and the store's vault opens under the key it
 * derives; the key then stays in the store's memory for the session. A
 * failed unlock writes nothing and never seals anything again under another
 * key. Restore puts a backup file's groups in place of the locked ones.
 *
 * Nothing here reaches the network, and the relay hears nothing about
 * passkeys: the password manager sees only the app's host and "Reconcile key".
 */
import { newPrfSalt, vaultKeyFromPrf } from '../crypto/keyVault';
import type { PlatformEnv } from '../platform/installGate';
import { prfTrusted } from '../platform/prfPolicy';
import { PasskeyUnanswered, type WebAuthn } from '../platform/webauthn';
import { sweepArchives } from '../store/archive';
import type { Store } from '../store/db';
import { replaceWithBackup, type Restored } from '../store/snapshot';
import type { Sync } from '../store/sync';

/** What passkey setup and unlock run on. */
export interface PasskeyDeps {
  readonly store: Pick<
    Store,
    'readVault' | 'sealKeys' | 'unlock' | 'replaceGroups' | 'adoptRelayBackupKey'
  >;
  /** The browser's WebAuthn, or undefined where it has none. */
  readonly webauthn: WebAuthn | undefined;
  /** What the browser reports, for `prfTrusted`. */
  readonly platform: Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'>;
  /** The relying party id: the app's own host. */
  readonly rpId: string;
}

/** How setup ended: the keys are locked with the passkey, or it can't protect them. */
export type Protection = 'protected' | 'no-prf';

/** Passkey setup, for the offer after the pilot notice and for Settings. */
export interface Passkey {
  /** Whether this browser can offer a passkey: it has WebAuthn, and PRF is trusted here. */
  readonly available: boolean;
  /** Whether this device's keys are locked with a passkey. */
  isProtected(): Promise<boolean>;
  /**
   * Tap 1: makes the passkey and returns its credential id.
   *
   * @throws {PasskeyUnanswered} when no passkey was made.
   */
  create(): Promise<Uint8Array>;
  /**
   * Tap 2: asks the passkey once for PRF output, and seals the device's keys
   * (`Store.sealKeys`) when it qualifies.
   *
   * @throws {PasskeyUnanswered} when the passkey didn't answer; nothing changes.
   */
  protect(credentialId: Uint8Array): Promise<Protection>;
}

/** The browser's WebAuthn, or {@link PasskeyUnanswered} where it has none. */
function required(webauthn: WebAuthn | undefined): WebAuthn {
  if (webauthn === undefined) throw new PasskeyUnanswered();
  return webauthn;
}

/** Seals the store's secrets under the key `prf` derives with `prfSalt`, then zeroes the key. */
async function sealUnder(
  store: PasskeyDeps['store'],
  credentialId: Uint8Array,
  prf: Uint8Array,
  prfSalt: Uint8Array,
): Promise<void> {
  const key = vaultKeyFromPrf(prf, prfSalt);
  try {
    await store.sealKeys({ credentialId, prfSalt }, key);
  } finally {
    key.fill(0);
  }
}

/** Passkey setup on `deps`. */
export function passkeyOn(deps: PasskeyDeps): Passkey {
  const { store, webauthn, platform, rpId } = deps;
  const trusted = prfTrusted(platform);
  return {
    available: webauthn !== undefined && trusted,
    isProtected: async () => (await store.readVault()) !== null,
    create: async () => required(webauthn).createCredential(rpId),
    async protect(credentialId) {
      const prfSalt = newPrfSalt();
      const prf = await required(webauthn).evaluatePrf(rpId, credentialId, prfSalt);
      if (prf === null) return 'no-prf';
      try {
        if (!trusted) return 'no-prf';
        await sealUnder(store, credentialId, prf, prfSalt);
        return 'protected';
      } finally {
        prf.fill(0);
      }
    },
  };
}

/** The lock at launch: what stands between a locked device's keys and the app. */
export interface DeviceLock {
  /** Whether the device's keys were locked with a passkey when the app started. */
  readonly lockedAtLaunch: boolean;
  /**
   * Asks the passkey for its PRF output and opens the vault, then opens the
   * app's background work. False, writing and starting nothing, when it
   * didn't unlock.
   */
  unlock(): Promise<boolean>;
  /**
   * Puts a backup file's groups in place of the locked ones, then opens the
   * app's background work. Returns how many groups came back, and how many
   * group entries the file held that didn't check out (#336).
   *
   * @throws {BackupUnreadable} when the file doesn't open; nothing is written then.
   */
  restore(file: Uint8Array, passphrase: string): Promise<Restored>;
}

/** Opens the store's vault with the passkey's PRF output; false on any failure, writing nothing. */
async function unlockVault(deps: PasskeyDeps): Promise<boolean> {
  const { store, webauthn, rpId } = deps;
  const lock = await store.readVault();
  if (lock === null) return true;
  const prf = await required(webauthn).evaluatePrf(rpId, lock.credentialId, lock.prfSalt);
  if (prf === null) return false;
  const key = vaultKeyFromPrf(prf, lock.prfSalt);
  prf.fill(0);
  try {
    return await store.unlock(key);
  } finally {
    key.fill(0);
  }
}

/**
 * What starts once this device's keys are open (#95): the dissolved
 * archives' sweep (#108), whose reads need the keys, then the sync loop, then
 * `shares`, which posts each shared personal Document due a fresh copy
 * (#105), signed with the share's own key. A sweep that fails tries again at
 * the next launch, and sync starts either way; a share whose post fails
 * stays pending, and the next launch tries again.
 */
export function whenOpen(
  store: Store,
  sync: Pick<Sync, 'start'>,
  sweep: (store: Store) => Promise<void> = sweepArchives,
  shares: () => Promise<unknown> = () => Promise.resolve(),
): () => Promise<void> {
  return async () => {
    await sweep(store).catch(() => undefined);
    sync.start();
    void shares().catch(() => undefined);
  };
}

/**
 * Reads whether the device's keys are locked, and runs `open` at once when
 * they aren't. A locked device runs it only once unlocked or restored.
 */
export async function openDeviceLock(
  deps: PasskeyDeps & { readonly open: () => Promise<void> },
): Promise<DeviceLock> {
  const { store, open } = deps;
  const lockedAtLaunch = (await store.readVault()) !== null;
  if (!lockedAtLaunch) await open();
  return {
    lockedAtLaunch,
    async unlock() {
      const opened = await unlockVault(deps).catch(() => false);
      if (opened) await open();
      return opened;
    },
    async restore(file, passphrase) {
      const restored = await replaceWithBackup(store, file, passphrase);
      await open();
      return restored;
    },
  };
}
