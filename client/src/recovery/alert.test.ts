/**
 * The person's side of a recovery (#118; ADR-0043 §2, ADR-0008): every
 * device that holds their key in a group where a contact approved opens the
 * alert, shows it until the hold ends, and can cancel it in every group
 * with one pending. Real devices on one fake relay whose clock the test moves.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { newRecoveryKeys, recoveryChannel, recoveryCheck, recoveryCode } from '../crypto/recovery';
import { exportGroups, importGroups } from '../store/snapshot';
import { type TestDevice, testDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { groupOn, HOLD, keyOf, recoveryWorld, type RecoveryWorld, syncAll } from '../test/recovery';
import { alertSummary, cancelRecovery, recoveryAlerts, type SeenAlert } from './alert';
import { approveRecovery } from './holder';

freshIndexedDBPerTest();

const DEVICES = { timeout: 60_000 };
/** The cheapest scrypt cost, for a backup file a test only restores. */
const CHEAP = 4;

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** What `device` shows, reading each group's relay minute as the last one synced. */
async function alertsOn(device: TestDevice): Promise<SeenAlert[]> {
  const groups = await device.services.store.listGroups();
  return recoveryAlerts(groups, (group) => group.relayNow ?? 0);
}

/** Ben (in Riverside) and Cal (in Allotment) each approve a new device's code for Ana. */
async function bothApprove(world: RecoveryWorld) {
  const request = newRecoveryKeys();
  const code = recoveryCode(request);
  const check = recoveryCheck(code);
  await approveRecovery(world.ben.services, {
    code,
    groupId: world.groupId,
    person: await keyOf(world.ana, world.groupId),
    check,
  });
  await approveRecovery(world.cal.services, {
    code,
    groupId: world.allotment,
    person: await keyOf(world.ana, world.allotment),
    check,
  });
  return { request, mailbox: recoveryChannel(request.seed).mailbox };
}

/** Ana's second device, restored from a backup file her first device saved, and synced. */
async function secondDevice(fake: FakeRelay, world: RecoveryWorld): Promise<TestDevice> {
  const { file } = await exportGroups(world.ana.services.store, 'river stones', CHEAP);
  const phone = await testDevice(fake, 'ana-phone');
  opened.push(phone);
  await importGroups(phone.services.store, file, 'river stones');
  await phone.services.sync.syncOnce();
  return phone;
}

describe('the alert on the person’s devices', DEVICES, () => {
  it('shows on a second device restored from a backup file, whose cancel stops every contact', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    const phone = await secondDevice(fake, world);
    const { mailbox } = await bothApprove(world);
    await phone.services.sync.syncOnce();

    const seen = await alertsOn(phone);
    expect(seen.map(({ groupId }) => groupId).sort()).toEqual(
      [world.groupId, world.allotment].sort(),
    );
    expect(seen.every(({ cancelled }) => !cancelled)).toBe(true);
    const earliest = Math.min(...seen.map(({ completes }) => completes));
    expect(alertSummary(seen)).toEqual({ kind: 'pending', completes: earliest });

    // Offline, the cancels wait in the phone's outbox, and it already reads them as cancelled.
    fake.offline = true;
    await cancelRecovery(phone.services, seen);
    expect(
      (await phone.services.store.listGroups()).every((group) => group.outbox.length > 0),
    ).toBe(true);
    expect(alertSummary(await alertsOn(phone))).toEqual({ kind: 'cancelled' });
    fake.offline = false;
    await syncAll([phone, ...world.devices]);
    expect(alertSummary(await alertsOn(world.ana))).toEqual({ kind: 'cancelled' });

    fake.minute = earliest + HOLD;
    await world.ben.services.sync.syncOnce();
    await world.cal.services.sync.syncOnce();
    expect(fake.blobs(mailbox)).toEqual([]);
    for (const [contact, groupId] of [
      [world.ben, world.groupId],
      [world.cal, world.allotment],
    ] as const) {
      const holds = (await groupOn(contact, groupId)).recoveryHolds ?? [];
      expect(holds.map((hold) => hold.ended?.kind)).toEqual(['stopped']);
    }
  });

  it('opens on no other member’s device, nor on the contact’s own', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    await bothApprove(world);
    await syncAll(world.devices);

    expect(await alertsOn(world.ana)).toHaveLength(2);
    expect(await alertsOn(world.dee)).toEqual([]);
    expect(await alertsOn(world.ben)).toEqual([]);
    expect(alertSummary([])).toBeNull();
  });

  it('reads each group again only when its log or outbox changes, and then sees what changed', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    const { ana, ben, groupId } = world;
    expect(await alertsOn(ana)).toEqual([]);
    const code = recoveryCode(newRecoveryKeys());
    const person = await keyOf(ana, groupId);
    await approveRecovery(ben.services, { code, groupId, person, check: recoveryCheck(code) });
    await ana.services.sync.syncOnce();
    const [first] = await alertsOn(ana);
    expect(first).toBeDefined();
    // The same group read again, with nothing new, answers the same.
    expect(await alertsOn(ana)).toEqual([first]);

    // A receipt moved in the stored log is read again, though the log is as long.
    const group = await groupOn(ana, groupId);
    const moved = {
      ...group,
      log: group.log.map((record) => ({ ...record, received: record.received - 60 })),
    };
    const [again] = recoveryAlerts([moved], () => 0);
    expect(again?.completes).toBe((first?.completes ?? 0) - 60);
  });

  it('shows until the hold ends, then goes, and a new alert after a cancel shows again', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    const { ana, ben, groupId } = world;
    const request = newRecoveryKeys();
    const code = recoveryCode(request);
    const approval = {
      code,
      groupId,
      person: await keyOf(ana, groupId),
      check: recoveryCheck(code),
    };
    await approveRecovery(ben.services, approval);
    await ana.services.sync.syncOnce();
    const [first] = await alertsOn(ana);
    if (first === undefined) throw new Error('Expected an alert.');
    const groups = await ana.services.store.listGroups();
    expect(recoveryAlerts(groups, () => first.completes - 1)).toHaveLength(1);
    expect(recoveryAlerts(groups, () => first.completes)).toEqual([]);

    await cancelRecovery(ana.services, [first]);
    await approveRecovery(ben.services, approval);
    await ana.services.sync.syncOnce();
    const seen = await alertsOn(ana);
    expect(seen.map(({ cancelled }) => cancelled)).toEqual([true, false]);
    expect(alertSummary(seen)).toMatchObject({ kind: 'pending' });

    // Cancelling again posts only for the alert still pending.
    const before = (await groupOn(ana, groupId)).outbox.length;
    await cancelRecovery(
      { ...ana.services, sync: { syncOnce: () => Promise.resolve(true) } },
      seen,
    );
    expect((await groupOn(ana, groupId)).outbox).toHaveLength(before + 1);
  });
});
