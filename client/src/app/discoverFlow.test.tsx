/**
 * Discover's feed through the whole app (#429), on real devices that share
 * one fake relay: Ana is in two groups, each sends a Dispatch, and Discover
 * lists both, newest first, each under its group's name, built from the logs
 * the device already holds. Opening Discover asks the relay for nothing.
 */
import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { foundAnother, go, members, type MountedApp, mountApp } from '../test/members';
import { messages } from './messages';
import { sendDispatch } from './proposals';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
  window.history.replaceState(null, '', '#/');
});

describe('Discover’s feed through the app (#429)', { timeout: 60_000 }, () => {
  it('lists the Dispatches of both of Ana’s groups, newest first, without asking the relay', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const second = await foundAnother(ana, 'Ana');
    await sendDispatch(ana.services, made.groupId, {
      title: 'Meet on Sunday',
      text: 'Bring a chair.',
      doc: null,
    });
    await ana.services.sync.syncOnce();
    fake.minute += 5;
    await sendDispatch(ana.services, second, { title: 'Seeds are in', text: '', doc: null });
    await ana.services.sync.syncOnce();
    const asked = fake.requests.length;

    go('#/discover');
    const app = mountApp(ana.services, 'd');
    mounted.push(app);
    const view = within(app.container);
    const list = await view.findByRole('list', { name: messages.discover.feedLabel });

    const titles = within(list)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(['Seeds are in', 'Meet on Sunday']);
    const homes = within(list)
      .getAllByRole('link', { name: 'Riverside Tenants' })
      .map((link) => link.getAttribute('href'));
    expect(homes).toEqual([`#/g/${second}`, `#/g/${made.groupId}`]);
    expect(fake.requests).toHaveLength(asked);
    expect(await axeViolations()).toEqual([]);
  });
});
