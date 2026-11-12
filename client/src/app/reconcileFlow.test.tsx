/**
 * Reconciling two groups, then admitting a third (#114), through the app's
 * actions on several devices and a fake relay: Ana in Riverside Tenants, Ben
 * in Oak St Co-op, and Cy in both. Ana makes a card, Cy brings it to Oak St,
 * and both groups vote; each group's home then says where the coalition
 * stands. Dee's Elm Row asks to join the formed coalition, and every group
 * in it votes.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCardLink } from '../coalition/card';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  formedCoalition,
  found,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { App } from './App';
import { messages } from './messages';
import { admitCard, bringCard, lookupCard, postCard, takePart } from './reconcile';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount any app before its device's store closes.
  cleanup();
  closeAll();
});

/** Riverside and Oak St, reconciled into Eastside Housing: both groups passed. */
const formed = formedCoalition;

/**
 * How long a wait gives a freshly rendered app to read the store and fold the
 * group's log and every coalition's, checking each signature, before it shows
 * them (#260). The file's first render also compiles the whole app: about
 * 0.3 s unloaded, which a loaded machine stretches past Testing Library's 1 s.
 * Every wait after a render here reads through that fold.
 */
const APP_FOLDS = { timeout: 3_000 };

/**
 * The Coalitions section of `device`'s group home for `groupId`, read from the
 * app, once it shows `text`; fails if it never does. Group home can show
 * before the device has read its coalitions (`useCoalitions` starts empty), so
 * a section read as soon as it appears may not hold them yet.
 */
async function expectCoalitionsOnHome(
  device: TestDevice,
  groupId: string,
  text: string | RegExp,
): Promise<HTMLElement> {
  cleanup();
  window.history.replaceState(null, '', `#/g/${groupId}`);
  render(<App services={device.services} />);
  return waitFor(() => {
    const section = screen.getByRole('region', { name: 'Coalitions' });
    expect(section).toHaveTextContent(text);
    return section;
  }, APP_FOLDS);
}

describe('reconciling two groups', SLOW, () => {
  it('forms the coalition on every device once both groups pass, with one entry on Cy’s', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);

    expect(card.mode).toBe('found');
    expect(card.groups).toEqual([{ groupId: oak, name: 'Oak St Co-op', kind: 'group' }]);
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
    await expectCoalitionsOnHome(
      ben,
      oak,
      'CoalitionsFormedEastside HousingRiverside Tenants, Oak St Co-op',
    );
    expect(await axeViolations()).toEqual([]);
    cleanup();
    window.history.replaceState(null, '', `#/g/${riverside}/p/${proposal}`);
    render(<App services={ana.services} />);
    expect(
      await screen.findByText(messages.coalitions.reconcilePassed, {}, APP_FOLDS),
    ).toBeVisible();
    const anaHome = await expectCoalitionsOnHome(ana, riverside, 'You take part as Ana E.');
    expect(within(anaHome).getByText(/You take part as/)).toHaveTextContent(
      'You take part as Ana E.',
    );
  });

  it('lets Ben take part under Oak St’s seat from its row, with a name of his own', async () => {
    const fake = createFakeRelay();
    const { ben, oak } = await formed(fake);
    const entry = (await ben.services.store.listCoalitions())[0];
    if (entry === undefined) throw new Error('Expected Ben’s coalition.');
    const home = await expectCoalitionsOnHome(ben, oak, 'Take part');
    expect(within(home).getByRole('button', { name: 'Take part' })).toBeVisible();

    await takePart(ben.services, entry.groupId, oak, 'Ben O.');
    await syncAll();

    const coalition = await coalitionOn(ben);
    const benIn = coalition.members.find((m) => m.name === 'Ben O.');
    expect(benIn).toBeDefined();
    expect(coalition.coalition?.bindings.find((b) => b.author === benIn?.author)?.seat).toBe(
      coalition.coalition?.seats[1]?.key,
    );
    await expectCoalitionsOnHome(ben, oak, 'You take part as Ben O.');
  });

  it('shows each group whom the coalition waits for while it forms', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
    await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await syncAll();

    const home = await expectCoalitionsOnHome(ana, riverside, 'Waiting for Oak St Co-op’s vote');
    expect(home).toHaveTextContent('Forming');
    expect(home).not.toHaveTextContent('Riverside Tenants’s vote');
    await expectCoalitionsOnHome(ben, oak, 'Waiting for Oak St Co-op’s vote');
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
      const home = await expectCoalitionsOnHome(device, groupId, 'Oak St Co-op didn’t pass this');
      expect(home).toHaveTextContent('Didn’t form');
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
    await expectCoalitionsOnHome(ana, riverside, 'Formed');
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await syncAll();

    expect((await coalitionOn(dee)).coalition?.seats).toHaveLength(2);
    cleanup();
    window.history.replaceState(null, '', `#/g/${riverside}/p/${motion}`);
    render(<App services={ana.services} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Admit Elm Row' }, APP_FOLDS),
    ).toBeVisible();
    expect(await screen.findByText(/^From the coalition/)).toHaveTextContent(
      'From the coalition Eastside Housing',
    );
    expect(await screen.findByText(messages.coalitions.motionPassed)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
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
    await expectCoalitionsOnHome(ben, oak, 'Riverside Tenants, Oak St Co-op, Elm Row');
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
    const home = await expectCoalitionsOnHome(dee, elm, 'Oak St Co-op didn’t pass this');
    expect(home).toHaveTextContent('Didn’t form');
  });

  it('proposes nothing when Elm Row doesn’t pass its own vote', async () => {
    const fake = createFakeRelay();
    const { ana, dee, elm } = await elmRowAsks(fake, false);

    expect((await coalitionOn(ana)).proposals).toEqual([]);
    expect((await dee.services.store.listCoalitions())[0]?.admitting).toBeUndefined();
    await expectCoalitionsOnHome(dee, elm, 'Elm Row didn’t pass this');
  });
});
