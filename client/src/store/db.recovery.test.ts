/**
 * Recovery contacts on the device (#109): the person's choice is one
 * device-wide record beside the relay backup's, in no group, and each group
 * remembers which held shares its home has already shown.
 */
import { describe, expect, it, vi } from 'vitest';

import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, testKeys } from '../test/keys';
import { type Canary, findCanaries, keyCanaries, textCanary } from '../test/scan';
import { openStore, RECOVERY_CHANGED, type RecoveryPlan, RELAY_BACKUP_CHANGED } from './db';
import { eventIdOf } from './eventId';
import { deviceSnapshot, takeSnapshot } from './snapshot';

freshIndexedDBPerTest();

type TestStore = Awaited<ReturnType<typeof openStore>>;

// Each contact's name and key is a canary, at least MIN_CANARY_BYTES long, so a scan can look for it.
const PLAN: RecoveryPlan = {
  split: 'split-id-of-a-db-test-1',
  t: 2,
  n: 3,
  contacts: [
    {
      groupId: 'group-1',
      member: 'ben-key-canary',
      name: 'Benedetta Canary',
      groupName: 'Riverside Tenants',
    },
    {
      groupId: 'group-1',
      member: 'cal-key-canary',
      name: 'Calloway Canary',
      groupName: 'Riverside Tenants',
    },
    {
      groupId: 'group-2',
      member: 'dee-key-canary',
      name: 'Delphine Canary',
      groupName: 'Allotment',
    },
  ],
  chosenAt: 1_762_650_000_000,
  retired: [],
};

/**
 * What the plan says that no snapshot may carry: its split and each contact's
 * key and name. Not a contact's group name: a group's own name travels in its
 * genesis.
 */
const PLAN_CANARIES: Canary[] = [
  textCanary('the plan’s split', PLAN.split),
  ...PLAN.contacts.flatMap(({ member, name }) => [
    textCanary(`${name}’s key`, member),
    textCanary(`${name}’s name`, name),
  ]),
];

/** Keeps a group called `groupId` on `store`, as Create group would. */
async function keepGroup(store: TestStore, groupId: string) {
  await store.addGroup({
    groupId,
    secret: new Uint8Array(32).fill(9),
    signingKey: new Uint8Array(32).fill(7),
    me: { author: 'author-ana', name: 'Ana' },
  });
}

/**
 * Keeps a group whose genesis the relay has returned, and gives its id. A
 * snapshot holds only such a group (`backedUpGroups`), so a test that a
 * snapshot leaves something out keeps this one, not `keepGroup`'s, which the
 * snapshot would leave out whole.
 */
