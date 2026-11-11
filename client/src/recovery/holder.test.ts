/**
 * A recovery contact's side (#118; ADR-0043 §2, ADR-0075 §4), across real
 * devices on one fake relay whose clock the test moves: the real relay's
 * can't be moved, so the 72-hour wait is proved here, in relay time, as the
 * relay hands it to each device.
 *
 * Ben holds Ana's share. He approves a new device's code once the number he
 * was read matches; his device posts an alert to Ana in their group and
 * holds the share for 4,320 relay minutes from the alert's receipt. After
 * that, on his next complete sync pass, with no cancel from Ana's key, it
 * puts the share, sealed to the new device, in the request mailbox.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { newRecoveryKeys, recoveryChannel, recoveryCheck, recoveryCode } from '../crypto/recovery';
import { BLOB_SIZES } from '../crypto/seal';
import { signEvent } from '../engine/event';
import { foldGroup } from '../store/expiry';
import { chooseContacts, openHeldShare } from '../store/recovery';
import type { TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  gated,
  groupOn,
  HOLD,
  holdTag,
  keyOf,
  recoveryWorld,
  releasedShares,
  syncAll,
} from '../test/recovery';
import { approveRecovery, CheckMismatch, holdViews } from './holder';

freshIndexedDBPerTest();

/** Several real devices with real stores, sync passes and crypto: slower than 5 seconds on a busy machine. */
const DEVICES = { timeout: 60_000 };

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Ana's world on a gated fake relay, and a new device's request: its keys, code and check. */
async function setUp() {
  const fake = createFakeRelay();
  const { view, gate } = gated(fake);
  const world = await recoveryWorld(view);
  opened.push(...world.devices);
  const request = newRecoveryKeys();
  const code = recoveryCode(request);
  const ana = await keyOf(world.ana, world.groupId);
  return { fake, gate, world, request, code, check: recoveryCheck(code), ana };
}

/** The relay minute at which the relay received `device`'s one alert in `groupId`. */
async function alertReceived(device: TestDevice, groupId: string): Promise<number> {
  const state = foldGroup(await groupOn(device, groupId));
  const [alert] = state.recoveryAlerts;
  if (alert === undefined) throw new Error('Expected the alert in the log.');
  return alert.received;
}

/** Moves the fake relay's clock to `minute` and runs one sync pass on `device`. */
async function passAt(fake: FakeRelay, minute: number, device: TestDevice): Promise<boolean> {
  fake.minute = minute;
  return device.services.sync.syncOnce();
}

