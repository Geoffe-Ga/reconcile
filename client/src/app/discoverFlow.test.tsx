/**
 * Discover's feed through the whole app (#429), on real devices that share
 * one fake relay: Ana is in two groups, each sends a Dispatch, and Discover
 * lists both, newest first, each under its group's name, built from the logs
 * the device already holds. Opening Discover asks the relay for nothing.
 *
 * The public shelf (#484): a listing and an entry hand-signed with a door's
 * key and PUT to a fake shelf show on Discover on a device in no group, and
 * nothing of the shelf shows while the relay has none. The listing composer
 * reads the same shelf, and warns when a listed group holds a name like the
 * group's own (#487).
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf } from '../net/shelf';
import { signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { createFakeShelf } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { foundAnother, go, members, type MountedApp, mountApp } from '../test/members';
import { messages } from './messages';
import { sendDispatch } from './proposals';
import { createShelfFeed } from './shelfFeed';

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

describe('The public shelf on Discover through the app (#484)', { timeout: 60_000 }, () => {
  /** A listing (Oak St Tenants' unless named) and one entry, hand-signed with a door's key and PUT to the shelf. */
  async function stockedShelf(available = true, name = 'Oak St Tenants') {
    const fake = createFakeShelf({ available });
    const shelf = createShelf({ fetch: fake.fetch });
    if (!available) return { fake, shelf };
    const door = newSigningKeys();
    const address = base64url(door.publicKey);
    const covenant = base64url(new Uint8Array(32).fill(9));
    const id = base64url(new Uint8Array(32).fill(4));
    const listing = { v: 1, kind: 'listing', open: true, name } as const;
    await shelf.put(
      address,
      signShelfBody(door, { ...listing, skeleton: nameSkeleton(name), covenant }),
    );
    await shelf.put(
      address,
      signShelfBody(door, {
        v: 1,
        kind: 'entry',
        id,
        title: 'Rent strike vote',
        text: 'Thursday.',
      }),
    );
    return { fake, shelf };
  }

  it('shows a hand-signed entry under its listing’s name on a device in no group', async () => {
    const { shelf } = await stockedShelf();
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: createShelfFeed({ shelf, now: () => 0 }) };

    go('#/discover');
    const app = mountApp(services, 's');
    mounted.push(app);
    const view = within(app.container);
    const section = await view.findByRole('region', { name: messages.discover.shelfHeading });

    expect(view.getByText(messages.discover.empty)).toBeVisible();
    expect(within(section).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Rent strike vote',
    );
    expect(section.querySelector('.dispatch-from > bdi')).toHaveTextContent('Oak St Tenants');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows nothing of the shelf when the relay has none', async () => {
    const { fake, shelf } = await stockedShelf(false);
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: createShelfFeed({ shelf, now: () => 0 }) };

    go('#/discover');
    const app = mountApp(services, 'u');
    mounted.push(app);
    const view = within(app.container);
    await view.findByText(messages.discover.empty);
    await waitFor(() => {
      expect(fake.urls).toEqual(['/v1/shelf?after=0&limit=100']);
    });

    expect(view.queryByText(messages.discover.shelfHeading)).toBeNull();
  });

  it('warns a listing composer that a listed group holds a name like its group’s (#487)', async () => {
    const { shelf } = await stockedShelf(true, 'RIVERSIDE TENANTS');
    const made = await members(createFakeRelay(), ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const services = { ...ana.services, shelf: createShelfFeed({ shelf, now: () => 0 }) };

    go(`#/g/${made.groupId}/rules/frontDoor`);
    const app = mountApp(services, 'w');
    mounted.push(app);
    const view = within(app.container);
    const list = await view.findByRole('checkbox', { name: messages.optIns.listing.choiceLabel });
    expect(view.queryByText(messages.optIns.listing.lookAlike)).toBeNull();
    await userEvent.setup().click(list);

    expect(await view.findByText(messages.optIns.listing.lookAlike)).toBeVisible();
  });
});
