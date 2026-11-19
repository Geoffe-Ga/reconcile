/**
 * Reconcile cards through a front door (#426; ADR-0077 §5), through real
 * devices on one fake relay: Ben's Oak St Co-op opens a door; Ana, in
 * Riverside Tenants, makes a card from it, which queues Riverside's reconcile
 * Proposal, posts the card and leaves its seed in the door's inbox; Ben's
 * device reads it, and brings it to a vote or dismisses it, which closes it
 * for the whole group.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorChannelsOf } from '../crypto/door';
import { addressOf, newFrontDoor, readDoor } from '../door/page';
import { LEVELS } from '../engine/capabilities';
import { fold } from '../engine/fold';
import { cardClosedFor } from '../engine/frontDoor';
import { isFrontDoor } from '../engine/optIns';
import { createRelay } from '../net/relay';
import { xchachaSeal } from '../crypto/seal';
import { parseInviteLink } from './invite';
import {
  CARD_VALUES,
  closeAll,
  coalitionOn,
  found,
  open,
  SLOW,
  syncAll,
  vote,
} from '../test/coalitionDevices';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { joinGroup, lookupInvite, makeInvite } from './actions';
import { bringDoorCard, cardGroupsAt, closeDoorCard, makeDoorCard } from './doorCards';
import { proposeRules } from './proposals';
import { lookupCard } from './reconcile';

freshIndexedDBPerTest();

afterEach(closeAll);

const [, COLLABORATING] = LEVELS;

/** The door `groupId` holds open on `device`, its address, and its page as anyone reads it. */
async function doorOf(fake: FakeRelay, device: TestDevice, groupId: string) {
  const group = await device.services.store.getGroup(groupId);
  const door = fold(group?.log ?? [], group?.relayNow ?? null).rules.optIns.frontDoor;
  if (!isFrontDoor(door)) throw new Error('Expected an open front door.');
  const address = addressOf(door);
  const view = await readDoor(
    { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal },
    address,
  );
  if (view.kind !== 'open') throw new Error('Expected the door’s page.');
  return { address, page: view.page };
}

/** Riverside Tenants (Ana) and Oak St Co-op (Ben), Oak St's front door opened by Ben's vote. */
async function aDoor(fake: FakeRelay) {
  const ana = await open(fake, 'ana');
  const ben = await open(fake, 'ben');
  const riverside = await found(ana, 'Riverside Tenants', 'Ana');
  const oak = await found(ben, 'Oak St Co-op', 'Ben');
  const proposed = await proposeRules(ben.services, oak, {
    optIn: 'frontDoor',
    value: newFrontDoor(false),
    title: 'Open a front door',
    why: 'People keep asking.',
    narrow: false,
  });
  if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
  await vote(oak, proposed.proposalId, [ben]);
  await syncAll();
  return { ana, ben, riverside, oak, ...(await doorOf(fake, ben, oak)) };
}

/** Ana makes a card at Oak St's door for Riverside and posts it; returns its Proposal. */
async function anaLeavesCard(at: Awaited<ReturnType<typeof aDoor>>) {
  const { ana, riverside, address, page } = at;
  const made = await makeDoorCard(ana.services, riverside, CARD_VALUES, { address, page });
  if (made.outcome !== 'queued') throw new Error('Expected a card.');
  await made.post();
  await syncAll();
  return made.proposalId;
}

/** The one card Ben's device holds at Oak St's door. */
async function bensCard(ben: TestDevice, oak: string) {
  const [card, ...more] = (await ben.services.store.getGroup(oak))?.door?.cards ?? [];
  if (card === undefined || more.length > 0) throw new Error('Expected one card.');
  return card;
}

describe('cardGroupsAt: the groups a device may propose reconciling from, at a door', SLOW, () => {
  it('lists each group where this person may propose, but never the door’s own', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    expect(await cardGroupsAt(at.ana.services, at.address)).toEqual([
      { groupId: at.riverside, name: 'Riverside Tenants', kind: 'group' },
    ]);
    expect(await cardGroupsAt(at.ben.services, at.address)).toEqual([]);
    const kim = await open(fake, 'kim');
    expect(await cardGroupsAt(kim.services, at.address)).toEqual([]);
  });

  it('leaves out a group where this person can only vote', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const cal = await open(fake, 'cal');
    const seed = parseInviteLink(await makeInvite(at.ana.services, at.riverside, 'https://x.test'));
    const lookup = seed === null ? null : await lookupInvite(cal.services, seed);
    if (lookup?.kind !== 'found') throw new Error('Expected the invite to open.');
    await joinGroup(cal.services, lookup.group, 'Cal', COLLABORATING);
    await syncAll();
    expect(await cardGroupsAt(cal.services, at.address)).toEqual([]);
  });
});

