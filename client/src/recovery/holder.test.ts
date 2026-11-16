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

import {
  newRecoveryKeys,
  recoveryChannel,
  recoveryCheck,
  recoveryCode,
  recoveryNumber,
} from '../crypto/recovery';
import { BLOB_SIZES } from '../crypto/seal';
import { signEvent } from '../engine/event';
import type { RecoveryHold } from '../store/db';
import { foldGroup } from '../store/expiry';
import { chooseContacts, openHeldShare } from '../store/recovery';
import type { TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  gated,
  groupOn,
  mailboxesAround,
  HOLD,
  holdTag,
  keyOf,
  recoveryWorld,
  releasedShares,
  syncAll,
} from '../test/recovery';
import {
  approveRecovery,
  CheckMismatch,
  holdViews,
  RELEASE_TTL_DAYS,
  resendRelease,
  SecondNumberInvalid,
} from './holder';

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
  const number = recoveryNumber(request.secretKey);
  return { fake, gate, world, request, code, check: recoveryCheck(code), number, ana };
}

/** A six-digit number that isn't `number`. */
function otherThan(number: string): string {
  return String((Number(number) + 1) % 1_000_000).padStart(6, '0');
}

/** `device`'s first hold in `groupId`. */
async function holdOn(device: TestDevice, groupId: string): Promise<RecoveryHold> {
  const [hold] = (await groupOn(device, groupId)).recoveryHolds ?? [];
  if (hold === undefined) throw new Error('Expected a hold.');
  return hold;
}

