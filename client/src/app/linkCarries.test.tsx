/**
 * What a link carries to a second device, and what it leaves on the first
 * (#96 with #98, #108, #93 and #99), through the real actions and sync loop
 * on devices sharing one fake relay:
 *
 * - **Key epochs (#98).** The bundle is a format 2 snapshot, so the laptop
 *   lands at the group's current epoch with the phone's secret and encryption
 *   key, posts no `kx` of its own (it is the same member, and the fold took
 *   the member's key already), and opens the wrap of the next key change.
 * - **Dissolve (#108).** A read-only archive stays on the phone and out of
 *   the bundle, as it stays out of a backup file.
 * - **Personal Documents (#93)** travel in the bundle.
 * - **Push (#99).** A registration belongs to one device, so the laptop starts
 *   with push off, and its own switch in Settings registers its own endpoint.
 * - **The relay backup (#97).** Its key rides in the bundle, and the laptop
 *   keeps it unless it holds one of its own, so its first complete pass keeps
 *   the same backup fresh.
 * - **Shares by link (#105).** A share belongs to the device that made it,
 *   since personal Documents don't sync, so the bundle leaves it out
 *   (`withoutShares`): the laptop gets the Document unshared, posts nothing
 *   for the phone's link, and can make its own; the phone keeps its share and
 *   alone can stop it.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { kxPublicKeyOf } from '../crypto/box';
import { base64url } from '../crypto/base64url';
import { backupIdFor } from '../crypto/relayBackup';
import { parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { type Group, openStore } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { mailboxAt } from '../store/mailbox';
import type { PersonalDocument } from '../store/personal';
import { startRelayBackup } from '../store/relayBackup';
import type { TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { fakeEndpoint } from '../test/fakePush';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { testKeys } from '../test/keys';
import { linkDevice } from '../test/link';
import { keepSharesAlive, readShare, type ShareLink, startSharing } from '../share/shareLink';
import { FOUNDING, go, members, type MountedApp, mountApp } from '../test/members';
import { groupLog } from '../test/votes';
import { leaveGroup } from './actions';

freshIndexedDBPerTest();

const opened: TestDevice[] = [];
const mounted: MountedApp[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** `names` in one group on `fake`, every device synced; the first device is Ana's phone. */
async function phoneIn(fake: FakeRelay, names: readonly string[]) {
  const made = await members(fake, names);
  opened.push(...made.devices);
  const [phone] = made.devices;
  if (phone === undefined) throw new Error('Expected Ana’s phone.');
  return { phone, groupId: made.groupId, devices: made.devices };
}

/** Links Ana's laptop to `phone`, and keeps it to close after the test. */
async function laptopOf(fake: FakeRelay, phone: TestDevice): Promise<TestDevice> {
  const laptop = await linkDevice(fake, phone, 'ana-laptop');
  opened.push(laptop);
  return laptop;
}

/** The group as `device` holds it. */
async function held(device: TestDevice, groupId: string): Promise<Group> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on the device.');
  return group;
}

/** Every `kx` event in `group`'s log, as its author and the key it gives. */
function kxEvents(group: Group): { author: string; kx: unknown }[] {
  return group.log.flatMap(({ bytes }) => {
    const parsed = parseRecord(bytes);
    if (parsed?.event.type !== 'kx') return [];
    const { author, body } = parsed.event;
    return [{ author, kx: (body as { kx?: unknown }).kx }];
  });
}

/** `name` leaves on their own device, which then syncs, so their leave is on the relay. */
async function leaves(device: TestDevice, groupId: string): Promise<void> {
  await leaveGroup(device.services, groupId);
  await device.services.sync.syncOnce();
}

describe('a link after a key change (#96, #98)', () => {
  it('lands at the group’s epoch with the phone’s keys, posts no kx, and opens the next key change', async () => {
    const fake = createFakeRelay();
    const { phone, groupId, devices } = await phoneIn(fake, ['Ana', 'Ben', 'Cal']);
    const [, ben, cal] = devices;
    if (ben === undefined || cal === undefined) throw new Error('Expected Ben and Cal.');
    await leaves(cal, groupId);
    await phone.services.sync.syncOnce();
    const onPhone = await held(phone, groupId);
    expect(onPhone.epoch).toBe(1);

    const laptop = await laptopOf(fake, phone);
    const linked = await held(laptop, groupId);

    expect(linked.epoch).toBe(1);
    expect(local(linked.secret)).toEqual(local(onPhone.secret));
    expect(local(linked.kxKey ?? new Uint8Array())).toEqual(
      local(onPhone.kxKey ?? new Uint8Array(1)),
    );
    expect(linked.log.map((record) => [record.seq, record.epoch ?? 0])).toEqual(
      onPhone.log.map((record) => [record.seq, record.epoch ?? 0]),
    );

    const before = fake.requests.length;
    await laptop.services.sync.syncOnce();
    const synced = await held(laptop, groupId);
    // Same member, key already in the fold: nothing to post, no kx queued or sent.
    expect(synced.outbox).toEqual([]);
    expect(fake.requests.slice(before).filter((request) => request.method === 'PUT')).toEqual([]);
    const me = fold(synced.log, synced.relayNow).members.find(
      (member) => member.author === synced.me.author,
    );
    expect(me?.kx).toBe(base64url(kxPublicKeyOf(onPhone.kxKey ?? new Uint8Array(32))));
    expect(kxEvents(synced)).toEqual([]);

    // Ben, at epoch 1 too, leaves: the phone writes epoch 2's key, wrapped to the member's one key.
    await ben.services.sync.syncOnce();
    await leaves(ben, groupId);
    await phone.services.sync.syncOnce();
    await laptop.services.sync.syncOnce();
    const [phoneNow, laptopNow] = [await held(phone, groupId), await held(laptop, groupId)];
    expect([phoneNow.epoch, laptopNow.epoch]).toEqual([2, 2]);
    expect(local(laptopNow.secret)).toEqual(local(phoneNow.secret));
    expect(kxEvents(laptopNow)).toEqual([]);
    const state = fold(laptopNow.log, laptopNow.relayNow);
    expect([state.epoch, state.members.map((member) => member.name)]).toEqual([2, ['Ana']]);
  });
});