async function keepFoundedGroup(store: TestStore): Promise<string> {
  const { state, records } = testGroup();
  const groupId = state.group;
  if (groupId === null) throw new Error('Expected a group.');
  await store.addGroup({
    groupId,
    secret: new Uint8Array(32).fill(9),
    signingKey: testKeys('ana').secretKey,
    me: { author: authorOf('ana'), name: 'Ana' },
  });
  const last = records.at(-1);
  const pull = {
    records: [...records],
    cursor: last?.seq ?? 0,
    relayNow: (last?.received ?? 0) + 5,
    instance: 'relay-1',
    lastSyncAt: 1_762_000_000_000,
  };
  await store.applyPull(groupId, pull, eventIdOf);
  return groupId;
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

  it('keeps every retired backup id, noting the relay day it last kept them overwritten (#272)', async () => {
    const store = await openStore();
    await store.setRecoveryPlan({ ...PLAN, retired: ['old-id-1', 'old-id-2'] });

    await store.markRetiredChecked(20_400);
    expect(await store.getRecoveryPlan()).toEqual({
      ...PLAN,
      retired: ['old-id-1', 'old-id-2'],
      retiredCheckedDay: 20_400,
    });
  });

  it('notes nothing, and writes nothing, while the device has no plan', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);
    await store.markRetiredChecked(20_400);
    expect(await store.getRecoveryPlan()).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
  });

  it('marks the plan superseded when its key is retired by a choice on another device (#272)', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    await store.setRelayBackupKey(new Uint8Array(32).fill(5), PLAN.split);
    await store.setRecoveryPlan(PLAN);
    store.subscribe(heard);

    await store.retireRelayBackup(new Uint8Array(32).fill(5), 1_762_660_000_000);

    expect(await store.getRecoveryPlan()).toEqual({ ...PLAN, supersededAt: 1_762_660_000_000 });
    expect(heard.mock.calls).toEqual(
      expect.arrayContaining([[RECOVERY_CHANGED], [RELAY_BACKUP_CHANGED]]),
    );
  });

  it('never travels in a snapshot: no backup file, link bundle or relay copy holds the contacts', async () => {
    const store = await openStore();
    const groupId = await keepFoundedGroup(store);
    await store.setRelayBackupKey(new Uint8Array(32).fill(5));
    await store.setRecoveryPlan(PLAN);

    const snapshot = await deviceSnapshot(store);
    expect(Object.keys(snapshot).sort()).toEqual(['backupKey', 'groups', 'personal']);
    // A backup file's plaintext. A link bundle and the relay copy encode the same snapshot
    // (`encodeSnapshot` of `deviceSnapshot`), less shares and the key, so what it leaves out, they do.
    const { plaintext, groupIds } = await takeSnapshot(store);
    // The control: it holds the group, so a plan written into a group's entry would show.
    expect(groupIds).toEqual([groupId]);
    expect(findCanaries(plaintext, PLAN_CANARIES)).toEqual([]);
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
    await store.markRecoverySeen('group-1', ['share-b', 'share-a']);

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

describe('the shares this device holds for someone recovering (#118)', () => {
  /** A hold without its code and second number, as one that has ended keeps it. */
  const BARE = {
    alert: 'alert-id',
    person: 'author-ben',
    split: 'split-of-the-hold',
    tag: 'tag-of-the-hold',
    approvedAt: 1_762_650_000_000,
  };
  const HOLD = { ...BARE, code: 'RR1.the-code', number: '123456' };

  it('queues the signed alert and keeps the hold in one change, and tells listeners', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);
    const alert = Uint8Array.from([1, 2, 3]);

    await store.holdShare('group-1', alert, HOLD);

    const group = await store.getGroup('group-1');
    expect(group?.outbox.map((bytes) => Array.from(bytes))).toEqual([[1, 2, 3]]);
    expect(group?.recoveryHolds).toEqual([HOLD]);
    expect(heard.mock.calls).toEqual([['group-1']]);
  });

  it('ends a hold once, a sent one keeping its code and number, and leaves the others alone', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await store.holdShare('group-1', Uint8Array.from([1]), HOLD);
    await store.holdShare('group-1', Uint8Array.from([2]), { ...HOLD, alert: 'other-alert' });

    await store.endHold('group-1', 'alert-id', { kind: 'sent', at: 5 });
    await store.endHold('group-1', 'alert-id', { kind: 'stopped', at: 6 });
    await store.endHold('group-1', 'no-such-alert', { kind: 'stopped', at: 7 });

    // A sent hold keeps them, so the contact can send again with a corrected number (#398).
    expect((await store.getGroup('group-1'))?.recoveryHolds).toEqual([
      { ...HOLD, ended: { kind: 'sent', at: 5 } },
      { ...HOLD, alert: 'other-alert' },
    ]);
  });

  it('drops a stopped hold’s code and number at once (#398)', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await store.holdShare('group-1', Uint8Array.from([1]), HOLD);

    await store.endHold('group-1', 'alert-id', { kind: 'stopped', at: 6 });

    const [hold] = (await store.getGroup('group-1'))?.recoveryHolds ?? [];
    expect(hold).not.toHaveProperty('code');
    expect(hold).not.toHaveProperty('number');
    expect(hold).toEqual({ ...BARE, ended: { kind: 'stopped', at: 6 } });
  });

  it('takes a corrected number for a sent hold only while it has its code, then forgets both (#398)', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await store.holdShare('group-1', Uint8Array.from([1]), HOLD);
    await store.holdShare('group-1', Uint8Array.from([2]), { ...HOLD, alert: 'open-alert' });
    await store.endHold('group-1', 'alert-id', { kind: 'sent', at: 5 });
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);

    await store.setHoldNumber('group-1', 'alert-id', '654321');
    // A hold still waiting takes no number this way.
    await store.setHoldNumber('group-1', 'open-alert', '654321');
    expect((await store.getGroup('group-1'))?.recoveryHolds?.map((h) => h.number)).toEqual([
      '654321',
      '123456',
    ]);

    await store.forgetHoldCode('group-1', 'alert-id');
    await store.forgetHoldCode('group-1', 'open-alert');
    await store.setHoldNumber('group-1', 'alert-id', '111111');
    const [sent, open] = (await store.getGroup('group-1'))?.recoveryHolds ?? [];
    expect(sent).toEqual({ ...BARE, ended: { kind: 'sent', at: 5 } });
    expect(sent).not.toHaveProperty('code');
    expect(sent).not.toHaveProperty('number');
    // A hold still waiting keeps its code: only an ended one forgets it.
    expect(open).toEqual({ ...HOLD, alert: 'open-alert' });
    expect(heard).toHaveBeenCalledWith('group-1');
  });

  it('refuses a group that is leaving or read-only, queuing and keeping nothing', async () => {
    const store = await openStore();
    await keepGroup(store, 'group-1');
    await store.markLeaving('group-1', Uint8Array.from([9]));
    await expect(store.holdShare('group-1', Uint8Array.from([1]), HOLD)).rejects.toThrow(
      'This group is leaving this device.',
    );
    await keepGroup(store, 'group-2');
    await store.markArchived('group-2', 'dissolved');
    await expect(store.holdShare('group-2', Uint8Array.from([1]), HOLD)).rejects.toThrow(
      'This group is read-only on this device.',
    );
    expect((await store.getGroup('group-1'))?.recoveryHolds).toBeUndefined();
    expect((await store.getGroup('group-2'))?.recoveryHolds).toBeUndefined();
  });

  it('never travel in a snapshot, though the group that keeps them does', async () => {
    const store = await openStore();
    const groupId = await keepFoundedGroup(store);
    await store.holdShare(groupId, Uint8Array.from([1]), HOLD);
    expect((await store.getGroup(groupId))?.recoveryHolds).toEqual([HOLD]);

    const { plaintext, groupIds } = await takeSnapshot(store);
    expect(groupIds).toEqual([groupId]);
    // Every text field the hold keeps but its six-digit number, too short to scan for alone.
    const fields = ['alert', 'person', 'split', 'tag', 'code'] as const;
    const canaries = [
      textCanary('the holds field', 'recoveryHolds'),
      ...fields.map((field) => textCanary(`the hold’s ${field}`, HOLD[field])),
    ];
    expect(findCanaries(plaintext, canaries)).toEqual([]);
  });
});

