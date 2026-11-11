/**
 * Passkey setup and unlock (#95), on a real store over fake IndexedDB and a
 * fake authenticator: the decision made once at the second tap, and a launch
 * that starts nothing until the passkey unlocks the keys.
 */
import { describe, expect, it, vi } from 'vitest';

import { local } from '../test/bytes';
import { fakeAuthenticator } from '../test/fakeAuthenticator';
import { freshIndexedDBPerTest } from '../test/idb';
import type { PlatformEnv } from '../platform/installGate';
import { PasskeyUnanswered, type WebAuthn, webAuthn } from '../platform/webauthn';
import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { createFakeRelay } from '../test/fakeRelay';
import { type NewGroup, openStore, type Store, VaultLocked } from '../store/db';
import { refreshRelayBackup } from '../store/relayBackup';
import { exportGroups } from '../store/snapshot';
import { createSync } from '../store/sync';
import { openDeviceLock, passkeyOn, type PasskeyDeps, whenOpen } from './passkey';

freshIndexedDBPerTest();

const RP_ID = 'reconcile.example';
const ANDROID: Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'> = {
  userAgent:
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/138.0.0.0 Mobile Safari/537.36',
  maxTouchPoints: 5,
};
const IOS_18_2: Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'> = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
};

const ANA: NewGroup = {
  groupId: 'group-ana',
  secret: new Uint8Array(32).fill(0x41),
  signingKey: new Uint8Array(32).fill(0x42),
  me: { author: 'author-ana', name: 'Ana' },
};

/** The PRF salt a `get()` asked the passkey to evaluate. */
function askedSalt(options: CredentialRequestOptions | undefined): Uint8Array {
  return options?.publicKey?.extensions?.prf?.eval?.first as Uint8Array;
}

/** The deps a device's passkey runs on, with `authenticator` as its browser's. */
function deps(store: Store, calls = fakeAuthenticator().calls, platform = ANDROID): PasskeyDeps {
  return { store, webauthn: webAuthn(calls), platform, rpId: RP_ID };
}

/**
 * A device holding Ana's group, locked with a passkey on `authenticator`, then
 * reopened. `before` runs on it first, before the keys are locked.
 */
async function lockedDevice(
  authenticator = fakeAuthenticator(),
  before: (store: Store) => Promise<unknown> = () => Promise.resolve(),
) {
  const store = await openStore();
  await store.addGroup(ANA);
  await before(store);
  const passkey = passkeyOn(deps(store, authenticator.calls));
  expect(await passkey.protect(await passkey.create())).toBe('protected');
  store.close();
  return { store: await openStore(), authenticator };
}

