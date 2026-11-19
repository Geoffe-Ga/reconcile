/**
 * A reconcile card through a front door in the app (#426; ADR-0077 §5), on
 * devices that share one fake relay: Ben and Dee's Riverside Tenants opens a
 * door; Ana, in Eastside Hall, opens its link and proposes reconciling from
 * it; Ben's and Dee's group home list the card under Groups asking to
 * reconcile; one Dismiss, or one Bring it to a vote, takes it off every
 * member's device once each syncs.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { addressOf, doorLinkOf, newFrontDoor } from '../door/page';
import { fold } from '../engine/fold';
import { isFrontDoor } from '../engine/optIns';
import { TEST_ORIGIN, type TestDevice, testDevice } from '../test/appServices';
import { found } from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER, go, members, type MountedApp, mountApp } from '../test/members';
import { castBallot, proposeRules } from './proposals';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** `device`'s app, mounted under `prefix`. */
function mount(device: TestDevice, prefix: string): HTMLElement {
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice): Promise<void> {
  await act(() => device.services.sync.syncOnce());
}

/** `voters` open `groupId`'s front door, the first proposing, every one scoring it 4. */
async function openDoorBy(voters: readonly TestDevice[], groupId: string) {
  const [first] = voters;
  if (first === undefined) throw new Error('Expected a voter.');
  const proposed = await proposeRules(first.services, groupId, {
    optIn: 'frontDoor',
    value: newFrontDoor(false),
    title: 'Open a front door',
    why: 'People keep asking.',
    narrow: false,
  });
  if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
  const proposal = proposed.proposalId;
  for (const device of voters) {
    await sync(device);
    const scores = { [proposal]: 4 as const };
    await castBallot(device.services, groupId, { proposal, scores, note: '' });
    await sync(device);
  }
  for (const device of voters) await sync(device);
  const group = await first.services.store.getGroup(groupId);
  const door = fold(group?.log ?? [], group?.relayNow ?? null).rules.optIns.frontDoor;
  if (!isFrontDoor(door)) throw new Error('Expected an open front door.');
  return door;
}

/** Ben and Dee's group with its front door open by both their votes, and Ana's Eastside Hall. */
async function aDoor(fake: FakeRelay) {
  const { groupId, devices } = await members(fake, ['Ben', 'Dee']);
  opened.push(...devices);
  const [ben, dee] = devices;
  if (ben === undefined || dee === undefined) throw new Error('Expected Ben and Dee.');
  const door = await openDoorBy([ben, dee], groupId);
  const ana = await testDevice(fake, 'ana');
  opened.push(ana);
  const eastside = await found(ana, 'Eastside Hall', 'Ana');
  return { groupId, ben, dee, ana, eastside, link: doorLinkOf(TEST_ORIGIN, addressOf(door)) };
}

/** Ana opens the door's link and proposes reconciling from Eastside Hall. */
async function anaProposes(ana: TestDevice, link: string): Promise<void> {
  const user = userEvent.setup(APP_USER);
  go(new URL(link).hash);
  const a = mount(ana, 'a');
  await user.click(
    await within(a).findByRole('button', { name: 'Propose reconciling with this group' }),
  );
  expect(within(a).getByRole('radio', { name: 'Eastside Hall' })).toBeChecked();
  for (const [label, text] of [
    ['The coalition’s name', 'Eastside Housing'],
    ['Its first statement', 'Everyone on the east side has a safe home.'],
    ['Why', 'We share a landlord.'],
    ['Your name in the coalition', 'Ana E.'],
  ] as const) {
    await user.click(within(a).getByRole('textbox', { name: label }));
    await user.paste(text);
  }
  await user.click(within(a).getByRole('button', { name: 'Send the card' }));
  // Making the card shows first, then where it went (posting it notes its door too, #491).
  await waitFor(() => {
    expect(within(a).getByRole('status')).toHaveTextContent(/front door/);
  });
  for (const app of mounted.splice(0)) app.unmount();
}

/** The list of cards on `app`'s group home, once the card has opened. */
async function cardsOn(app: HTMLElement): Promise<HTMLElement> {
  const list = await within(app).findByRole('list', { name: 'Groups asking to reconcile' });
  expect(await within(list).findByText('Eastside Housing')).toBeVisible();
  return list;
}

describe('a reconcile card through a front door in the app (#426)', { timeout: 60_000 }, () => {
  it('reaches every member, and one Dismiss takes it off every member’s device after sync', async () => {
    const user = userEvent.setup(APP_USER);
    const { groupId, ben, dee, ana, link } = await aDoor(createFakeRelay());
    await anaProposes(ana, link);

    for (const device of [ben, dee]) await sync(device);
    go(`#/g/${groupId}`);
    const b = mount(ben, 'b');
    const d = mount(dee, 'd');
    const bens = await cardsOn(b);
    await cardsOn(d);
    await user.click(
      within(bens).getByRole('button', { name: 'Dismiss the card for Eastside Housing' }),
    );
    await waitFor(() => {
      expect(within(b).queryByRole('list', { name: 'Groups asking to reconcile' })).toBeNull();
    });
    // Dee's device still shows it until it hears of the close.
    expect(within(d).getByRole('list', { name: 'Groups asking to reconcile' })).toBeVisible();
    await sync(ben);
    await sync(dee);
    await waitFor(() => {
      expect(within(d).queryByRole('list', { name: 'Groups asking to reconcile' })).toBeNull();
    });
  });

  it('brings it to a vote for this group, opening the new Proposal, and every device stops showing it', async () => {
    const user = userEvent.setup(APP_USER);
    const { groupId, ben, dee, ana, link } = await aDoor(createFakeRelay());
    await anaProposes(ana, link);
    for (const device of [ben, dee]) await sync(device);
    go(`#/g/${groupId}`);
    const b = mount(ben, 'b');
    const bens = await cardsOn(b);
    await user.click(within(bens).getByRole('textbox', { name: 'Your name in the coalition' }));
    await user.paste('Ben O.');
    await user.click(
      within(bens).getByRole('button', { name: 'Bring it to a vote for Eastside Housing' }),
    );
    await waitFor(() => {
      expect(window.location.hash).toMatch(new RegExp(`^#/g/${groupId}/p/[A-Za-z0-9_-]{43}$`));
    });
    expect(
      await within(b).findByRole('heading', { level: 1, name: 'Reconcile into Eastside Housing' }),
    ).toBeVisible();
    await sync(ben);
    await sync(dee);
    go(`#/g/${groupId}`);
    const d = mount(dee, 'd');
    await within(d).findByRole('region', { name: 'Applications' });
    expect(within(d).queryByRole('list', { name: 'Groups asking to reconcile' })).toBeNull();
  });
});