describe('makeDoorCard', SLOW, () => {
  it('queues the reconcile Proposal, posts the card, and leaves its seed in the door’s inbox', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const proposalId = await anaLeavesCard(at);

    const riverside = await at.ana.services.store.getGroup(at.riverside);
    const state = fold(riverside?.log ?? [], riverside?.relayNow ?? null);
    expect(state.proposals.map((proposal) => proposal.id)).toContain(proposalId);
    const card = await bensCard(at.ben, at.oak);
    const lookup = await lookupCard(at.ben.services, fromBase64url(card.seed ?? ''));
    expect(lookup).toMatchObject({ kind: 'found', found: { card: { name: CARD_VALUES.name } } });
    // The inbox holds one blob the relay can't read: a card's PUT names only the door's inbox.
    const { inbox } = doorChannelsOf(at.address);
    const puts = fake.requests.filter((r) => r.method === 'PUT' && r.url.includes(inbox));
    expect(puts.map((put) => [put.url.split('?')[1], put.body?.length])).toEqual([
      ['ttl_days=1', 1024],
    ]);
  });

  it('keeps the Proposal queued when the relay can’t be reached, and posts again on retry', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const made = await makeDoorCard(at.ana.services, at.riverside, CARD_VALUES, at);
    if (made.outcome !== 'queued') throw new Error('Expected a card.');
    fake.offline = true;
    await expect(made.post()).rejects.toThrow();
    fake.offline = false;
    await made.post();
    await syncAll();
    expect((await bensCard(at.ben, at.oak)).seed).toBeDefined();
  });

  it('notes the door on this device only once the card is left there (#491)', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const { store, now } = at.ana.services;
    const made = await makeDoorCard(at.ana.services, at.riverside, CARD_VALUES, at);
    if (made.outcome !== 'queued') throw new Error('Expected a card.');
    fake.offline = true;
    await expect(made.post()).rejects.toThrow();
    expect((await store.removalsAt(now())).sent).toEqual([]);

    fake.offline = false;
    await made.post();
    expect((await store.removalsAt(now())).sent).toEqual([
      { door: base64url(at.address), sentAt: now(), kind: 'card' },
    ]);
    expect((await at.ben.services.store.removalsAt(now())).sent).toEqual([]);
  });

  it('refuses a statement too large to send, keeping nothing', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const statement = 'x'.repeat(70_000);
    const made = await makeDoorCard(
      at.ana.services,
      at.riverside,
      { ...CARD_VALUES, statement },
      at,
    );
    expect(made).toEqual({ outcome: 'too-large' });
  });
});

describe('closing a card at the door', SLOW, () => {
  it('dismisses it for the whole group, once, and only for someone who may propose', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    await anaLeavesCard(at);
    const card = await bensCard(at.ben, at.oak);
    expect(await closeDoorCard(at.ben.services, at.oak, card.id)).toBe('closed');
    expect(await closeDoorCard(at.ben.services, at.oak, card.id)).toBe('missing');
    expect(await closeDoorCard(at.ben.services, 'no-such-group', card.id)).toBe('missing');
    await syncAll();
    const oak = await at.ben.services.store.getGroup(at.oak);
    expect(cardClosedFor(fold(oak?.log ?? [], oak?.relayNow ?? null), card.id)?.card).toBe(card.id);
    expect((await bensCard(at.ben, at.oak)).seed).toBeUndefined();
  });

  it('brings it to a vote for this group, closing it, and both groups’ passes form the coalition', async () => {
    const fake = createFakeRelay();
    const at = await aDoor(fake);
    const anas = await anaLeavesCard(at);
    const card = await bensCard(at.ben, at.oak);
    const lookup = await lookupCard(at.ben.services, fromBase64url(card.seed ?? ''));
    if (lookup.kind !== 'found') throw new Error('Expected the card to open.');

    const bens = await bringDoorCard(at.ben.services, at.oak, card.id, lookup.found, 'Ben O.');
    await syncAll();
    const oak = await at.ben.services.store.getGroup(at.oak);
    const state = fold(oak?.log ?? [], oak?.relayNow ?? null);
    expect(state.proposals.find((proposal) => proposal.id === bens)?.title).toBe(
      'Reconcile into Eastside Housing',
    );
    expect(cardClosedFor(state, card.id)).toBeDefined();

    await vote(at.riverside, anas, [at.ana]);
    await vote(at.oak, bens, [at.ben]);
    await syncAll(3);
    for (const device of [at.ana, at.ben]) {
      expect((await coalitionOn(device)).coalition?.status).toBe('formed');
    }
  });
});