describe('passkeyOn', () => {
  it('is available only with WebAuthn, and where PRF is trusted', async () => {
    const store = await openStore();

    expect(passkeyOn(deps(store)).available).toBe(true);
    expect(passkeyOn({ ...deps(store), webauthn: undefined }).available).toBe(false);
    expect(passkeyOn(deps(store, undefined, IOS_18_2)).available).toBe(false);
  });

  it('locks the keys with a passkey in two taps, with the PRF salt it asked with', async () => {
    const store = await openStore();
    await store.addGroup(ANA);
    const authenticator = fakeAuthenticator();
    const passkey = passkeyOn(deps(store, authenticator.calls));

    expect(await passkey.isProtected()).toBe(false);
    const id = await passkey.create();
    expect(authenticator.created).toHaveLength(1);
    expect(authenticator.asked).toHaveLength(0);
    expect(await passkey.protect(id)).toBe('protected');

    expect(await passkey.isProtected()).toBe(true);
    const lock = await store.readVault();
    if (lock === null) throw new Error('Expected a vault.');
    expect(local(lock.credentialId)).toEqual(local(id));
    expect(local(lock.prfSalt)).toEqual(local(askedSalt(authenticator.asked[0])));
    expect(lock.prfSalt).toHaveLength(32);
  });

  it('seals nothing where PRF isn’t trusted, even when the passkey gives good output', async () => {
    const store = await openStore();
    await store.addGroup(ANA);
    const passkey = passkeyOn(deps(store, fakeAuthenticator().calls, IOS_18_2));

    expect(await passkey.protect(await passkey.create())).toBe('no-prf');

    expect(await store.readVault()).toBeNull();
  });

  it('zeroes the PRF output once used, and when it can’t protect the keys', async () => {
    const store = await openStore();
    const outputs: Uint8Array[] = [];
    const webauthn: WebAuthn = {
      createCredential: () => Promise.resolve(Uint8Array.of(1)),
      evaluatePrf: () => {
        const output = new Uint8Array(32).fill(7);
        outputs.push(output);
        return Promise.resolve(output);
      },
    };

    await passkeyOn({ store, webauthn, platform: IOS_18_2, rpId: RP_ID }).protect(Uint8Array.of(1));
    await passkeyOn({ store, webauthn, platform: ANDROID, rpId: RP_ID }).protect(Uint8Array.of(1));

    expect(outputs.map((output) => output.every((byte) => byte === 0))).toEqual([true, true]);
    expect(await store.readVault()).not.toBeNull();
  });

  it('fails with PasskeyUnanswered, sealing nothing, when the passkey doesn’t answer', async () => {
    const store = await openStore();
    const authenticator = fakeAuthenticator();
    const passkey = passkeyOn(deps(store, authenticator.calls));
    const id = await passkey.create();
    authenticator.settings.cancels = true;

    await expect(passkey.protect(id)).rejects.toThrow(PasskeyUnanswered);
    await expect(passkey.create()).rejects.toThrow(PasskeyUnanswered);
    expect(await store.readVault()).toBeNull();
  });

  it('fails with PasskeyUnanswered where the browser has no WebAuthn', async () => {
    const store = await openStore();
    const passkey = passkeyOn({ ...deps(store), webauthn: undefined });

    await expect(passkey.create()).rejects.toThrow(PasskeyUnanswered);
    await expect(passkey.protect(Uint8Array.of(1))).rejects.toThrow(PasskeyUnanswered);
  });
});

