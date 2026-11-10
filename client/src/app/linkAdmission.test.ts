/**
 * A linked device is the same person (#96 with #101's admission): it holds
 * the member's own signing key and posts no `join`, so it takes no place in
 * the bootstrap, and a vouch from each of one person's devices counts once.
 * Through the real actions, on devices sharing one fake relay.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { parseLinkCode } from '../crypto/link';
import { bootstrapOpen, vouchesFor } from '../engine/admission';
import { fold } from '../engine/fold';
import { joinLink, offerLink } from '../link/session';
import { testDevice, type TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { joinLater, members } from '../test/members';
import { vouch } from './proposals';

freshIndexedDBPerTest();

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

/** Links a fresh device to `from`, through the whole handshake, and syncs it. */
async function linkFrom(fake: FakeRelay, from: TestDevice, name: string): Promise<TestDevice> {
  const to = await testDevice(fake, name);
  opened.push(to);
  const offer = offerLink(from.services);
  const code = parseLinkCode(offer.code);
  if (code === null) throw new Error('Expected a code.');
  const join = await joinLink(to.services, code);
  await offer.poll();
  await join.poll();
  expect(await offer.confirm()).toBe('sent');
  expect((await join.poll()).kind).toBe('linked');
  await to.services.sync.syncOnce();
  return to;
}

/** The group as `device` folds it, and this device's own membership in it. */
async function heldBy(device: TestDevice, groupId: string) {
  await device.services.sync.syncOnce();
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on the device.');
  return { group, state: fold(group.log, group.relayNow) };
}

describe('a linked device and admission', () => {
  it('is the same member, posts no join, and takes no place in the bootstrap', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana', 'Ben']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    const before = await heldBy(ana, made.groupId);

    const laptop = await linkFrom(fake, ana, 'ana-laptop');
    const onLaptop = await heldBy(laptop, made.groupId);

    expect(onLaptop.group.me).toEqual(before.group.me);
    expect(local(onLaptop.group.signingKey)).toEqual(local(before.group.signingKey));
    expect(onLaptop.group.outbox).toEqual([]);
    expect(onLaptop.state.members.map((member) => member.author)).toEqual(
      before.state.members.map((member) => member.author),
    );
    // Two people have held rights, so the bootstrap still has a place: Cal's.
    expect(bootstrapOpen(onLaptop.state)).toBe(true);
    const cal = await joinLater(fake, ana, made.groupId, 'Cal');
    opened.push(cal);
    const after = await heldBy(laptop, made.groupId);
    const calAuthor = (await heldBy(cal, made.groupId)).group.me.author;
    const calMember = after.state.members.find((member) => member.author === calAuthor);
    expect(calMember?.rightsAt).toBe(calMember?.received);
    expect(after.state.members).toHaveLength(3);
    expect(bootstrapOpen(after.state)).toBe(false);
  });

  it('counts a vouch from each of one person’s devices once', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana', 'Ben', 'Cal', 'Kim']);
    opened.push(...made.devices);
    const [ana, , , kim] = made.devices;
    if (ana === undefined || kim === undefined) throw new Error('Expected Ana and Kim.');
    const laptop = await linkFrom(fake, ana, 'ana-laptop');
    const kimAuthor = (await heldBy(kim, made.groupId)).group.me.author;

    await vouch(ana.services, made.groupId, kimAuthor);
    await ana.services.sync.syncOnce();
    await vouch(laptop.services, made.groupId, kimAuthor);
    await laptop.services.sync.syncOnce();

    const { state } = await heldBy(kim, made.groupId);
    const vouches = vouchesFor(state, kimAuthor);
    expect(vouches).toHaveLength(1);
    expect(vouches[0]?.by).toBe((await heldBy(ana, made.groupId)).group.me.author);
    expect(state.members.find((member) => member.author === kimAuthor)?.rightsAt).toBeNull();
  });
});
