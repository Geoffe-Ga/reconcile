import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { testDevice, type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup, makeInvite } from './actions';
import { App } from './App';

freshIndexedDBPerTest();

const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function device(fake: FakeRelay, name: string): Promise<TestDevice> {
  const opened = await testDevice(fake, name);
  devices.push(opened);
  return opened;
}

const VALUES = {
  groupName: 'Riverside Tenants',
  yourName: 'Ana',
  chat: null,
  title: 'House rules',
  text: 'Quiet hours start at ten.',
};

/** A group created on `owner` and sent to the relay. */
async function existingGroup(owner: TestDevice): Promise<string> {
  const result = await createGroup(owner.services, VALUES);
  if (result.outcome !== 'created') throw new Error('Expected a group.');
  await owner.services.sync.syncOnce();
  return result.groupId;
}

/** A new invite link for `groupId`, made on `owner` as Copy invite link makes one. */
function linkFor(owner: TestDevice, groupId: string, origin: string): Promise<string> {
  return makeInvite(owner.services, groupId, origin);
}

function at(hash: string): void {
  window.history.replaceState(null, '', hash);
}

describe('App', () => {
  it('starts on Start, with no groups yet', async () => {
    const { services } = await device(createFakeRelay(), 'ana');
    render(<App services={services} />);
    expect(await screen.findByText('You aren’t in any groups on this device yet.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create group' })).toHaveAttribute('href', '#/create');
    expect(await axeViolations()).toEqual([]);
  });

  it('lists a group on Start once it exists', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const groupId = await existingGroup(ana);
    render(<App services={ana.services} />);
    expect(await screen.findByRole('link', { name: /Riverside Tenants/ })).toHaveAttribute(
      'href',
      `#/g/${groupId}`,
    );
  });

  it('creates a group and puts its Group home in place of the form in history', async () => {
    const user = userEvent.setup();
    const { services } = await device(createFakeRelay(), 'ana');
    at('#/create');
    const depth = window.history.length;
    render(<App services={services} />);
    const entries: [string, string][] = [
      ['Group name', 'Riverside Tenants'],
      ['Your name', 'Ana'],
      ['Document title', 'House rules'],
      ['Document text', 'Quiet hours start at ten.'],
    ];
    for (const [label, value] of entries) {
      await user.click(screen.getByRole('textbox', { name: label }));
      await user.paste(value);
    }
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(window.location.hash).toMatch(/^#\/g\/[A-Za-z0-9_-]{43}$/);
    expect(window.history.length).toBe(depth);
    expect(await axeViolations()).toEqual([]);
  });

  it('says a group is setting up until its genesis is back from the relay', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    fake.offline = true;
    const result = await createGroup(ana.services, VALUES);
    at(`#/g/${result.outcome === 'created' ? result.groupId : ''}`);
    render(<App services={ana.services} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Setting up your group' }),
    ).toBeVisible();

    fake.offline = false;
    await ana.services.sync.syncOnce();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
  });

  it.each(['#/g/elsewhere', '#/g/elsewhere/doc'])(
    'says when a group isn’t on this device (%s)',
    async (route) => {
      const { services } = await device(createFakeRelay(), 'ana');
      at(route);
      render(<App services={services} />);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'This group isn’t on this device' }),
      ).toBeVisible();
    },
  );

  it('shows the Document view', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const groupId = await existingGroup(ana);
    at(`#/g/${groupId}/doc`);
    render(<App services={ana.services} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens a pasted invite without putting it in the address bar', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const link = await linkFor(ana, await existingGroup(ana), 'https://elsewhere.example');
    const ben = await device(fake, 'ben');
    render(<App services={ben.services} />);

    await user.click(await screen.findByRole('textbox', { name: 'Invite link' }));
    await user.paste(link);
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(window.location.hash).toBe('#/join');
  });

  it('sends a member who opens their own invite to their group', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const groupId = await existingGroup(ana);
    at(new URL(await linkFor(ana, groupId, ana.services.origin)).hash);
    render(<App services={ana.services} />);
    expect(await screen.findByRole('link', { name: 'Open your group' })).toHaveAttribute(
      'href',
      `#/g/${groupId}`,
    );
  });
});
