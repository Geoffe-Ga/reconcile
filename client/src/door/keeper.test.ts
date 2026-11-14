/**
 * The front door's keeper through real devices on one fake relay (#121): the
 * group opens its door by Proposal, a member's sync posts the page, a stranger
 * applies, an inviter's sync reads the application, Send an invite reaches
 * the applicant, and closing the door, by a steward's narrowing, a vote or a
 * dissolve, posts `{open: false}` and stops the inbox. A membership that ends
 * closes the door for good (#288): every device posts a final page, which no
 * copy the former member forges or replays outranks, and the door reopens
 * only by a new opening Proposal, whose secrets the former member never sees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import {
  APPLICATION_INFO,
  doorChannelsOf,
  doorKeysOf,
  openPadded,
  replyMailboxOf,
  signDoorRecord,
} from '../crypto/door';
import { deriveSealKey } from '../crypto/groupKeys';
import { LEVELS } from '../engine/capabilities';
import { type EventDraft, type RemovalProposalBody, signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { doorIn, type FrontDoor, rulesChangeOf } from '../engine/optIns';
import { createRelay } from '../net/relay';
import { xchachaSeal } from '../crypto/seal';
import type { Group } from '../store/db';
import type { TestDevice } from '../test/appServices';
import { COUNTED, DOOR, ROTATED } from '../test/door';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { testDevice } from '../test/appServices';
import { apply } from './apply';
import { sendInvite } from './inbox';
import { CLOSED, doorsThatStood, pagesDue } from './keeper';
import {
  addressOf,
  encodePage,
  FINAL,
  latestCopy,
  newFrontDoor,
  readDoor,
  REFRESH_MINUTES,
} from './page';

freshIndexedDBPerTest();

/**
 * Each test runs three or four real devices through real crypto on the fake
 * relay, key changes included, which takes longer than the default 5 seconds
 * on a busy machine.
 */
const DEVICES = { timeout: 30_000 };

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

/** The words in the copy of a Document Kim sends (#425), a canary the store is searched for. */
const CANARY = 'canary-425-fair-rents';
const STATEMENT = { title: 'What I stand for', text: `Fair rents for every tenant, ${CANARY}.` };

/** `kim` reads the open door and asks to join as Kim, with a copy of `documents` if any. */
async function applyAt(fake: FakeRelay, kim: TestDevice, documents?: [typeof STATEMENT]) {
  const view = await readDoor(reader(fake), addressOf(DOOR));
  if (view.kind !== 'open') throw new Error('Expected an open door.');
  const outcome = await apply(kim.services, addressOf(DOOR), view.page, {
    name: 'Kim',
    message: 'Hi.',
    ...(documents === undefined ? {} : { documents }),
  });
  expect(outcome).toBe('sent');
}

/** Everything `device`'s store holds of `groupId`'s front door, as JSON: read from the store, not a screen. */
async function heldWords(device: TestDevice | undefined, groupId: string): Promise<string> {
  return JSON.stringify((await device?.services.store.getGroup(groupId))?.door ?? null);
}

/** Each PUT to `kim`'s reply mailbox since request `before`: its query and its blob's size. */
async function replyPuts(fake: FakeRelay, before: number, kim: TestDevice) {
  const [kept] = await kim.services.store.listSent();
  const path = `/v1/mailbox/${replyMailboxOf(kept?.seed ?? new Uint8Array(32))}`;
  return fake.requests
    .slice(before)
    .filter((request) => request.method === 'PUT' && request.url.startsWith(path))
    .map((request) => [request.url.slice(path.length), request.body?.length]);
}

/** A stranger's device on `fake`. */
async function stranger(fake: FakeRelay) {
  const kim = await testDevice(fake, 'kim');
  opened.push(kim);
  return kim;
}

describe('the keeper keeps the page', DEVICES, () => {
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

  it('closes the page at once on a steward’s narrowing, which may reopen it, so not for good', async () => {
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
    expect((await latestCopy(reader(fake), addressOf(DOOR)))?.page).toEqual(FINAL);
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
    expect((await latestCopy(reader(fake), addressOf(DOOR)))?.page).toEqual(FINAL);
  });
});

