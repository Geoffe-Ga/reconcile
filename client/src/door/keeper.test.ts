/**
 * The front door's keeper through real devices on one fake relay (#121): the
 * group opens its door by Proposal, a member's sync posts the page, a stranger
 * applies, an inviter's sync reads the application, Send an invite reaches
 * the applicant, and closing the door, by a steward's narrowing, a vote or a
 * dissolve, posts `{open: false}` and stops the inbox.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { doorChannelsOf } from '../crypto/door';
import { LEVELS } from '../engine/capabilities';
import { type EventDraft, signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { createRelay } from '../net/relay';
import { xchachaSeal } from '../crypto/seal';
import type { TestDevice } from '../test/appServices';
import { COUNTED, DOOR, ROTATED } from '../test/door';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { testDevice } from '../test/appServices';
import { apply } from './apply';
import { sendInvite } from './inbox';
import { CLOSED, doorsThatStood, pagesDue } from './keeper';
import { addressOf, latestCopy, readDoor, REFRESH_MINUTES } from './page';

freshIndexedDBPerTest();

/** The follower level, which reads but doesn't invite, by place. */
const [FOLLOWING] = LEVELS;

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

/** What `post` signs: an event's type and body, as the engine takes them. */
type Posted = Pick<EventDraft, 'type' | 'body'>;

/** `device` signs one event in `groupId` with its membership's key, queues and syncs it; returns its id. */
async function post(device: TestDevice | undefined, groupId: string, event: Posted) {
  const group = await device?.services.store.getGroup(groupId);
  if (device === undefined || group === undefined) throw new Error('Expected a member’s device.');
  const draft = { ...event, group: groupId, ts: 0 } as EventDraft;
  const { record, id } = signEvent(group.signingKey, draft);
  await device.services.store.enqueue(groupId, record);
  await device.services.sync.syncOnce();
  return id;
}

/** Each device scores `proposalId` 4, then every device syncs. */
async function everyoneVotes(devices: readonly TestDevice[], groupId: string, proposalId: string) {
  for (const device of devices) {
    const body = { proposal: proposalId, scores: { [proposalId]: 4 as const } };
    await post(device, groupId, { type: 'vote', body });
  }
  for (const device of devices) await device.services.sync.syncOnce();
}

/** `device` proposes setting the door to `value`, narrowing it at once when `narrow`. */
async function propose(
  device: TestDevice | undefined,
  groupId: string,
  value: unknown,
  narrow = false,
) {
  const target = { kind: 'rules' as const, optIn: 'frontDoor', value };
  const body = { target, title: 'The front door', why: 'We talked it over.' };
  const proposal = await post(device, groupId, { type: 'proposal', body });
  if (narrow) {
    await post(device, groupId, { type: 'narrow', body: { optIn: 'frontDoor', proposal } });
  }
  return proposal;
}

/** Copy invite link, as far as an applicant can tell: a link naming a fresh invite's seed. */
const makeInvite = () =>
  Promise.resolve(`https://reconcile.test/#join/${base64url(new Uint8Array(32).fill(9))}`);

/** Ana, Ben and Cal (`levels` by name), with the front door open as `door`. */
async function openGroup(door = DOOR, levels: Record<string, (typeof LEVELS)[number]> = {}) {
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Cal'], null, levels);
  opened.push(...devices);
  const proposalId = await propose(devices[0], groupId, door);
  await everyoneVotes(devices, groupId, proposalId);
  return { fake, groupId, devices };
}

/** A reader on `fake`: the relay and the seal, nothing else. */
function reader(fake: FakeRelay) {
  return { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
}

/** Ana and Ben's devices, the first two of `devices`. */
function present(devices: readonly TestDevice[]): [TestDevice, TestDevice] {
  const [ana, ben] = devices;
  if (ana === undefined || ben === undefined) throw new Error('Expected Ana and Ben.');
  return [ana, ben];
}

/** `device` syncs, then reads the applications its store holds for `groupId`. */
async function inbox(device: TestDevice | undefined, groupId: string) {
  await device?.services.sync.syncOnce();
  return (await device?.services.store.getGroup(groupId))?.door?.applications ?? [];
}

/** `kim` reads the open door and asks to join as Kim. */
async function applyAt(fake: FakeRelay, kim: TestDevice): Promise<void> {
  const view = await readDoor(reader(fake), addressOf(DOOR));
  if (view.kind !== 'open') throw new Error('Expected an open door.');
  const outcome = await apply(kim.services, addressOf(DOOR), view.page, {
    name: 'Kim',
    message: 'Hi.',
  });
  expect(outcome).toBe('sent');
}

/** A stranger's device on `fake`. */
async function stranger(fake: FakeRelay) {
  const kim = await testDevice(fake, 'kim');
  opened.push(kim);
  return kim;
}

describe('the keeper keeps the page', () => {
  it('posts the open page once the opening passes, and reads it as anyone with the link does', async () => {
    const { fake, devices } = await openGroup(COUNTED);
    const view = await readDoor(reader(fake), addressOf(COUNTED));
    expect(view).toMatchObject({
      kind: 'open',
      page: { name: 'Riverside Tenants', excerpt: 'Quiet hours start at ten.', count: 3 },
    });
    // Every device that synced found it current, so the page went once.
    const puts = fake.requests.filter(
      (request) =>
        request.method === 'PUT' && request.url.includes(doorChannelsOf(addressOf(COUNTED)).page),
    );
    expect(puts).toHaveLength(1);
    for (const device of devices) await device.services.sync.syncOnce();
    expect(
      fake.requests.filter(
        (request) =>
          request.method === 'PUT' && request.url.includes(doorChannelsOf(addressOf(COUNTED)).page),
      ),
    ).toHaveLength(1);
  });

  it('posts a fresh copy once the newest is 7 days old', async () => {
    const { fake, devices } = await openGroup();
    const [ana] = devices;
    const first = await latestCopy(reader(fake), addressOf(DOOR));
    fake.minute += REFRESH_MINUTES;
    await ana?.services.sync.syncOnce();
    const second = await latestCopy(reader(fake), addressOf(DOOR));
    expect(second?.received).toBe((first?.received ?? 0) + REFRESH_MINUTES);
  });

  it('closes the page at once on a steward’s narrowing, and the old door when the keys rotate', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana] = devices;
    await propose(ana, groupId, false, true);
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
    expect((await latestCopy(reader(fake), addressOf(DOOR)))?.page).toEqual(CLOSED);
  });

  it('moves the page to the new address when the keys rotate, and closes the old one', async () => {
    const { fake, groupId, devices } = await openGroup();
    const rotate = await propose(devices[1], groupId, ROTATED);
    await everyoneVotes(devices, groupId, rotate);
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
    expect(await readDoor(reader(fake), addressOf(ROTATED))).toMatchObject({ kind: 'open' });
  });

  it('closes the page when the group dissolves (#108)', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    const target = { kind: 'dissolve' as const, wipe: false };
    const body = { target, title: 'Dissolve', why: 'We all moved out.' };
    const proposal = await post(ana, groupId, { type: 'proposal', body });
    await everyoneVotes(devices, groupId, proposal);
    for (const device of devices) await device.services.sync.syncOnce();
    const group = await ana.services.store.getGroup(groupId);
    expect(group?.archived).toEqual({ reason: 'dissolved' });
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
  });
});

