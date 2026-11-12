/**
 * Zeroing the vault's keys, best effort (#391, F5 and the guard): an unlock
 * zeroes the keys it opened only to check the passkey's key, and Restore on
 * the unlock screen (`replaceGroups`) zeroes the session's copy of that key
 * once the vault it opened is gone. `openKeys` is watched here, so the test
 * holds the very arrays the store did.
 */
import { describe, expect, it, vi } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { freshIndexedDBPerTest } from '../test/idb';
import { type NewGroup, openStore } from './db';
import type { VaultKeys } from './vault';

/** Each call `db.ts` made to `openKeys`: the key it passed, and the keys it got back. */
const calls = vi.hoisted((): { key: Uint8Array; keys: VaultKeys | null }[] => []);

vi.mock('./vault', async (importOriginal) => {
  const vault = await importOriginal<typeof import('./vault')>();
  return {
    ...vault,
    openKeys: (record: Parameters<typeof vault.openKeys>[0], key: Uint8Array) => {
      const keys = vault.openKeys(record, key);
      calls.push({ key, keys });
      return keys;
    },
  };
});

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const LOCK = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

const ANA: NewGroup = {
  groupId: 'group-ana',
  secret: new Uint8Array(32).fill(1),
  signingKey: new Uint8Array(32).fill(2),
  kxKey: new Uint8Array(32).fill(3),
  me: { author: 'author-ana', name: 'Ana' },
};

/** Whether every byte of `bytes` is zero. */
const zeroed = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

/** A sealed device holding Ana's group and a relay backup key, in a new session, still locked. */
async function lockedDevice() {
  const store = await openStore();
  await store.addGroup(ANA);
  await store.setRelayBackupKey(new Uint8Array(32).fill(4));
  await store.sealKeys(LOCK, KEY);
  store.close();
  calls.splice(0);
  return openStore();
}

describe('zeroing the vault’s keys, best effort (#391)', () => {
  it('zeroes every key an unlock opened only to check the passkey’s key', async () => {
    const store = await lockedDevice();

    expect(await store.unlock(KEY)).toBe(true);

    const [check] = calls;
    const keys = check?.keys ?? null;
    if (keys === null) throw new Error('Expected the unlock to open the vault.');
    const group = keys.groups.get(ANA.groupId);
    expect(
      [group?.secret, group?.signingKey, group?.kxKey, keys.backupKey].map((bytes) =>
        bytes === undefined ? null : zeroed(bytes),
      ),
    ).toEqual([true, true, true, true]);
    // The session still reads every key: it opens the vault afresh for each read.
    const read = await store.getGroup(ANA.groupId);
    expect(read?.secret).toEqual(ANA.secret);
    store.close();
  });

  it('zeroes the session’s copy of the passkey’s key once Restore replaces the vault', async () => {
    const store = await lockedDevice();
    expect(await store.unlock(KEY)).toBe(true);
    await store.getGroup(ANA.groupId);
    const session = calls.at(-1)?.key;
    if (session === undefined) throw new Error('Expected a read to open the vault.');
    expect(zeroed(session)).toBe(false);

    await store.replaceGroups([]);

    expect(zeroed(session)).toBe(true);
    expect(zeroed(KEY)).toBe(false);
    expect(await store.readVault()).toBeNull();
    store.close();
  });
});