describe('a recovering device’s request (#118)', () => {
  const REQUEST = {
    seed: new Uint8Array(16).fill(3),
    secretKey: new Uint8Array(32).fill(4),
    startedAt: 1_762_650_000_000,
  };

  it('is absent on a new device, kept across a reload once made, and dropped on Stop', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);
    expect(await store.getRecoverRequest()).toBeUndefined();

    expect(await store.keepRecoverRequest(REQUEST)).toBe(REQUEST);
    // A second request while one is kept keeps the first, and writes nothing.
    const second = { ...REQUEST, seed: new Uint8Array(16).fill(8) };
    const again = await store.keepRecoverRequest(second);
    expect(Array.from(again.seed)).toEqual(Array.from(REQUEST.seed));
    store.close();
    const reloaded = await openStore();
    const kept = await reloaded.getRecoverRequest();
    expect(
      kept && { ...kept, seed: Array.from(kept.seed), secretKey: Array.from(kept.secretKey) },
    ).toEqual({
      ...REQUEST,
      seed: Array.from(REQUEST.seed),
      secretKey: Array.from(REQUEST.secretKey),
    });

    await reloaded.dropRecoverRequest();
    expect(await reloaded.getRecoverRequest()).toBeUndefined();
    expect(heard.mock.calls).toEqual([[RECOVERY_CHANGED]]);
  });

  it('gives way, once a backup opens, to a mark that the device was recovered, in one change', async () => {
    const store = await openStore();
    await store.keepRecoverRequest(REQUEST);
    expect(await store.getRecoveredAt()).toBeUndefined();

    await store.finishRecovery(42);

    expect(await store.getRecoverRequest()).toBeUndefined();
    expect(await store.getRecoveredAt()).toBe(42);
    // Neither reads as the relay backup's record or the recovery plan.
    expect(await store.getRelayBackup()).toBeUndefined();
    expect(await store.getRecoveryPlan()).toBeUndefined();
  });

  it('is told apart from the relay backup and the plan, and never travels in a snapshot', async () => {
    const store = await openStore();
    const groupId = await keepFoundedGroup(store);
    await store.setRelayBackupKey(new Uint8Array(32).fill(5));
    await store.setRecoveryPlan(PLAN);
    await store.keepRecoverRequest(REQUEST);

    expect(await store.getRecoveryPlan()).toEqual(PLAN);
    expect((await store.getRelayBackup())?.tooLarge).toBe(false);
    const snapshot = await deviceSnapshot(store);
    expect(Object.keys(snapshot).sort()).toEqual(['backupKey', 'groups', 'personal']);
    const { plaintext, groupIds } = await takeSnapshot(store);
    expect(groupIds).toEqual([groupId]);
    const canaries = [
      ...keyCanaries('the request’s seed', REQUEST.seed),
      ...keyCanaries('the request’s key', REQUEST.secretKey),
      ...PLAN_CANARIES,
    ];
    expect(findCanaries(plaintext, canaries)).toEqual([]);
  });
});