describe('the keeper reads the inbox, and Send an invite answers', DEVICES, () => {
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

    const before = fake.requests.length;
    expect(await sendInvite({ ...ana.services, makeInvite: make }, groupId, id)).toBe('sent');
    expect(await replyPuts(fake, before, kim)).toEqual([['?ttl_days=2', 1024]]);
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

  it('brings the copy of Kim’s Documents, and each device deletes it once the invite folds (#425)', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const cal = devices[2];
    const kim = await stranger(fake);
    await applyAt(fake, kim, [STATEMENT]);
    const [held] = await inbox(ana, groupId);
    expect(held?.documents).toEqual([STATEMENT]);
    expect((await inbox(ben, groupId))[0]?.documents).toEqual([STATEMENT]);

    expect(await sendInvite({ ...ana.services, makeInvite }, groupId, held?.id ?? '')).toBe('sent');
    // Ana's device deletes it as the invite goes, before any sync.
    expect(await heldWords(ana, groupId)).not.toContain(CANARY);
    await ana.services.sync.syncOnce();
    // Ben's deletes it when it folds the invite; Cal's, which reads it only after, never keeps it.
    expect(await heldWords(ben, groupId)).toContain(CANARY);
    await inbox(ben, groupId);
    expect(await heldWords(ben, groupId)).not.toContain(CANARY);
    expect(await inbox(cal, groupId)).toMatchObject([{ name: 'Kim', message: 'Hi.' }]);
    expect(await heldWords(cal, groupId)).not.toContain(CANARY);
  });

  it('deletes the copy once the invite folds, though the door closed meanwhile (#425)', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const kim = await stranger(fake);
    await applyAt(fake, kim, [STATEMENT]);
    const [held] = await inbox(ana, groupId);
    await inbox(ben, groupId);
    expect(await heldWords(ben, groupId)).toContain(CANARY);
    expect(await sendInvite({ ...ana.services, makeInvite }, groupId, held?.id ?? '')).toBe('sent');
    await ana.services.sync.syncOnce();
    await propose(ana, groupId, false, true);
    await ben.services.sync.syncOnce();
    expect(await heldWords(ben, groupId)).not.toContain(CANARY);
    expect(await heldWords(ben, groupId)).toContain('"name":"Kim"');
  });

  it('deletes the copy once the invite folds, though the inbox can’t be read on that pass (#425)', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const kim = await stranger(fake);
    await applyAt(fake, kim, [STATEMENT]);
    const [held] = await inbox(ana, groupId);
    await inbox(ben, groupId);
    expect(await heldWords(ben, groupId)).toContain(CANARY);
    expect(await sendInvite({ ...ana.services, makeInvite }, groupId, held?.id ?? '')).toBe('sent');
    await ana.services.sync.syncOnce();
    // Ben's sync pulls the invite, but the door's inbox can't be read on that pass.
    const { inbox: mailbox } = doorChannelsOf(addressOf(DOOR));
    const { relay } = ben.services;
    const read = relay.getBlobs.bind(relay);
    const failed = vi
      .spyOn(relay, 'getBlobs')
      .mockImplementation((id, after) =>
        id === mailbox ? Promise.reject(new Error('The relay can’t be reached.')) : read(id, after),
      );
    await ben.services.sync.syncOnce();
    expect(failed.mock.calls.some(([id]) => id === mailbox)).toBe(true);
    expect(await heldWords(ben, groupId)).not.toContain(CANARY);
    failed.mockRestore();
  });

  it('keeps the copy of an application nobody has answered, and leaves a failed invite’s', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const kim = await stranger(fake);
    await applyAt(fake, kim, [STATEMENT]);
    const [held] = await inbox(ana, groupId);
    await ben.services.sync.syncOnce();
    expect(await heldWords(ben, groupId)).toContain(CANARY);
    fake.offline = true;
    expect(await sendInvite({ ...ana.services, makeInvite }, groupId, held?.id ?? '')).toBe(
      'failed',
    );
    expect(await heldWords(ana, groupId)).toContain(CANARY);
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

describe('the keeper beside a removal (#115)', DEVICES, () => {
  /** The PUTs to the open door's page mailbox since request `before`. */
  function pagePuts(fake: FakeRelay, before: number) {
    const page = doorChannelsOf(addressOf(DOOR)).page;
    return fake.requests
      .slice(before)
      .filter((request) => request.method === 'PUT' && request.url.includes(page));
  }

  /** Ben proposes removing Cal, and Ana and Ben pass it with 4s, closing it early. */
  async function removeCal(devices: readonly TestDevice[], groupId: string, cals: string) {
    const [ana, ben] = present(devices);
    const target = { kind: 'remove' as const, member: cals };
    const body: RemovalProposalBody = { target, title: 'Remove Cal', why: 'Threats.' };
    const removal = await post(ben, groupId, { type: 'proposal', body });
    for (const device of [ana, ben]) {
      const scores = { [removal]: 4 as const };
      await post(device, groupId, { type: 'vote', body: { proposal: removal, scores } });
    }
  }

  it('posts no page for the person a passed removal names, and their removed copy keeps no applications', async () => {
    const { fake, groupId, devices } = await openGroup();
    const cal = devices[2];
    if (cal === undefined) throw new Error('Expected Cal.');
    const { store } = cal.services;
    await applyAt(fake, await stranger(fake));
    expect(await inbox(cal, groupId)).toHaveLength(1);
    await removeCal(devices, groupId, (await store.getGroup(groupId))?.me.author ?? '');
    // Cal's device sees the pass before any remove has landed, once the page has come due.
    fake.minute += REFRESH_MINUTES;
    const before = fake.requests.length;
    await cal.services.sync.syncOnce();
    expect((await store.getGroup(groupId))?.archived).toBeUndefined();
    expect(pagePuts(fake, before)).toEqual([]);

    for (const device of devices) await device.services.sync.syncOnce();
    const archived = await store.getGroup(groupId);
    expect(archived?.archived).toEqual({ reason: 'removed' });
    expect(archived?.door).toBeUndefined();
    // The remove ended Cal's membership, so the group's own devices closed the door for good (#288).
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
    expect((await latestCopy(reader(fake), addressOf(DOOR)))?.page).toEqual(FINAL);
  });
});

describe('the keeper once a membership ends (#288)', DEVICES, () => {
  /** Every request to the open door's inbox so far. */
  function inboxReads(fake: FakeRelay, door: FrontDoor = DOOR) {
    const { inbox } = doorChannelsOf(addressOf(door));
    return fake.requests.filter((request) => request.url.includes(inbox)).length;
  }

  /** Cal's device leaves, then everyone else's syncs until the key has changed past him. */
  async function calLeaves(devices: readonly TestDevice[], groupId: string): Promise<Group> {
    const [ana, ben] = present(devices);
    const cal = devices[2];
    // What Cal's device holds as he goes: a former member keeps all of it.
    const held = await cal?.services.store.getGroup(groupId);
    if (cal === undefined || held === undefined) throw new Error('Expected Cal’s copy.');
    // As Leave does (#77): the leave queued and the group marked leaving in one store change.
    const leave = signEvent(held.signingKey, { type: 'leave', group: groupId, ts: 0, body: {} });
    await cal.services.store.markLeaving(groupId, leave.record);
    await cal.services.sync.syncOnce();
    for (let pass = 0; pass < 3; pass += 1) {
      for (const device of [ana, ben]) await device.services.sync.syncOnce();
    }
    const group = await ana.services.store.getGroup(groupId);
    expect(group?.epoch).toBe(1);
    return held;
  }

  /** A copy of the page signed with `door`'s own key, as anyone holding its `sign` can make. */
  async function postSigned(
    fake: FakeRelay,
    door: FrontDoor,
    page: Parameters<typeof encodePage>[0],
  ) {
    const address = addressOf(door);
    const { page: mailbox, pageKey } = doorChannelsOf(address);
    const keys = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box)).signing;
    const record = signDoorRecord(keys, encodePage(page));
    await createRelay({ fetch: fake.fetch }).putBlob(
      mailbox,
      xchachaSeal.seal(mailbox, pageKey, record),
    );
  }

  it('closes the door for good on every device, reads its inbox no more, and keeps what it read', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    await applyAt(fake, await stranger(fake));
    expect(await inbox(ana, groupId)).toHaveLength(1);
    await calLeaves(devices, groupId);

    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
    expect((await latestCopy(reader(fake), addressOf(DOOR)))?.page).toEqual(FINAL);
    const reads = inboxReads(fake);
    for (const device of [ana, ben]) await device.services.sync.syncOnce();
    expect(inboxReads(fake)).toBe(reads);
    // Applications already read stay on the device as they were.
    const kept = await ana.services.store.getGroup(groupId);
    expect(kept?.door?.applications).toMatchObject([{ name: 'Kim', message: 'Hi.' }]);
  });

  it('lets no copy the former member forges with the door’s key, or replays, reopen the old link (#277)', async () => {
    const { fake, groupId, devices } = await openGroup();
    const { page: mailbox } = doorChannelsOf(addressOf(DOOR));
    const [genuine] = fake.blobs(mailbox);
    await calLeaves(devices, groupId);

    // Cal still holds DOOR's secrets: he signs an open page naming a box of his own, and replays the old one.
    const forged = { v: 1, open: true, name: 'Riverside Tenants', excerpt: 'Come in.' } as const;
    await postSigned(fake, DOOR, { ...forged, box: base64url(new Uint8Array(32).fill(0x66)) });
    await createRelay({ fetch: fake.fetch }).putBlob(mailbox, Uint8Array.from(genuine ?? []));
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
  });

  it('keeps the final copy posted while the group goes on', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana] = present(devices);
    await calLeaves(devices, groupId);
    const first = await latestCopy(reader(fake), addressOf(DOOR));
    fake.minute += REFRESH_MINUTES;
    await ana.services.sync.syncOnce();
    const second = await latestCopy(reader(fake), addressOf(DOOR));
    expect(first?.page).toEqual(FINAL);
    expect(second).toMatchObject({
      page: FINAL,
      received: (first?.received ?? 0) + REFRESH_MINUTES,
    });
  });

  it('reopens only by a new opening Proposal, at a new link, and the former member’s keys open none of its applications', async () => {
    const { fake, groupId, devices } = await openGroup();
    const [ana, ben] = present(devices);
    const held = await calLeaves(devices, groupId);
    const fresh = newFrontDoor(false);
    const reopen = await propose(ana, groupId, fresh);
    await everyoneVotes([ana, ben], groupId, reopen);
    expect(await readDoor(reader(fake), addressOf(DOOR))).toEqual({ kind: 'closed' });
    const view = await readDoor(reader(fake), addressOf(fresh));
    if (view.kind !== 'open') throw new Error('Expected the new door open.');

    const kim = await stranger(fake);
    await apply(kim.services, addressOf(fresh), view.page, { name: 'Kim', message: 'Hi again.' });
    expect(await inbox(ana, groupId)).toMatchObject([{ name: 'Kim', message: 'Hi again.' }]);

    // Every secret Cal's copy holds: the group's key, his own keys, and each door his log ever carried.
    const carried = fold(held.log, held.relayNow).proposals.flatMap((proposal) => {
      const door = doorIn(rulesChangeOf(proposal));
      return door === null ? [] : [door.sign, door.box];
    });
    expect(carried).toEqual([DOOR.sign, DOOR.box]);
    const keys = [...carried.map(fromBase64url), held.secret, held.signingKey, held.kxKey];
    const { inbox: mailbox } = doorChannelsOf(addressOf(fresh));
    const [application] = fake.blobs(mailbox);
    if (application === undefined) throw new Error('Expected the application on the relay.');
    for (const key of keys) {
      expect(
        openPadded(key ?? new Uint8Array(32), application, APPLICATION_INFO, mailbox),
      ).toBeNull();
    }
    // The control: the new door's own box opens it.
    expect(
      openPadded(fromBase64url(fresh.box), application, APPLICATION_INFO, mailbox),
    ).not.toBeNull();

    // Nothing on the relay that Cal's group key opens carries the new door's secrets; the old door's
    // do turn up, so the scan reads what it opens.
    const sealKey = deriveSealKey(held.secret);
    const named = new Set(
      fake.requests.map((request) => /mailbox\/([\w-]{43})/.exec(request.url)?.[1]),
    );
    const texts = [...named].flatMap((box) =>
      box === undefined
        ? []
        : fake.blobs(box).flatMap((blob) => {
            const record = xchachaSeal.open(box, sealKey, blob);
            return record === null ? [] : [new TextDecoder().decode(record)];
          }),
    );
    expect(texts.some((text) => text.includes(DOOR.sign))).toBe(true);
    expect(texts.filter((text) => text.includes(fresh.sign) || text.includes(fresh.box))).toEqual(
      [],
    );
  });
});

describe('doorsThatStood and pagesDue', DEVICES, () => {
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
    // A door rotated away never opens again, so its page closes it for good (#288).
    expect(due[1]?.[1]).toEqual(FINAL);
    expect(base64url(addressOf(ROTATED))).not.toBe(base64url(addressOf(DOOR)));
  });
});