/**
 * A group that dissolved, as Ana's phone keeps it read-only (#108): founded
 * with Ben and Cal, dissolved by a passed Proposal, and marked archived.
 */
async function keepDissolved(phone: TestDevice): Promise<string> {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const motion = log.proposeDissolve('ana', false);
  for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
  log.minute += 1;
  log.dissolve('ana', motion);
  const { store } = phone.services;
  const { secretKey, author } = testKeys('ana');
  const secret = new Uint8Array(32).fill(5);
  await store.addGroup({
    groupId: log.group,
    secret,
    signingKey: secretKey,
    me: { author, name: 'Ana' },
  });
  const pull = {
    records: [...log.records],
    cursor: log.records.length,
    relayNow: log.minute + 5,
    instance: 'relay-1',
    lastSyncAt: 1_762_000_000_000,
  };
  await store.applyPull(log.group, pull, eventIdOf);
  await store.markArchived(log.group, 'dissolved');
  return log.group;
}

describe('a link from a phone that keeps a dissolved group (#96, #108)', () => {
  it('leaves the read-only copy on the phone and out of the bundle, as a backup file does', async () => {
    const fake = createFakeRelay();
    const { phone, groupId } = await phoneIn(fake, ['Ana']);
    const dissolvedId = await keepDissolved(phone);
    const archived = await held(phone, dissolvedId);

    const laptop = await laptopOf(fake, phone);

    expect((await laptop.services.store.listGroups()).map((group) => group.groupId)).toEqual([
      groupId,
    ]);
    expect(await laptop.services.store.getGroup(dissolvedId)).toBeUndefined();
    expect(await held(phone, dissolvedId)).toEqual(archived);
  });
});

/** Two personal Documents, as Personal saves them (#93). */
const STATEMENTS: readonly PersonalDocument[] = [
  {
    id: 'TGlua2VkIHN0YXRlbWVudA',
    title: 'What I stand for',
    text: '# I show up for my neighbors.\n',
    createdAt: 1_762_000_400_000,
    updatedAt: 1_762_000_500_000,
  },
  {
    id: 'U2Vjb25kIHN0YXRlbWVudA',
    title: 'Reading list',
    text: 'Books to share.\n',
    createdAt: 1_762_000_600_000,
    updatedAt: 1_762_000_600_000,
  },
];

describe('personal Documents in a link (#96, #93)', () => {
  it('bring every personal Document across, whole, beside the groups', async () => {
    const fake = createFakeRelay();
    const { phone, groupId } = await phoneIn(fake, ['Ana']);
    for (const document of STATEMENTS) await phone.services.store.savePersonal(document);

    const laptop = await laptopOf(fake, phone);

    expect(await laptop.services.store.listPersonal()).toEqual(STATEMENTS);
    expect((await laptop.services.store.listGroups()).map((group) => group.groupId)).toEqual([
      groupId,
    ]);
    expect(await phone.services.store.listPersonal()).toEqual(STATEMENTS);
  });
});

describe('push on a linked device (#96, #99)', () => {
  it('starts with push off, leaves the phone’s registration alone, and turns on with its own switch', async () => {
    const fake = createFakeRelay();
    const { phone, groupId } = await phoneIn(fake, ['Ana', 'Ben']);
    phone.push.answer = 'granted';
    expect(await phone.services.push.turnOn(groupId)).toBe('on');
    await phone.services.sync.syncOnce();
    const phonePush = (await held(phone, groupId)).push;
    const mailbox = mailboxAt(await held(phone, groupId), 0);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);

    const laptop = await laptopOf(fake, phone);
    await laptop.services.sync.syncOnce();

    const linked = await held(laptop, groupId);
    expect([linked.push, linked.nudged]).toEqual([undefined, undefined]);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);

    const laptopEndpoint = 'https://fcm.googleapis.com/fcm/send/laptop-1';
    laptop.push.endpointOf = () => laptopEndpoint;
    laptop.push.answer = 'granted';
    go('#/settings');
    const app = mountApp(laptop.services, 'laptop');
    mounted.push(app);
    const section = await within(app.container).findByRole('region', { name: 'Notifications' });
    const toggle = within(section).getByRole('switch', {
      name: `Notify me about ${FOUNDING.groupName}`,
    });
    expect(toggle).not.toBeChecked();

    await userEvent.setup().click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect((await held(laptop, groupId)).push?.endpoint).toBe(laptopEndpoint);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1), laptopEndpoint]);
    expect((await held(phone, groupId)).push).toEqual(phonePush);
  });
});

