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
 * group's own (#487). An entry's link opens its own page, with Copy and
 * Share, on a device in no group (#431).
 *
 * From that page (#432), Ask to join opens the listing's front door, whose
 * form offers no personal Documents until the door was first listed 43,200
 * relay minutes before, by the fake shelf's clock, and Propose reconciling
 * shows only on a device with a group that may propose it.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { doorKeysOf } from '../crypto/door';
import { xchachaSeal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import { addressOf, type OpenPage, publishPage } from '../door/page';
import { createRelay } from '../net/relay';
import { createShelf, type Shelf } from '../net/shelf';
import { createShelfReader } from '../shelf/read';
import { signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { COVENANT_HASH, DOOR } from '../test/door';
import { createFakeShelf, notify, release } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { newPersonalId } from '../store/personal';
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
    await release(fake, address);
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
    // A relay day passes, so every device shows the entry (#431).
    fake.minute += 1440;
    return { fake, shelf, address, id };
  }

  /** The shelf's reader on `device`, keeping its copy in the device's store. */
  const readerOf = (shelf: Shelf, device: TestDevice) =>
    createShelfReader({ shelf, keep: device.services.store, now: () => 0 });

  it('shows a hand-signed entry under its listing’s name on a device in no group', async () => {
    const { shelf } = await stockedShelf();
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

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

  it('opens an entry’s link on a device in no group, with Copy and Share for it (#431)', async () => {
    const { shelf, address, id } = await stockedShelf();
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

    go('#/discover');
    const app = mountApp(services, 'e');
    mounted.push(app);
    const view = within(app.container);
    const pass = await view.findByRole('link', { name: messages.discover.passAlong });
    const href = `#/discover/${String(address)}/${String(id)}`;
    expect(pass).toHaveAttribute('href', href);
    await userEvent.setup().click(pass);

    expect(await view.findByRole('heading', { level: 2, name: 'Rent strike vote' })).toBeVisible();
    expect(view.getByRole('textbox', { name: messages.shelfEntry.linkLabel })).toHaveValue(
      `${services.origin}/${href}`,
    );
    expect(view.getByRole('button', { name: messages.shelfEntry.copy })).toBeVisible();
    expect(view.getByRole('button', { name: messages.linkShare.button })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says an entry’s link opens nothing once the shelf no longer shows it (#431)', async () => {
    const { shelf, address } = await stockedShelf();
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

    go(`#/discover/${String(address)}/${'Z'.repeat(43)}`);
    const app = mountApp(services, 'g');
    mounted.push(app);
    const view = within(app.container);

    expect(await view.findByText(messages.shelfEntry.gone)).toBeVisible();
    expect(view.queryByRole('textbox')).toBeNull();
  });

  it('shows a tombstone in place of an entry the steward upheld, naming its clause (#489)', async () => {
    const { fake, shelf, address, id } = await stockedShelf();
    await notify(fake, {
      v: 1,
      kind: 'notice',
      act: 'uphold',
      address: String(address),
      id: String(id),
      clause: 'C2',
    });
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

    go('#/discover');
    const app = mountApp(services, 'u');
    mounted.push(app);
    const view = within(app.container);
    const section = await view.findByRole('region', { name: messages.discover.shelfHeading });

    expect(within(section).getByRole('heading', { level: 3 })).toHaveTextContent('Removed: spam');
    expect(within(section).queryByText('Rent strike vote')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('hides the shelf, and an entry’s own page, behind the pause (#489)', async () => {
    const { fake, shelf, address, id } = await stockedShelf();
    await notify(fake, { v: 1, kind: 'notice', act: 'pause', on: true });
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

    go('#/discover');
    const app = mountApp(services, 'p');
    mounted.push(app);
    const view = within(app.container);
    const section = await view.findByRole('region', { name: messages.discover.shelfHeading });
    expect(within(section).getByText(messages.discover.paused)).toBeVisible();
    expect(within(section).queryByText('Rent strike vote')).toBeNull();

    go(`#/discover/${String(address)}/${String(id)}`);
    expect(await view.findByText(messages.shelfEntry.gone)).toBeVisible();
    expect(view.queryByText('Rent strike vote')).toBeNull();
  });

  it('shows nothing of the shelf when the relay has none', async () => {
    const { fake, shelf } = await stockedShelf(false);
    const device = await testDevice(createFakeRelay(), 'Nobody');
    opened.push(device);
    const services = { ...device.services, shelf: readerOf(shelf, device) };

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
    const services = { ...ana.services, shelf: readerOf(shelf, ana) };

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

describe(
  'Ask to join and Propose reconciling from a shelf entry (#432)',
  { timeout: 60_000 },
  () => {
    const ADDRESS = base64url(addressOf(DOOR));
    const SIGNING = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing;
    const ID = base64url(new Uint8Array(32).fill(6));
    const PAGE: OpenPage = {
      v: 1,
      open: true,
      name: 'Oak St Tenants',
      excerpt: 'We keep rents fair.',
      box: base64url(kxPublicKeyOf(fromBase64url(DOOR.box))),
    };
    const listing = signShelfBody(SIGNING, {
      v: 1,
      kind: 'listing',
      open: true,
      name: PAGE.name,
      skeleton: nameSkeleton(PAGE.name),
      covenant: COVENANT_HASH,
    });
    const entry = signShelfBody(SIGNING, {
      v: 1,
      kind: 'entry',
      id: ID,
      title: 'Rent strike vote',
      text: '',
    });

    /** A door with its page on `fake`, listed on a fresh shelf with one entry, read a relay day later. */
    async function listedDoor(fake: ReturnType<typeof createFakeRelay>) {
      await publishPage(
        { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal },
        DOOR,
        PAGE,
        fake.minute,
      );
      const shelfFake = createFakeShelf();
      const shelf = createShelf({ fetch: shelfFake.fetch });
      await shelf.put(ADDRESS, listing);
      await release(shelfFake, ADDRESS);
      await shelf.put(ADDRESS, entry);
      const listedAt = shelfFake.minute;
      shelfFake.minute += 1440;
      return { shelfFake, shelf, listedAt };
    }

    /** `device`, holding one personal Document, with a shelf reader on a clock the test moves. */
    async function withStatement(device: TestDevice, shelf: Shelf, clock: { ms: number }) {
      const at = Date.now();
      await device.services.store.savePersonal({
        id: newPersonalId(),
        title: 'What I stand for',
        text: 'Fair rents.',
        createdAt: at,
        updatedAt: at,
      });
      const reader = createShelfReader({ shelf, keep: device.services.store, now: () => clock.ms });
      return { ...device.services, shelf: reader };
    }

    it('opens the door from Ask to join, where a door listed a day ago takes no Documents', async () => {
      const fake = createFakeRelay();
      const { shelf } = await listedDoor(fake);
      const device = await testDevice(fake, 'Nobody');
      opened.push(device);
      const services = await withStatement(device, shelf, { ms: 0 });

      go(`#/discover/${ADDRESS}/${ID}`);
      const app = mountApp(services, 'j');
      mounted.push(app);
      const view = within(app.container);
      const ask = await view.findByRole('link', { name: messages.shelfEntry.askToJoin });
      expect(view.queryByRole('link', { name: messages.shelfEntry.proposeReconciling })).toBeNull();
      await userEvent.setup().click(ask);

      expect(await view.findByRole('heading', { level: 1, name: 'Oak St Tenants' })).toBeVisible();
      expect(view.getByText(messages.door.newlyListed)).toBeVisible();
      expect(view.queryByRole('group', { name: messages.door.documentsLabel })).toBeNull();
      expect(await axeViolations()).toEqual([]);
    });

    it('offers Documents once the door was first listed 43,200 relay minutes before', async () => {
      const fake = createFakeRelay();
      const { shelfFake, shelf, listedAt } = await listedDoor(fake);
      const device = await testDevice(fake, 'Nobody');
      opened.push(device);
      const clock = { ms: 0 };
      const services = await withStatement(device, shelf, clock);
      // The device reads the shelf a day after the listing; its group renews the listing in place later.
      await services.shelf.current();
      shelfFake.minute = listedAt + 43_000;
      await shelf.put(ADDRESS, listing);
      shelfFake.minute = listedAt + 43_199;
      clock.ms += 60 * 60 * 1000;

      go(`#door/${ADDRESS}`);
      const app = mountApp(services, 'k');
      mounted.push(app);
      const view = within(app.container);
      expect(await view.findByText(messages.door.newlyListed)).toBeVisible();
      app.unmount();
      mounted.pop();

      shelfFake.minute = listedAt + 43_200;
      clock.ms += 60 * 60 * 1000;
      const again = mountApp(services, 'l');
      mounted.push(again);
      const later = within(again.container);
      expect(await later.findByRole('group', { name: messages.door.documentsLabel })).toBeVisible();
      expect(later.queryByText(messages.door.newlyListed)).toBeNull();
      expect(await axeViolations()).toEqual([]);
    });

    it('offers Propose reconciling on a device with a group that may propose it', async () => {
      const fake = createFakeRelay();
      const { shelf } = await listedDoor(fake);
      const made = await members(fake, ['Ana']);
      opened.push(...made.devices);
      const [ana] = made.devices;
      if (ana === undefined) throw new Error('Expected Ana’s device.');
      const services = { ...ana.services, shelf: readerOfShelf(shelf, ana) };

      go(`#/discover/${ADDRESS}/${ID}`);
      const app = mountApp(services, 'r');
      mounted.push(app);
      const view = within(app.container);
      const propose = await view.findByRole('link', {
        name: messages.shelfEntry.proposeReconciling,
      });
      expect(propose).toHaveAttribute('href', `#door/${ADDRESS}`);
      await userEvent.setup().click(propose);
      expect(
        await view.findByRole('button', { name: messages.door.proposeReconciling }),
      ).toBeVisible();
    });
  },
);

/** The shelf's reader on `device`, keeping its copy in the device's store. */
const readerOfShelf = (shelf: Shelf, device: TestDevice) =>
  createShelfReader({ shelf, keep: device.services.store, now: () => 0 });
