/**
 * Reconciling two groups, then admitting a third (#114), through the app's
 * actions on several devices and a fake relay: Ana in Riverside Tenants, Ben
 * in Oak St Co-op, and Cy in both. Ana makes a card, Cy brings it to Oak St,
 * and both groups vote; each group's home then says where the coalition
 * stands. Dee's Elm Row asks to join the formed coalition, and every group
 * in it votes.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCardLink } from '../coalition/card';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import type { Score } from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { TEST_NOW, type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup, joinGroup, lookupInvite, makeInvite } from './actions';
import { App } from './App';
import { parseInviteLink } from './invite';
import { castBallot } from './proposals';
import { admitCard, bringCard, lookupCard, makeCard, postCard } from './reconcile';

freshIndexedDBPerTest();

/** Several devices syncing in turn: these tests run longer than one device's. */
const SLOW = { timeout: 30_000 };

const devices: TestDevice[] = [];

afterEach(() => {
  cleanup();
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function open(fake: FakeRelay, name: string): Promise<TestDevice> {
  const device = await testDevice(fake, name, () => TEST_NOW);
  devices.push(device);
  return device;
}

async function found(device: TestDevice, groupName: string, yourName: string): Promise<string> {
  const created = await createGroup(device.services, {
    groupName,
    yourName,
    chat: null,
    title: 'House rules',
    text: 'Quiet hours start at ten.',
  });
  if (created.outcome !== 'created') throw new Error('Expected a group.');
  await device.services.sync.syncOnce();
  return created.groupId;
}

async function join(from: TestDevice, groupId: string, device: TestDevice, name: string) {
  const seed = parseInviteLink(await makeInvite(from.services, groupId, from.services.origin));
  if (seed === null) throw new Error('Expected an invite link.');
  const lookup = await lookupInvite(device.services, seed);
  if (lookup.kind !== 'found') throw new Error('Expected the invite to open.');
  await joinGroup(device.services, lookup.group, name, 'co-creator');
  await device.services.sync.syncOnce();
}

/** Every device syncs, `rounds` times over. */
async function syncAll(rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) await device.services.sync.syncOnce();
  }
}

/** Riverside Tenants (Ana, Cy) and Oak St Co-op (Ben, Cy), all synced. */
async function twoGroups(fake: FakeRelay) {
  const ana = await open(fake, 'ana');
  const ben = await open(fake, 'ben');
  const cy = await open(fake, 'cy');
  const riverside = await found(ana, 'Riverside Tenants', 'Ana');
  const oak = await found(ben, 'Oak St Co-op', 'Ben');
  await join(ana, riverside, cy, 'Cy');
  await join(ben, oak, cy, 'Cy');
  await syncAll(1);
  return { ana, ben, cy, riverside, oak };
}

const VALUES = {
  name: 'Eastside Housing',
  statement: 'Everyone on the east side has a safe home.\n\nWe meet on the first Sunday.',
  why: 'We share a landlord.',
  yourName: 'Ana E.',
};

/** Ana's card for Riverside, posted, and the card Cy opens from its link. */
async function anaMakesCard(ana: TestDevice, cy: TestDevice, riverside: string) {
  const made = await makeCard(ana.services, riverside, VALUES);
  if (made.outcome !== 'queued') throw new Error('Expected a card.');
  const link = await postCard(ana.services, made.card, ana.services.origin);
  await syncAll(1);
  const seed = parseCardLink(link);
  if (seed === null) throw new Error('Expected a card link.');
  const lookup = await lookupCard(cy.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  return { proposal: made.proposalId, found: lookup.found, seed };
}

/** Each device scores the Proposal `score` in `groupId`, with a reason for a 0. */
async function vote(
  groupId: string,
  proposal: string,
  voters: readonly TestDevice[],
  score: Score = 4,
) {
  for (const voter of voters) {
    const note = score === 0 ? 'Not with them.' : '';
    await castBallot(voter.services, groupId, { proposal, scores: { [proposal]: score }, note });
  }
}

/** The coalition as `device` folds its entry, failing when it holds none or more. */
async function coalitionOn(device: TestDevice): Promise<GroupState> {
  const entries = await device.services.store.listCoalitions();
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) throw new Error('Expected a coalition entry.');
  return fold(entry.log, entry.relayNow);
}