describe('openDeviceLock', () => {
  it('starts syncing at once on a device whose keys aren’t locked', async () => {
    const store = await openStore();
    const open = vi.fn(() => Promise.resolve());

    const lock = await openDeviceLock({ ...deps(store), open });

    expect(lock.lockedAtLaunch).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('starts nothing until the passkey unlocks the keys, then syncs', async () => {
    const { store, authenticator } = await lockedDevice();
    const open = vi.fn(() => Promise.resolve());

    const lock = await openDeviceLock({ ...deps(store, authenticator.calls), open });

    expect(lock.lockedAtLaunch).toBe(true);
    expect(open).not.toHaveBeenCalled();
    await expect(store.listGroups()).rejects.toThrow(VaultLocked);
    expect(await lock.unlock()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect((await store.listGroups()).map((group) => local(group.signingKey))).toEqual([
      local(ANA.signingKey),
    ]);
  });

  it.each([
    ['the person cancels', { cancels: true }],
    ['the passkey gives no PRF output', { prfBytes: null }],
    ['the PRF output is 31 bytes', { prfBytes: 31 }],
    ['the user isn’t verified', { verified: false }],
  ])('stays locked, starting nothing, when %s', async (_name, settings) => {
    const { store, authenticator } = await lockedDevice();
    Object.assign(authenticator.settings, settings);
    const open = vi.fn(() => Promise.resolve());
    const lock = await openDeviceLock({ ...deps(store, authenticator.calls), open });

    expect(await lock.unlock()).toBe(false);

    expect(open).not.toHaveBeenCalled();
    await expect(store.listGroups()).rejects.toThrow(VaultLocked);
  });

  it('stays locked under another authenticator’s passkey, or with no WebAuthn at all', async () => {
    const { store } = await lockedDevice();
    const open = vi.fn(() => Promise.resolve());

    const other = await openDeviceLock({ ...deps(store, fakeAuthenticator().calls), open });
    const none = await openDeviceLock({ ...deps(store), webauthn: undefined, open });

    expect(await other.unlock()).toBe(false);
    expect(await none.unlock()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens at once when another tab already put a backup in place of the vault', async () => {
    const { store, authenticator } = await lockedDevice();
    const open = vi.fn(() => Promise.resolve());
    const lock = await openDeviceLock({ ...deps(store, authenticator.calls), open });
    await store.replaceGroups([]);

    expect(await lock.unlock()).toBe(true);
    expect(authenticator.asked).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('restores a backup file in place of the locked keys, then syncs', async () => {
    const source = await openStore('source');
    await source.addGroup({ ...ANA, groupId: 'group-backed-up' });
    const passphrase = 'a long walk to the river';
    const { file } = await exportGroups(source, passphrase, 4);
    const { store, authenticator } = await lockedDevice();
    const open = vi.fn(() => Promise.resolve());
    const lock = await openDeviceLock({ ...deps(store, authenticator.calls), open });

    // A group whose genesis the relay never returned isn't in a backup, so this one holds none.
    expect(await lock.restore(file, passphrase)).toBe(0);

    expect(await store.readVault()).toBeNull();
    expect(await store.listGroups()).toEqual([]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('writes nothing and starts nothing when the backup doesn’t open', async () => {
    const { store, authenticator } = await lockedDevice();
    const open = vi.fn(() => Promise.resolve());
    const lock = await openDeviceLock({ ...deps(store, authenticator.calls), open });

    await expect(lock.restore(new Uint8Array(100), 'nope nope nope')).rejects.toThrow();

    expect(await store.readVault()).not.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('whenOpen', () => {
  it('sweeps the dissolved archives, whose reads need the keys, before it starts syncing', async () => {
    const order: string[] = [];
    const store = await openStore();
    const sweep = vi.fn(() => {
      order.push('sweep');
      return Promise.resolve();
    });
    const sync = { start: vi.fn(() => order.push('sync')) };

    await whenOpen(store, sync, sweep)();

    expect(sweep).toHaveBeenCalledWith(store);
    expect(order).toEqual(['sweep', 'sync']);
  });

  it('starts syncing even when the sweep fails, so it tries again at the next launch', async () => {
    const store = await openStore();
    const sync = { start: vi.fn() };

    await whenOpen(store, sync, () => Promise.reject(new Error('later')))();

    expect(sync.start).toHaveBeenCalledTimes(1);
  });

  it('runs on a locked device only once the passkey unlocks it, as the sweep can’t read before', async () => {
    const { store, authenticator } = await lockedDevice();
    const sweep = vi.fn((swept: Store) => swept.listGroups().then(() => undefined));
    const sync = { start: vi.fn() };
    const lock = await openDeviceLock({
      ...deps(store, authenticator.calls),
      open: whenOpen(store, sync, sweep),
    });

    expect(sweep).not.toHaveBeenCalled();
    await expect(sweep(store)).rejects.toThrow(VaultLocked);
    sweep.mockClear();
    expect(await lock.unlock()).toBe(true);

    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(sweep.mock.results[0]?.value).resolves.toBeUndefined();
    expect(sync.start).toHaveBeenCalledTimes(1);
  });
  it('lets the sync loop refresh the relay backup (#97) only once the passkey unlocks the keys', async () => {
    const backupKey = new Uint8Array(32).fill(0xb2);
    const { store, authenticator } = await lockedDevice(fakeAuthenticator(), (held) =>
      held.setRelayBackupKey(backupKey),
    );
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const refreshed: unknown[] = [];
    const afterPass = vi.fn(async () => {
      refreshed.push(local((await store.getRelayBackup())?.key ?? new Uint8Array()));
      await refreshRelayBackup({ store, relay, now: () => 0 });
    });
    const sync = createSync({ store, relay, seal: xchachaSeal, afterPass });
    const lock = await openDeviceLock({
      ...deps(store, authenticator.calls),
      open: whenOpen(store, sync, () => Promise.resolve()),
    });

    // Even a pass something else asks for fails while locked, so nothing follows it.
    expect(await sync.syncOnce()).toBe(false);
    expect(afterPass).not.toHaveBeenCalled();
    await expect(refreshRelayBackup({ store, relay, now: () => 0 })).rejects.toThrow(VaultLocked);
    expect(await lock.unlock()).toBe(true);
    expect(await sync.syncOnce()).toBe(true);
    sync.stop();

    expect(afterPass).toHaveBeenCalled();
    await expect(afterPass.mock.results[0]?.value).resolves.toBeUndefined();
    expect(refreshed[0]).toEqual(local(backupKey));
  });
});