/** The backup PUTs the fake relay took for `id`. */
function backupPuts(fake: FakeRelay, id: string): number {
  return fake.requests.filter(
    (request) => request.method === 'PUT' && request.url === `/v1/backup/${id}`,
  ).length;
}

/** The relay backup key `device` keeps. */
async function backupKeyOf(device: TestDevice): Promise<Uint8Array> {
  const state = await device.services.store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

describe('the relay backup key in a link (#96, #97)', () => {
  it('gives the laptop the phone’s key, whose first complete pass keeps the same backup fresh', async () => {
    const fake = createFakeRelay();
    const { phone } = await phoneIn(fake, ['Ana']);
    await startRelayBackup(phone.services);
    const key = await backupKeyOf(phone);
    const id = backupIdFor(key);
    expect(backupPuts(fake, id)).toBe(1);

    const laptop = await laptopOf(fake, phone);

    expect(await backupKeyOf(laptop)).toEqual(key);
    // Nothing of the phone's upload record comes along: the laptop uploads on its own schedule.
    expect(await laptop.services.store.getRelayBackup()).toMatchObject({
      digest: null,
      checkedDay: null,
      uploadedAt: null,
    });
    expect(await laptop.services.sync.syncOnce()).toBe(true);
    expect(backupPuts(fake, id)).toBe(2);
    expect((await laptop.services.store.getRelayBackup())?.uploadedAt).not.toBeNull();
  });

  it('keeps the laptop’s own key when it already holds one', async () => {
    const fake = createFakeRelay();
    const { phone } = await phoneIn(fake, ['Ana']);
    await startRelayBackup(phone.services);
    const own = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
    const before = await openStore('ana-laptop');
    await before.setRelayBackupKey(own);
    before.close();

    const laptop = await laptopOf(fake, phone);

    expect(await backupKeyOf(laptop)).toEqual(own);
    expect(await backupKeyOf(phone)).not.toEqual(own);
  });
});

/** Shares Document `id` on `device` by link (#105), and hands back the link. */
async function shared(device: TestDevice, id: string): Promise<ShareLink> {
  const outcome = await startSharing(device.services, id);
  if (outcome.kind !== 'shared') throw new Error(`Expected a share, not ${outcome.kind}.`);
  return outcome.link;
}

describe('a share by link in a link (#96, #105)', () => {
  it('gives the laptop the Document with no share, and leaves the phone’s share and link as they were', async () => {
    const fake = createFakeRelay();
    const { phone } = await phoneIn(fake, ['Ana']);
    const [statement, other] = STATEMENTS;
    if (statement === undefined || other === undefined) throw new Error('Expected two Documents.');
    for (const document of STATEMENTS) await phone.services.store.savePersonal(document);
    const link = await shared(phone, statement.id);
    await startRelayBackup(phone.services);
    const phoneShare = (await phone.services.store.getPersonal(statement.id))?.share;
    expect(phoneShare).toBeDefined();

    const laptop = await laptopOf(fake, phone);

    // The laptop's copy holds the words alone: no seed, keys, n, or post times.
    const onLaptop = await laptop.services.store.getPersonal(statement.id);
    expect(onLaptop).toEqual(statement);
    expect(onLaptop).not.toHaveProperty('share');
    expect(await laptop.services.store.listPersonal()).toEqual(STATEMENTS);
    // Leaving the share out keeps the rest of the bundle: the relay backup key (#97) came too.
    expect(await backupKeyOf(laptop)).toEqual(await backupKeyOf(phone));
    // The phone keeps its share, untouched, and its link still reads.
    expect((await phone.services.store.getPersonal(statement.id))?.share).toEqual(phoneShare);
    expect(await readShare(phone.services, link)).toEqual({
      kind: 'shown',
      title: statement.title,
      text: statement.text,
    });

    // The laptop has nothing to keep alive, so it never posts to the phone's link.
    const before = fake.requests.length;
    expect(await keepSharesAlive(laptop.services)).toEqual([]);
    expect(fake.requests.slice(before)).toEqual([]);

    // Its own Share link makes a link of its own, under a fresh seed and key.
    const own = await shared(laptop, statement.id);
    expect(local(own.seed)).not.toEqual(local(link.seed));
    expect(local(own.publicKey)).not.toEqual(local(link.publicKey));
    expect((await phone.services.store.getPersonal(statement.id))?.share).toEqual(phoneShare);
  });
});
