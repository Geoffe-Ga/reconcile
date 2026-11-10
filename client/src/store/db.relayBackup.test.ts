/**
 * The relay backup's state on the device (#97): one device-wide record, in
 * no group, holding the backup key and what the last upload held.
 */
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';

import { local } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore, RELAY_BACKUP_CHANGED, type RelayBackupState } from './db';
import { newPersonalId } from './personal';

freshIndexedDBPerTest();

const KEY = new Uint8Array(32).fill(5);
const NEW_KEY = new Uint8Array(32).fill(6);

/** `state` with its key in the test's realm, so `toEqual` can compare it. */
function comparable(state: RelayBackupState | undefined) {
  return state === undefined ? undefined : { ...state, key: local(state.key) };
}

/** A fresh state for `key`: nothing uploaded, nothing checked. */
function fresh(key: Uint8Array): RelayBackupState {
  return { key, digest: null, checkedDay: null, uploadedAt: null, tooLarge: false };
}

describe('the relay backup’s state', () => {
  it('is absent on a new device', async () => {
    const store = await openStore();

    expect(await store.getRelayBackup()).toBeUndefined();
  });

  it('keeps a new key with nothing uploaded, and hands back the state it replaced', async () => {
    const store = await openStore();

    const none = await store.setRelayBackupKey(KEY);
    await store.updateRelayBackup(KEY, { digest: 'd1', checkedDay: 7, uploadedAt: 9 });
    const previous = await store.setRelayBackupKey(NEW_KEY);

    expect(none).toBeUndefined();
    expect(comparable(previous)).toEqual({
      ...fresh(local(KEY)),
      digest: 'd1',
      checkedDay: 7,
      uploadedAt: 9,
    });
    expect(comparable(await store.getRelayBackup())).toEqual(fresh(local(NEW_KEY)));
  });

  it('survives a reload, and lives in no group', async () => {
    const store = await openStore();
    await store.addGroup({
      groupId: 'group-1',
      secret: new Uint8Array(32).fill(9),
      signingKey: new Uint8Array(32).fill(7),
      me: { author: 'author-ana', name: 'Ana' },
    });
    await store.setRelayBackupKey(KEY);
    store.close();

    const reloaded = await openStore();
    const [group] = await reloaded.listGroups();

    expect(comparable(await reloaded.getRelayBackup())).toEqual(fresh(local(KEY)));
    expect(Object.keys(group ?? {}).sort()).toEqual([
      'cursor',
      'groupId',
      'instance',
      'lastSyncAt',
      'log',
      'me',
      'outbox',
      'relayNow',
      'secret',
      'signingKey',
    ]);
    const bytes = Object.values(group ?? {}).filter((value): value is Uint8Array =>
      ArrayBuffer.isView(value),
    );
    expect(bytes).toHaveLength(2);
    expect(bytes.map((held) => Array.from(held).join())).not.toContain(Array.from(KEY).join());
  });

  it('updates only the state of the key it names, so a stale upload can’t bring back an old key', async () => {
    const store = await openStore();
    await store.setRelayBackupKey(KEY);
    await store.setRelayBackupKey(NEW_KEY);

    const stale = await store.updateRelayBackup(KEY, { digest: 'old', uploadedAt: 1 });
    const current = await store.updateRelayBackup(NEW_KEY, { tooLarge: true, checkedDay: 3 });

    expect([stale, current]).toEqual([false, true]);
    expect(comparable(await store.getRelayBackup())).toEqual({
      ...fresh(local(NEW_KEY)),
      tooLarge: true,
      checkedDay: 3,
    });
  });

  it('changes nothing when there is no key to update', async () => {
    const store = await openStore();

    expect(await store.updateRelayBackup(KEY, { digest: 'd' })).toBe(false);
    expect(await store.getRelayBackup()).toBeUndefined();
  });

  it('adopts a key only when the device holds none', async () => {
    const store = await openStore();

    const first = await store.adoptRelayBackupKey(KEY);
    const second = await store.adoptRelayBackupKey(NEW_KEY);

    expect([first, second]).toEqual([true, false]);
    expect(comparable(await store.getRelayBackup())).toEqual(fresh(local(KEY)));
  });

  it('tells listeners when the state changes, under its own name and no group’s', async () => {
    const store = await openStore();
    const heard = vi.fn();
    store.subscribe(heard);

    await store.setRelayBackupKey(KEY);
    await store.updateRelayBackup(KEY, { uploadedAt: 5 });
    await store.updateRelayBackup(NEW_KEY, { uploadedAt: 6 });
    await store.adoptRelayBackupKey(NEW_KEY);

    expect(heard.mock.calls).toEqual([[RELAY_BACKUP_CHANGED], [RELAY_BACKUP_CHANGED]]);
    expect(RELAY_BACKUP_CHANGED).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('copies the key it keeps, so the caller zeroing theirs changes nothing', async () => {
    const store = await openStore();
    const key = Uint8Array.from(KEY);

    await store.setRelayBackupKey(key);
    key.fill(0);

    expect(comparable(await store.getRelayBackup())?.key).toEqual(local(KEY));
  });

  it('keeps a version 3 database’s groups when it upgrades', async () => {
    const old = await openDB('reconcile', 3, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    await old.put('groups', { groupId: 'kept', secret: new Uint8Array(32) });
    old.close();

    const store = await openStore();

    expect((await store.listGroups()).map((group) => group.groupId)).toEqual(['kept']);
    expect(await store.getRelayBackup()).toBeUndefined();
    await store.setRelayBackupKey(KEY);
    expect(comparable(await store.getRelayBackup())).toEqual(fresh(local(KEY)));
  });

  it('keeps a version 4 database’s groups and personal Documents (#93) when it upgrades', async () => {
    const statement = {
      id: newPersonalId(),
      title: 'What I stand for',
      text: 'Kept through the upgrade.',
      createdAt: 1,
      updatedAt: 2,
    };
    const old = await openDB('reconcile', 4, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        database.createObjectStore('personal', { keyPath: 'id' });
      },
    });
    await old.put('groups', { groupId: 'kept', secret: new Uint8Array(32) });
    await old.put('personal', statement);
    old.close();

    const store = await openStore();

    expect((await store.listGroups()).map((group) => group.groupId)).toEqual(['kept']);
    expect(await store.listPersonal()).toEqual([statement]);
    expect(await store.getRelayBackup()).toBeUndefined();
    await store.setRelayBackupKey(KEY);
    expect(comparable(await store.getRelayBackup())).toEqual(fresh(local(KEY)));
  });
});