/** Riverside and Oak St, reconciled into Eastside Housing: both groups passed. */
async function formed(fake: FakeRelay) {
  const groups = await twoGroups(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
  const brought = await bringCard(cy.services, card, oak, 'Cy');
  await syncAll(1);
  await vote(riverside, proposal, [ana, cy]);
  await vote(oak, brought, [ben, cy]);
  await syncAll();
  return groups;
}

/** The text of `device`'s group home's Coalitions section for `groupId`, read from the app. */
async function coalitionsOnHome(device: TestDevice, groupId: string): Promise<HTMLElement> {
  cleanup();
  window.history.replaceState(null, '', `#/g/${groupId}`);
  render(<App services={device.services} />);
  return screen.findByRole('region', { name: 'Coalitions' });
}

describe('reconciling two groups', SLOW, () => {
  it('forms the coalition on every device once both groups pass, with one entry on Cy’s', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);

    expect(card.mode).toBe('found');
    expect(card.groups).toEqual([{ groupId: oak, name: 'Oak St Co-op' }]);
    expect(card.card.seat.name).toBe('Riverside Tenants');
    const brought = await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    expect((await coalitionOn(ben)).coalition?.status).toBe('forming');
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy]);
    await syncAll();

    for (const device of [ana, ben, cy]) {
      const coalition = await coalitionOn(device);
      expect(coalition.coalition?.status).toBe('formed');
      expect(coalition.name).toBe('Eastside Housing');
      expect(coalition.coalition?.seats.map((seat) => seat.name)).toEqual([
        'Riverside Tenants',
        'Oak St Co-op',
      ]);
    }
    expect((await coalitionOn(ana)).members.map((m) => m.name)).toEqual(['Cy', 'Ana E.']);
    const home = await coalitionsOnHome(ben, oak);
    expect(home).toHaveTextContent(
      'CoalitionsFormedEastside HousingRiverside Tenants, Oak St Co-op',
    );
    expect(await axeViolations()).toEqual([]);
    const anaHome = await coalitionsOnHome(ana, riverside);
    expect(within(anaHome).getByText(/You take part as/)).toHaveTextContent(
      'You take part as Ana E.',
    );
  });

  it('shows each group whom the coalition waits for while it forms', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
    await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await syncAll();

    const home = await coalitionsOnHome(ana, riverside);
    expect(home).toHaveTextContent('Forming');
    expect(home).toHaveTextContent('Waiting for Oak St Co-op’s vote');
    expect(home).not.toHaveTextContent('Riverside Tenants’s vote');
    expect(await coalitionsOnHome(ben, oak)).toHaveTextContent('Waiting for Oak St Co-op’s vote');
  });

  it('says the card was used once the genesis exists', async () => {
    const fake = createFakeRelay();
    const { ana, cy, riverside, oak } = await twoGroups(fake);
    const { found: card, seed } = await anaMakesCard(ana, cy, riverside);
    await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);

    expect(await lookupCard(cy.services, seed)).toEqual({ kind: 'used' });
  });

  it('declines the coalition when Oak St’s Proposal fails, and both homes say who didn’t pass', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
    const brought = await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy], 0);
    await syncAll();

    for (const device of [ana, ben, cy]) {
      expect((await coalitionOn(device)).coalition?.status).toBe('declined');
    }
    for (const [device, groupId] of [
      [ana, riverside],
      [ben, oak],
    ] as const) {
      const home = await coalitionsOnHome(device, groupId);
      expect(home).toHaveTextContent('Didn’t form');
      expect(home).toHaveTextContent('Oak St Co-op didn’t pass this');
      expect(home).not.toHaveTextContent('Riverside Tenants didn’t pass this');
    }
  });
});

/** Relay time a week past a vote's deadline, by which every pass on it is final. */
const PAST_FINAL = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + RESULT_GRACE_MINUTES + 60;

/**
 * Eastside Housing formed, then Dee's Elm Row brings a card Ana makes from
 * its row: Elm Row votes, and its reconcile Proposal is returned.
 */
async function elmRowAsks(fake: FakeRelay, elmPasses: boolean) {
  const groups = await formed(fake);
  const { ana, riverside } = groups;
  const dee = await open(fake, 'dee');
  const elm = await found(dee, 'Elm Row', 'Dee');
  const entry = (await ana.services.store.listCoalitions())[0];
  if (entry === undefined) throw new Error('Expected Ana’s coalition.');
  const card = await admitCard(ana.services, entry.groupId, riverside);
  const seed = parseCardLink(await postCard(ana.services, card, ana.services.origin));
  if (seed === null) throw new Error('Expected a card link.');
  const lookup = await lookupCard(dee.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  expect(lookup.found.mode).toBe('admit');
  const proposal = await bringCard(dee.services, lookup.found, elm, 'Dee M.');
  await syncAll(1);
  expect((await coalitionOn(ana)).proposals).toEqual([]);
  await vote(elm, proposal, [dee], elmPasses ? 4 : 0);
  await syncAll();
  return { ...groups, dee, elm };
}

/** The admit motion every current group votes on, as `device` reads it. */
async function admitMotion(device: TestDevice): Promise<string> {
  const motion = (await coalitionOn(device)).proposals.find((p) => p.target.kind === 'admit');
  if (motion === undefined) throw new Error('Expected an admit motion.');
  return motion.id;
}

describe('admitting a group into a formed coalition', SLOW, () => {
  it('seats Elm Row only after it passes, then both groups pass and the pass is final', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, dee, riverside, oak } = await elmRowAsks(fake, true);
    const motion = await admitMotion(ana);
    const riversideHome = await coalitionsOnHome(ana, riverside);
    expect(riversideHome).toHaveTextContent('Formed');
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await syncAll();

    expect((await coalitionOn(dee)).coalition?.seats).toHaveLength(2);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll();

    const coalition = await coalitionOn(dee);
    expect(coalition.coalition?.seats.map((seat) => seat.name)).toEqual([
      'Riverside Tenants',
      'Oak St Co-op',
      'Elm Row',
    ]);
    expect(coalition.members.map((m) => m.name)).toContain('Dee M.');
    expect(await coalitionsOnHome(ben, oak)).toHaveTextContent(
      'Riverside Tenants, Oak St Co-op, Elm Row',
    );
  });

  it('leaves Elm Row out when Oak St fails the admission', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, dee, riverside, oak, elm } = await elmRowAsks(fake, true);
    const motion = await admitMotion(ana);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy], 0);
    await syncAll();
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll();

    expect((await coalitionOn(dee)).coalition?.seats).toHaveLength(2);
    const home = await coalitionsOnHome(dee, elm);
    expect(home).toHaveTextContent('Didn’t form');
    expect(home).toHaveTextContent('Oak St Co-op didn’t pass this');
  });

  it('proposes nothing when Elm Row doesn’t pass its own vote', async () => {
    const fake = createFakeRelay();
    const { ana, dee, elm } = await elmRowAsks(fake, false);

    expect((await coalitionOn(ana)).proposals).toEqual([]);
    expect((await dee.services.store.listCoalitions())[0]?.admitting).toBeUndefined();
    expect(await coalitionsOnHome(dee, elm)).toHaveTextContent('Elm Row didn’t pass this');
  });
});