describe('the keeper reads the inbox, and Send an invite answers', () => {
  it('brings a stranger’s application to every inviter', async () => {
    const { fake, groupId, devices } = await openGroup();
    const kim = await stranger(fake);
    await applyAt(fake, kim);

    const [ana, ben] = await Promise.all(
      devices.slice(0, 2).map((device) => inbox(device, groupId)),
    );
    expect(ana).toMatchObject([{ name: 'Kim', message: 'Hi.' }]);
    expect(ben).toHaveLength(1);
    const [sent] = await kim.services.store.listSent();
    expect(ana?.[0]?.id).toBe(sent?.id);
  });

  it('sends the invite back to the stranger, records it, and refuses a second', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const kim = await stranger(fake);
    await applyAt(fake, kim);
    const id = (await inbox(ana, groupId))[0]?.id ?? '';
    const make = makeInvite;

    expect(await sendInvite({ ...ana.services, makeInvite: make }, groupId, id)).toBe('sent');
    await ana.services.sync.syncOnce();
    const group = await ana.services.store.getGroup(groupId);
    expect(fold(group?.log ?? [], null).doorInvites).toMatchObject([{ application: id }]);
    // Once Ben's device has it, a second invite for it is refused before anything is sent.
    await inbox(ben, groupId);
    expect(await sendInvite({ ...ben.services, makeInvite: make }, groupId, id)).toBe('missing');

    await kim.services.sync.syncOnce();
    const [answered] = await kim.services.store.listSent();
    expect(answered?.invite).toHaveLength(32);
  });

  it('reads no inbox for a member who can’t invite, nor once the door has closed', async () => {
    const { fake, groupId, devices } = await openGroup(DOOR, { Cal: FOLLOWING });
    const [ana, , cal] = devices;
    await cal?.services.sync.syncOnce();
    const { inbox } = doorChannelsOf(addressOf(DOOR));
    expect((await cal?.services.store.getGroup(groupId))?.door).toBeUndefined();
    await propose(ana, groupId, false, true);
    const before = fake.requests.filter((request) => request.url.includes(inbox)).length;
    for (const device of devices) await device.services.sync.syncOnce();
    expect(fake.requests.filter((request) => request.url.includes(inbox))).toHaveLength(before);
  });

  it('refuses Send an invite while offline, queueing nothing', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    const kim = await stranger(fake);
    const view = await readDoor(reader(fake), addressOf(DOOR));
    if (view.kind !== 'open') throw new Error('Expected an open door.');
    await apply(kim.services, addressOf(DOOR), view.page, { name: 'Kim', message: 'Hi.' });
    await ana.services.sync.syncOnce();
    const [held] = (await ana.services.store.getGroup(groupId))?.door?.applications ?? [];
    fake.offline = true;
    const make = makeInvite;
    expect(await sendInvite({ ...ana.services, makeInvite: make }, groupId, held?.id ?? '')).toBe(
      'failed',
    );
    expect((await ana.services.store.getGroup(groupId))?.outbox).toEqual([]);
    expect(await sendInvite({ ...ana.services, makeInvite: make }, groupId, 'nobody')).toBe(
      'missing',
    );
  });
});

describe('doorsThatStood and pagesDue', () => {
  it('list each door that passed once by its key, and close every one but the open door', async () => {
    const { groupId, devices } = await openGroup();
    const rotate = await propose(devices[0], groupId, ROTATED);
    await everyoneVotes(devices, groupId, rotate);
    const group = await devices[0]?.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    expect(doorsThatStood(state).map((door) => door.sign)).toEqual([DOOR.sign, ROTATED.sign]);
    const due = pagesDue(state, (text) => text);
    expect(due.map(([door, page]) => [door.sign, page.open])).toEqual([
      [ROTATED.sign, true],
      [DOOR.sign, false],
    ]);
    expect(base64url(addressOf(ROTATED))).not.toBe(base64url(addressOf(DOOR)));
  });
});
