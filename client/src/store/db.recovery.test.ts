/**
 * Recovery contacts on the device (#109): the person's choice is one
 * device-wide record beside the relay backup's, in no group, and each group
 * remembers which held shares its home has already shown.
 */
import { describe, expect, it, vi } from 'vitest';

import { freshIndexedDBPerTest } from '../test/idb';
import { openStore, RECOVERY_CHANGED, type RecoveryPlan, RELAY_BACKUP_CHANGED } from './db';
import { deviceSnapshot } from './snapshot';

freshIndexedDBPerTest();

const PLAN: RecoveryPlan = {
  split: 'split-id-of-a-db-test-1',
  t: 2,
  n: 3,
  contacts: [
    { groupId: 'group-1', member: 'ben-key', name: 'Ben', groupName: 'Riverside Tenants' },
    { groupId: 'group-1', member: 'cal-key', name: 'Cal', groupName: 'Riverside Tenants' },
    { groupId: 'group-2', member: 'dee-key', name: 'Dee', groupName: 'Allotment' },
  ],
  chosenAt: 1_762_650_000_000,
  retired: [],
};

/** Keeps a group called `groupId` on `store`, as Create group would. */
async function keepGroup(store: Awaited<ReturnType<typeof openStore>>, groupId: string) {
  await store.addGroup({
    groupId,
    secret: new Uint8Array(32).fill(9),
    signingKey: new Uint8Array(32).fill(7),
    me: { author: 'author-ana', name: 'Ana' },
  });
}

describe('the recovery plan', () => {
  it('is absent on a new device', async () => {
    const store = await openStore();
    expect(await store.getRecoveryPlan()).toBeUndefined();
  });

  it('keeps the person’s choice across a reload, replacing any earlier one, and tells listeners', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);
    await store.setRecoveryPlan({ ...PLAN, t: 3 });
    await store.setRecoveryPlan(PLAN);
    store.close();

    const reloaded = await openStore();
    expect(await reloaded.getRecoveryPlan()).toEqual(PLAN);
    expect(heard.mock.calls).toEqual([[RECOVERY_CHANGED], [RECOVERY_CHANGED]]);
    // Not a group id, which is 43 base64url characters, nor the relay backup's.
    expect(RECOVERY_CHANGED).toBe('recovery');
    expect(RECOVERY_CHANGED).not.toBe(RELAY_BACKUP_CHANGED);
  });

  it('forgets a retired backup id once it is overwritten, keeping the rest of the plan', async () => {
    const store = await openStore();
    await store.setRecoveryPlan({ ...PLAN, retired: ['old-id-1', 'old-id-2'] });

    await store.forgetRetired('old-id-1');
    expect(await store.getRecoveryPlan()).toEqual({ ...PLAN, retired: ['old-id-2'] });
    await store.forgetRetired('not-retired');
    expect(await store.getRecoveryPlan()).toEqual({ ...PLAN, retired: ['old-id-2'] });
  });

  it('forgets nothing, and writes nothing, while the device has no plan', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);
    await store.forgetRetired('old-id-1');
    expect(await store.getRecoveryPlan()).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
  });

  it('never travels in a snapshot: no backup file, link bundle or relay copy holds the contacts', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await store.setRelayBackupKey(new Uint8Array(32).fill(5));
    await store.setRecoveryPlan(PLAN);

    const snapshot = await deviceSnapshot(store);
    expect(Object.keys(snapshot).sort()).toEqual(['backupKey', 'groups', 'personal']);
    expect(JSON.stringify(snapshot)).not.toMatch(/Ben|Cal|Dee|ben-key|split-id/);
  });
});

describe('held shares a group’s home has shown', () => {
  it('are none to start, and each group keeps its own, once each, in the order shown', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await keepGroup(store, 'group-2');
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);

    await store.markRecoverySeen('group-1', ['share-a']);
    await store.markRecoverySeen('group-1', ['share-a', 'share-b']);

    expect((await store.getGroup('group-1'))?.recoverySeen).toEqual(['share-a', 'share-b']);
    expect((await store.getGroup('group-2'))?.recoverySeen).toBeUndefined();
    expect(heard.mock.calls).toEqual([['group-1'], ['group-1']]);
  });

  it('refuses a group the device doesn’t have', async () => {
    const store = await openStore();
    await expect(store.markRecoverySeen('no-such-group', ['share-a'])).rejects.toThrow(
      'No such group on this device.',
    );
  });
});
