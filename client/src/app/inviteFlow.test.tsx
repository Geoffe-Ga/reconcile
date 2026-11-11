/**
 * Invite links in the app (#73), with an injected device clock: an expired or
 * damaged link, a newcomer who reads the preview before anything is stored,
 * and a device away for over 28 days that catches up from a fresh link.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { newInviteSeed } from '../crypto/invite';
import { base64url } from '../engine/event';
import { TEST_NOW, type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup, makeInvite } from './actions';
import { App } from './App';
import { messages } from './messages';

freshIndexedDBPerTest();

const DAY = 86_400_000;
const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** A device whose clock the test moves through `clock.now`. */
async function open(fake: FakeRelay, name: string) {
  const clock = { now: TEST_NOW };
  const device = await testDevice(fake, name, () => clock.now);
  devices.push(device);
  return { device, clock };
}

/** Ana founds the group on `device` and syncs; returns its id. */
async function founded(device: TestDevice): Promise<string> {
  const result = await createGroup(device.services, {
    groupName: 'Riverside Tenants',
    yourName: 'Ana',
    chat: null,
    documents: [
      { title: 'House rules', text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.' },
    ],
  });
  if (result.outcome !== 'created') throw new Error('Expected a group.');
  await device.services.sync.syncOnce();
  return result.groupId;
}

/** Puts `link`'s fragment in the address bar, as opening it would. */
function opening(link: string): void {
  window.history.replaceState(null, '', new URL(link).hash);
}

const expiredLine = () => screen.findByText(messages.join.badLink);

describe('opening an invite link', () => {
  it('shows the expired line for a malformed seed, and makes no request', async () => {
    const fake = createFakeRelay();
    const { device } = await open(fake, 'ben');
    window.history.replaceState(null, '', `#join/${'A'.repeat(42)}B`);

    render(<App services={device.services} />);

    expect(await expiredLine()).toBeVisible();
    expect(window.location.hash).toBe('#/join');
    expect(fake.requests).toEqual([]);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the expired line for an empty invite mailbox, after one read of it', async () => {
    const fake = createFakeRelay();
    const { device } = await open(fake, 'ben');
    window.history.replaceState(null, '', `#join/${base64url(newInviteSeed())}`);

    render(<App services={device.services} />);

    expect(await expiredLine()).toBeVisible();
    expect(fake.requests.map((request) => request.method)).toEqual(['GET']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the expired line once the relay has dropped the envelope', async () => {
    const fake = createFakeRelay({ minute: 1440 * 20_000 + 60 });
    const { device: ana } = await open(fake, 'ana');
    const link = await makeInvite(ana.services, await founded(ana), ana.services.origin);
    const { device: ben } = await open(fake, 'ben');
    fake.minute = 1440 * 20_002;
    opening(link);

    render(<App services={ben.services} />);

    expect(await expiredLine()).toBeVisible();
    expect(await ben.services.store.listGroups()).toEqual([]);
  });

  it('shows the preview and stores nothing until Join, then joins with the whole history', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { device: ana } = await open(fake, 'ana');
    const groupId = await founded(ana);
    const link = await makeInvite(ana.services, groupId, ana.services.origin);
    const { device: ben } = await open(fake, 'ben');
    opening(link);

    render(<App services={ben.services} />);

    expect(await screen.findByText('Quiet hours start at ten.')).toBeVisible();
    expect(screen.getByText(/^From/)).toHaveTextContent('From Ana’s invite');
    expect(await ben.services.store.listGroups()).toEqual([]);
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));

    const people = await screen.findByRole('region', { name: 'People' });
    await waitFor(() => {
      expect(
        within(people)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Ana, Co-Creator, Steward', 'Ben, invited by Ana, Collaborator']);
    });
    expect((await ben.services.store.getGroup(groupId))?.log).toHaveLength(2);
  });
});

describe('a device away for more than 28 days', () => {
  it('shows the catch-up line from that sync on, until a fresh link’s merge clears it', async () => {
    const fake = createFakeRelay();
    const { device: ana, clock } = await open(fake, 'ana');
    const groupId = await founded(ana);
    window.history.replaceState(null, '', `#/g/${groupId}`);
    render(<App services={ana.services} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();

    clock.now = TEST_NOW + 28 * DAY;
    await act(() => ana.services.sync.syncOnce());
    expect(screen.queryByText(messages.home.missingHistory)).not.toBeInTheDocument();

    clock.now += 28 * DAY + 1;
    await act(() => ana.services.sync.syncOnce());
    expect(await screen.findByText(messages.home.missingHistory)).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    clock.now += 60_000;
    await act(() => ana.services.sync.syncOnce());
    expect(screen.getByText(messages.home.missingHistory)).toBeVisible();

    const link = await makeInvite(ana.services, groupId, ana.services.origin);
    act(() => {
      opening(link);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText(messages.join.alreadyJoined)).toBeVisible();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open your group' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(screen.queryByText(messages.home.missingHistory)).not.toBeInTheDocument();
  });
});

describe('the tracer’s invite stub', () => {
  it('is gone from the app', () => {
    const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const marker = ['STUB', '(invite)'].join('');
    const marked = Object.entries(sources).filter(([, text]) => text.includes(marker));
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(marked.map(([path]) => path)).toEqual([]);
  });
});