/** The second number each release in the request mailbox came with, in order. */
function numbersIn(fake: FakeRelay, request: { seed: Uint8Array; secretKey: Uint8Array }) {
  return releasedShares(fake, request.seed, request.secretKey).map((release) => release.number);
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
    const { fake, world, request, code, check, number, ana } = await setUp();
    const { ben, groupId } = world;
    const held = openHeldShare(await groupOn(ben, groupId), ana);

    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
    const received = await alertReceived(ben, groupId);
    const { mailbox } = recoveryChannel(request.seed);

    expect(await passAt(fake, received + HOLD - 1, ben)).toBe(true);
    expect(fake.blobs(mailbox)).toEqual([]);
    expect((await holdOn(ben, groupId)).ended).toBeUndefined();

    expect(await passAt(fake, received + HOLD, ben)).toBe(true);
    const blobs = fake.blobs(mailbox);
    expect(blobs.map((blob) => blob.length)).toEqual([BLOB_SIZES[0]]);
    const [release] = releasedShares(fake, request.seed, request.secretKey);
    if (release === undefined || held === null) throw new Error('Expected the share released.');
    expect({ ...release.share, share: local(release.share.share) }).toEqual({
      ...held,
      share: local(held.share),
    });
    // The second number goes inside, as typed (#398).
    expect(release.number).toBe(number);
    // Its PUT asked the relay to keep it 7 days.
    const put = fake.requests.find((sent) => sent.method === 'PUT' && sent.url.includes(mailbox));
    expect(put?.url).toMatch(/\?ttl_days=7$/);
    const hold = await holdOn(ben, groupId);
    expect(hold.ended?.kind).toBe('sent');
    // It keeps the code and number for a while, so it can go again (#398).
    expect([hold.code, hold.number]).toEqual([code, number]);

    // It goes once: another pass sends nothing more.
    await passAt(fake, received + HOLD + 60, ben);
    expect(fake.blobs(mailbox)).toHaveLength(1);
  });

  it('stops for a cancel from the person’s key, posted at any time before, and not for one from anyone else', async () => {
    const { fake, world, request, code, check, ana, number } = await setUp();
    const { ben, dee, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
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
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
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

  it('stops only the alert whose tag the cancel names: another request still goes', async () => {
    const { fake, world, request, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    const other = newRecoveryKeys();
    const otherCode = recoveryCode(other);
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
    await approveRecovery(ben.services, {
      code: otherCode,
      groupId,
      person: ana,
      check: recoveryCheck(otherCode),
      number: recoveryNumber(other.secretKey),
    });
    const [first] = (await groupOn(ben, groupId)).recoveryHolds ?? [];
    const anaGroup = await groupOn(world.ana, groupId);
    const cancel = signEvent(anaGroup.signingKey, {
      type: 'recovery-cancel',
      group: groupId,
      ts: 0,
      body: { alert: first?.tag ?? '' },
    });
    await world.ana.services.store.enqueue(groupId, cancel.record);
    await world.ana.services.sync.syncOnce();
    const received = Math.max(
      ...foldGroup(await groupOn(ben, groupId)).recoveryAlerts.map((alert) => alert.received),
    );

    await passAt(fake, received + HOLD, ben);
    expect(releasedShares(fake, request.seed, request.secretKey)).toEqual([]);
    expect(releasedShares(fake, other.seed, other.secretKey)).toHaveLength(1);
  });

  it('releases nothing after a failed sync pass, even with the relay taking PUTs, and sends on the next complete one', async () => {
    const { fake, gate, world, request, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
    const received = await alertReceived(ben, groupId);
    const { mailbox } = recoveryChannel(request.seed);

    gate.gets = false;
    expect(await passAt(fake, received + HOLD + 10, ben)).toBe(false);
    expect(fake.blobs(mailbox)).toEqual([]);

    gate.gets = true;
    expect(await passAt(fake, received + HOLD + 11, ben)).toBe(true);
    expect(fake.blobs(mailbox)).toHaveLength(1);
  });

  it('releases nothing after a pass that failed in another group, though this one synced', async () => {
    const { fake, gate, world, request, code, check, number } = await setUp();
    const { cal, allotment, groupId } = world;
    const person = await keyOf(world.ana, allotment);
    await approveRecovery(cal.services, { code, groupId: allotment, person, check, number });
    const received = await alertReceived(cal, allotment);
    const { mailbox } = recoveryChannel(request.seed);
    const until = received + HOLD;

    // Cal's Riverside can't be read; Allotment, where the hold is, syncs at the hold's end.
    gate.blocked = mailboxesAround(await groupOn(cal, groupId), until);
    expect(await passAt(fake, until, cal)).toBe(false);
    expect((await groupOn(cal, allotment)).relayNow).toBe(until);
    expect(fake.blobs(mailbox)).toEqual([]);

    gate.blocked = [];
    expect(await passAt(fake, until, cal)).toBe(true);
    expect(fake.blobs(mailbox)).toHaveLength(1);
  });

  it('puts only blobs the relay takes: the fake refuses any size but #62’s four, as the relay does', async () => {
    const { world, request } = await setUp();
    const { mailbox } = recoveryChannel(request.seed);
    const odd = new Uint8Array(1000);
    await expect(world.ben.services.relay.putBlob(mailbox, odd, 7)).rejects.toThrow(
      'The relay answered 400 (invalid_size).',
    );
  });

  it('refuses a wrong check number, a code that isn’t one, and someone whose share it doesn’t hold, queuing nothing', async () => {
    const { world, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    const before = await groupOn(ben, groupId);
    const wrong = String((Number(check) + 1) % 1_000_000).padStart(6, '0');

    await expect(
      approveRecovery(ben.services, { code, groupId, person: ana, check: wrong, number }),
    ).rejects.toBeInstanceOf(CheckMismatch);
    await expect(
      approveRecovery(ben.services, { code: 'RR1.nope', groupId, person: ana, check, number }),
    ).rejects.toThrow('That isn’t a recovery code.');
    const dee = await keyOf(world.dee, groupId);
    await expect(
      approveRecovery(ben.services, { code, groupId, person: dee, check, number }),
    ).rejects.toThrow('This device holds no share for them.');

    const after = await groupOn(ben, groupId);
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.recoveryHolds).toBeUndefined();
  });

  it('reads as holding soon until the relay has the alert, and stopped once a cancel is seen', async () => {
    const { fake, world, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    fake.offline = true;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
    const status = async () =>
      holdViews(await ben.services.store.listGroups(), () => fake.minute)[0]?.status;
    expect(await status()).toEqual({ kind: 'soon' });

    fake.offline = false;
    await ben.services.sync.syncOnce();
    expect(await status()).toMatchObject({ kind: 'holding' });
    const tag = await holdTag(ben, groupId);
    const anaGroup = await groupOn(world.ana, groupId);
    const cancel = signEvent(anaGroup.signingKey, {
      type: 'recovery-cancel',
      group: groupId,
      ts: 0,
      body: { alert: tag },
    });
    await world.ana.services.store.enqueue(groupId, cancel.record);
    await world.ana.services.sync.syncOnce();
    // Ben's GET brings the cancel; the hold reads stopped at once, as the pass after it ends it.
    await ben.services.sync.syncOnce();
    expect(await status()).toEqual({ kind: 'stopped' });
  });

  it('takes the number with spaces, as it was read out in two groups of three', async () => {
    const { world, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, {
      code: `  ${code}\n`,
      groupId,
      person: ana,
      check: `${check.slice(0, 3)} ${check.slice(3)}`,
      number,
    });
    expect((await groupOn(ben, groupId)).recoveryHolds).toHaveLength(1);
  });

  it('stops, sending nothing, once the person has chosen again since the approval', async () => {
    const { fake, world, request, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
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
    const { fake, world, code, check, ana, number } = await setUp();
    const { ben, groupId } = world;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number });
    const state = foldGroup(await groupOn(ben, groupId));
    expect(state.recoveryAlerts.map((alert) => alert.by)).toEqual([await keyOf(ben, groupId)]);
    const alertBox = state.recoveryAlerts[0]?.box ?? '';
    // The box carries no name, key, code or split in the clear.
    expect(alertBox).not.toContain(ana);
    expect(alertBox).not.toContain(code.slice(4, 20));

    const groups = await ben.services.store.listGroups();
    const received = await alertReceived(ben, groupId);
    const at = (minute: number) => holdViews(groups, () => minute)[0]?.status;
    expect(holdViews(groups, () => 0)[0]).toMatchObject({ groupId, name: 'Ana' });
    expect(at(received + HOLD - 1)).toEqual({ kind: 'holding', until: received + HOLD });
    expect(at(received + HOLD)).toEqual({ kind: 'ready' });
    await passAt(fake, received + HOLD, ben);
    const [sent] = holdViews(await ben.services.store.listGroups(), () => received + HOLD);
    expect(sent?.status).toEqual({ kind: 'sent' });
  });
});

describe('the second number a contact types (#398)', DEVICES, () => {
  it('goes in the release as read out, in two groups of three, and refuses anything but six digits', async () => {
    const { fake, world, request, code, check, number, ana } = await setUp();
    const { ben, dee, groupId } = world;
    for (const typed of ['', '12345', '1234567', '12345a']) {
      await expect(
        approveRecovery(dee.services, { code, groupId, person: ana, check, number: typed }),
        typed,
      ).rejects.toBeInstanceOf(SecondNumberInvalid);
    }
    expect((await groupOn(dee, groupId)).recoveryHolds ?? []).toEqual([]);

    const spoken = `${number.slice(0, 3)} ${number.slice(3)}`;
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number: spoken });
    await passAt(fake, (await alertReceived(ben, groupId)) + HOLD, ben);
    expect(numbersIn(fake, request)).toEqual([number]);
  });

  it('sends a share again with a corrected number while the relay keeps it, then forgets its code', async () => {
    const { fake, world, request, code, check, number, ana } = await setUp();
    const { ben, groupId } = world;
    const wrong = otherThan(number);
    await approveRecovery(ben.services, { code, groupId, person: ana, check, number: wrong });
    const received = await alertReceived(ben, groupId);
    await passAt(fake, received + HOLD, ben);
    const hold = await holdOn(ben, groupId);
    const view = holdViews([await groupOn(ben, groupId)], () => received + HOLD);
    expect(view.map(({ status, number: sent, resend }) => [status.kind, sent, resend])).toEqual([
      ['sent', wrong, true],
    ]);

    await expect(
      resendRelease(ben.services, { groupId, alert: hold.alert, number: '12a456' }),
    ).rejects.toBeInstanceOf(SecondNumberInvalid);
    await resendRelease(ben.services, { groupId, alert: hold.alert, number });
    expect(numbersIn(fake, request)).toEqual([wrong, number]);
    expect((await holdOn(ben, groupId)).number).toBe(number);

    // The relay keeps a release 7 days; after that the code and number go.
    await passAt(fake, received + HOLD + RELEASE_TTL_DAYS * 1440 - 1, ben);
    expect((await holdOn(ben, groupId)).code).toBe(code);
    await passAt(fake, received + HOLD + RELEASE_TTL_DAYS * 1440, ben);
    const forgotten = await holdOn(ben, groupId);
    expect([forgotten.code, forgotten.number, forgotten.ended?.kind]).toEqual([
      undefined,
      undefined,
      'sent',
    ]);
    await expect(
      resendRelease(ben.services, { groupId, alert: hold.alert, number }),
    ).rejects.toThrow();
    expect(holdViews([await groupOn(ben, groupId)], () => 0)[0]?.resend).toBe(false);
  });
});
