/**
 * A key transaction that ends early never leaves a key in neither place
 * (#391, S4). Every write of key material runs in one IndexedDB transaction
 * (`writeKeys`), which the browser commits as soon as its callback awaits
 * anything that isn't IndexedDB. A future await like that, in the middle of
 * `keepKeys`, would commit what was written so far. These tests stand in for
 * it: they commit the transaction just before each write in turn, as such an
 * await would, and check that a fresh session still finds every key: in its
 * record, or in the vault, which still opens.
 */
import { IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { local } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { type Group, type NewGroup, openStore, type Store } from './db';
import type { VaultLock } from './vault';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const LOCK: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

/** A group whose keys are bytes no other group's are. */
function newGroup(id: string, fill: number): NewGroup {
  return {
    groupId: id,
    secret: Uint8Array.from({ length: 32 }, (_, i) => (fill * 7 + i) % 256),
    signingKey: Uint8Array.from({ length: 32 }, (_, i) => (fill * 13 + i * 3 + 1) % 256),
    kxKey: Uint8Array.from({ length: 32 }, (_, i) => (fill * 17 + i * 5 + 2) % 256),
    me: { author: `author-${id}`, name: `Name ${id}` },
  };
}

const ANA = newGroup('group-ana', 1);
const BEN = newGroup('group-ben', 2);
const CAL = newGroup('group-cal', 3);
const OLD_BACKUP = new Uint8Array(32).fill(0x5b);
const NEW_BACKUP = new Uint8Array(32).fill(0x6c);

/** A group's keys, in the test's realm, so `toEqual` can compare them. */
function keysOf(group: Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'kxKey'>) {
  const { groupId, secret, signingKey, kxKey } = group;
  return [groupId, local(secret), local(signingKey), kxKey === undefined ? null : local(kxKey)];
}

/** What the device holds: each group's keys, by id, and the relay backup's key. */
interface Held {
  readonly groups: readonly ReturnType<typeof keysOf>[];
  readonly backup: Uint8Array | null;
}

/** What a fresh session on database `name` finds, unlocking the vault with {@link KEY} when there is one. */
async function heldNow(name: string): Promise<Held> {
  const store = await openStore(name);
  try {
    if ((await store.readVault()) !== null) expect(await store.unlock(KEY)).toBe(true);
    const backup = await store.getRelayBackup();
    return {
      groups: (await store.listGroups()).map(keysOf),
      backup: backup === undefined ? null : local(backup.key),
    };
  } finally {
    store.close();
  }
}

/**
 * Runs `act` on `store` with the transaction committed just before its
 * `index`th write, as an await of anything but IndexedDB would commit it.
 * Returns whether the commit came, that is, whether `act` made that many writes.
 */
async function commitBefore(store: Store, index: number, act: (store: Store) => Promise<unknown>) {
  let writes = 0;
  let injected = false;
  const methods = ['put', 'add', 'delete', 'clear'] as const;
  const spies = methods.map((method) => {
    const original = Reflect.get(FakeIDBObjectStore.prototype, method) as (
      ...args: unknown[]
    ) => unknown;
    return vi.spyOn(FakeIDBObjectStore.prototype, method).mockImplementation(function (
      this: InstanceType<typeof FakeIDBObjectStore>,
      ...args: unknown[]
    ) {
      if (writes === index) {
        injected = true;
        this.transaction.commit();
      }
      writes += 1;
      return Reflect.apply(original, this, args);
    } as never);
  });
  try {
    await act(store).catch(() => undefined);
  } finally {
    for (const spy of spies) spy.mockRestore();
    store.close();
  }
  return injected;
}

/**
 * Commits `act`'s transaction early before each of its writes in turn, on a
 * device `setUp` makes fresh each time in a database of its own, and hands
 * each outcome to `check`. Returns how many writes `act` makes.
 */
async function everyEarlyCommit(
  setUp: (name: string) => Promise<Store>,
  act: (store: Store) => Promise<unknown>,
  check: (held: Held) => void,
): Promise<number> {
  for (let index = 0; ; index += 1) {
    const name = `early-commit-${String(index)}`;
    if (!(await commitBefore(await setUp(name), index, act))) return index;
    check(await heldNow(name));
  }
}

/** A device with Ana's and Ben's groups and a relay backup key, nothing sealed yet. */
async function plainDevice(name: string): Promise<Store> {
  const store = await openStore(name);
  await store.addGroup(ANA);
  await store.addGroup(BEN);
  await store.setRelayBackupKey(OLD_BACKUP);
  return store;
}

/** That device, its keys sealed under {@link KEY}. */
async function sealedDevice(name: string): Promise<Store> {
  const store = await plainDevice(name);
  await store.sealKeys(LOCK, KEY);
  return store;
}

const BOTH = [keysOf(ANA), keysOf(BEN)];

describe('a key transaction committed early, before any of its writes (#391)', () => {
  it('sealing the keys: every key stays in its record or the vault', async () => {
    const writes = await everyEarlyCommit(
      plainDevice,
      (store) => store.sealKeys(LOCK, KEY),
      (held) => {
        expect(held).toEqual({ groups: BOTH, backup: local(OLD_BACKUP) });
      },
    );
    expect(writes).toBeGreaterThanOrEqual(4);
  });

  it('adding a group: the others keep their keys, and the new one is whole or not there', async () => {
    const writes = await everyEarlyCommit(
      sealedDevice,
      (store) => store.addGroup(CAL),
      (held) => {
        expect([BOTH, [...BOTH, keysOf(CAL)]]).toContainEqual(held.groups);
        expect(held.backup).toEqual(local(OLD_BACKUP));
      },
    );
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  it('purging a group: the other keeps its keys, and the purged one is whole or gone', async () => {
    const writes = await everyEarlyCommit(
      sealedDevice,
      (store) => store.purgeGroup(BEN.groupId),
      (held) => {
        expect([BOTH, [keysOf(ANA)]]).toContainEqual(held.groups);
        expect(held.backup).toEqual(local(OLD_BACKUP));
      },
    );
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  it('replacing the relay backup key: the groups keep theirs, and the backup holds the old key or the new', async () => {
    const writes = await everyEarlyCommit(
      sealedDevice,
      (store) => store.setRelayBackupKey(NEW_BACKUP),
      (held) => {
        expect(held.groups).toEqual(BOTH);
        expect([local(OLD_BACKUP), local(NEW_BACKUP)]).toContainEqual(held.backup);
      },
    );
    expect(writes).toBeGreaterThanOrEqual(2);
  });
});