describe('holding a share for someone recovering', DEVICES, () => {
  it('releases nothing at + 4,319 minutes, and the share at + 4,320, in one 1,024-byte blob', async () => {
    const { fake, world, request, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    const held = openHeldShare(await groupOn(ben, groupId), ana);

    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const received = await alertReceived(ben, groupId);
    const { mailbox } = recoveryChannel(request.seed);

    expect(await passAt(fake, received + HOLD - 1, ben)).toBe(true);
    expect(fake.blobs(mailbox)).toEqual([]);
    expect((await groupOn(ben, groupId)).recoveryHolds?.[0]?.ended).toBeUndefined();

    expect(await passAt(fake, received + HOLD, ben)).toBe(true);
    const blobs = fake.blobs(mailbox);
    expect(blobs.map((blob) => blob.length)).toEqual([BLOB_SIZES[0]]);
    const [share] = releasedShares(fake, request.seed, request.secretKey);
    expect(share && { ...share, share: local(share.share) }).toEqual(
      held && { ...held, share: local(held.share) },
    );
    // Its PUT asked the relay to keep it 7 days.
    const put = fake.requests.find((sent) => sent.method === 'PUT' && sent.url.includes(mailbox));
    expect(put?.url).toMatch(/\?ttl_days=7$/);
    const [hold] = (await groupOn(ben, groupId)).recoveryHolds ?? [];
    expect(hold?.ended?.kind).toBe('sent');
    expect(hold?.code).toBeUndefined();

    // It goes once: another pass sends nothing more.
    await passAt(fake, received + HOLD + 60, ben);
    expect(fake.blobs(mailbox)).toHaveLength(1);
  });

  it('stops for a cancel from the person’s key, posted at any time before, and not for one from anyone else', async () => {
    const { fake, world, request, code, check, ana } = await setUp();
    const { ben, dee, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const received = await alertReceived(ben, groupId);
    const tag = await holdTag(ben, groupId);
    const { mailbox } = recoveryChannel(request.seed);

    // Dee names the very tag, under her own key: it doesn't count.
    const deeGroup = await groupOn(dee, groupId);
    const deeCancel = signEvent(deeGroup.signingKey, {
      type: 'recovery-cancel',
      group: groupId,
      ts: 0,
      body: { alert: tag },
    });
    await dee.services.store.enqueue(groupId, deeCancel.record);
    await dee.services.sync.syncOnce();
    await passAt(fake, received + HOLD, ben);
    expect(releasedShares(fake, request.seed, request.secretKey)).toHaveLength(1);

    // Ana's key, one minute before the end, stops a second approval's release.
    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const second = foldGroup(await groupOn(ben, groupId)).recoveryAlerts.at(-1);
    const secondTag = (await groupOn(ben, groupId)).recoveryHolds?.at(-1)?.tag ?? '';
    const anaGroup = await groupOn(world.ana, groupId);
    fake.minute = (second?.received ?? 0) + HOLD - 1;
    const anaCancel = signEvent(anaGroup.signingKey, {
      type: 'recovery-cancel',
      group: groupId,
      ts: 0,
      body: { alert: secondTag },
    });
    await world.ana.services.store.enqueue(groupId, anaCancel.record);
    await world.ana.services.sync.syncOnce();
    await passAt(fake, (second?.received ?? 0) + HOLD, ben);

    expect(fake.blobs(mailbox)).toHaveLength(1);
    const holds = (await groupOn(ben, groupId)).recoveryHolds ?? [];
    expect(holds.map((hold) => hold.ended?.kind)).toEqual(['sent', 'stopped']);
    expect(holds[1]?.code).toBeUndefined();
  });

  it('releases nothing after a failed sync pass, even with the relay taking PUTs, and sends on the next complete one', async () => {
    const { fake, gate, world, request, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const received = await alertReceived(ben, groupId);
    const { mailbox } = recoveryChannel(request.seed);

    gate.gets = false;
    expect(await passAt(fake, received + HOLD + 10, ben)).toBe(false);
    expect(fake.blobs(mailbox)).toEqual([]);

    gate.gets = true;
    expect(await passAt(fake, received + HOLD + 11, ben)).toBe(true);
    expect(fake.blobs(mailbox)).toHaveLength(1);
  });

  it('refuses a wrong check number, a code that isn’t one, and someone whose share it doesn’t hold, queuing nothing', async () => {
    const { world, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    const before = await groupOn(ben, groupId);
    const wrong = String((Number(check) + 1) % 1_000_000).padStart(6, '0');

    await expect(
      approveRecovery(ben.services, { code, groupId, person: ana, check: wrong }),
    ).rejects.toBeInstanceOf(CheckMismatch);
    await expect(
      approveRecovery(ben.services, { code: 'RR1.nope', groupId, person: ana, check }),
    ).rejects.toThrow('That isn’t a recovery code.');
    const dee = await keyOf(world.dee, groupId);
    await expect(
      approveRecovery(ben.services, { code, groupId, person: dee, check }),
    ).rejects.toThrow('This device holds no share for them.');

    const after = await groupOn(ben, groupId);
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.recoveryHolds).toBeUndefined();
  });

  it('takes the number with spaces, as it was read out in two groups of three', async () => {
    const { world, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, {
      code: `  ${code}\n`,
      groupId,
      person: ana,
      check: `${check.slice(0, 3)} ${check.slice(3)}`,
    });
    expect((await groupOn(ben, groupId)).recoveryHolds).toHaveLength(1);
  });

  it('stops, sending nothing, once the person has chosen again since the approval', async () => {
    const { fake, world, request, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const received = await alertReceived(ben, groupId);
    // Ana chooses again: Ben's share now comes from another split.
    await chooseContacts(world.ana.services, {
      t: 2,
      contacts: [
        { groupId, member: await keyOf(ben, groupId) },
        { groupId, member: await keyOf(world.dee, groupId) },
        { groupId: world.allotment, member: await keyOf(world.cal, world.allotment) },
      ],
    });
    await syncAll(world.devices);

    await passAt(fake, received + HOLD, ben);
    expect(fake.blobs(recoveryChannel(request.seed).mailbox)).toEqual([]);
    expect((await groupOn(ben, groupId)).recoveryHolds?.[0]?.ended?.kind).toBe('stopped');
  });

  it('posts one alert in the share’s group that names no one, and Settings reads each hold as it goes', async () => {
    const { fake, world, code, check, ana } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check });
    const state = foldGroup(await groupOn(ben, groupId));
    expect(state.recoveryAlerts.map((alert) => alert.by)).toEqual([await keyOf(ben, groupId)]);
    const alertBox = state.recoveryAlerts[0]?.box ?? '';
    // The box carries no name, key, code or split in the clear.
    expect(alertBox).not.toContain(ana);
    expect(alertBox).not.toContain(code.slice(4, 20));

    const [view] = holdViews(await ben.services.store.listGroups());
    const received = await alertReceived(ben, groupId);
    expect(view).toMatchObject({ groupId, name: 'Ana', until: received + HOLD, ended: null });
    await passAt(fake, received + HOLD, ben);
    const [sent] = holdViews(await ben.services.store.listGroups());
    expect(sent).toMatchObject({ name: 'Ana', ended: 'sent' });
  });
});
