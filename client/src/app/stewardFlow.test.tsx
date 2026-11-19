/**
 * The steward through the whole app (#488; listed-doors.md §6.2, §6.4): on a
 * device in no group, Settings offers the quiet Steward key section only
 * while the relay has a shelf; importing the tests' pinned secret opens the
 * console at `#/steward`, which lists a held listing beside the live one that
 * holds a name like it, and Release lets it show on Discover. A device
 * without the key that opens `#/steward` lands on Start.
 */
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf, type Shelf } from '../net/shelf';
import { createShelfReader } from '../shelf/read';
import { signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { type TestDevice, testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { createFakeShelf, release } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, type MountedApp, mountApp } from '../test/members';
import { TEST_STEWARD_SECRET } from '../test/steward';
import { messages } from './messages';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];
const words = messages.shelfSteward;
const COVENANT = base64url(new Uint8Array(32).fill(9));

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
  window.history.replaceState(null, '', '#/');
});

/** An open listing under `name`, signed by `door`. */
const listingBy = (door: ReturnType<typeof newSigningKeys>, name: string) =>
  signShelfBody(door, {
    v: 1,
    kind: 'listing',
    open: true,
    name,
    skeleton: nameSkeleton(name),
    covenant: COVENANT,
  });

/** A device in no group, reading `shelf`, with the console's client on it too. */
async function deviceOn(shelf: Shelf | undefined) {
  const device = await testDevice(createFakeRelay(), 'Nobody');
  opened.push(device);
  if (shelf === undefined) return device.services;
  const reader = createShelfReader({ shelf, keep: device.services.store, now: () => 0 });
  return { ...device.services, shelf: reader, stewardShelf: shelf };
}

describe('the steward through the app (#488, #489)', { timeout: 60_000 }, () => {
  it('shows nothing of the steward in Settings while the relay has no shelf', async () => {
    const shelf = createShelf({ fetch: createFakeShelf({ available: false }).fetch });
    const services = await deviceOn(shelf);

    go('#/settings');
    const app = mountApp(services, 'n');
    mounted.push(app);
    const view = within(app.container);
    await view.findByRole('region', { name: messages.settings.eraseHeading });

    expect(view.queryByRole('region', { name: messages.settings.stewardHeading })).toBeNull();
  });

  it('sends a device without the key from #/steward to Start', async () => {
    const services = await deviceOn(createShelf({ fetch: createFakeShelf().fetch }));

    go('#/steward');
    const app = mountApp(services, 'w');
    mounted.push(app);

    await within(app.container).findByRole('heading', { level: 1 });
    expect(window.location.hash).toBe('#/');
    expect(within(app.container).queryByText(words.title)).toBeNull();
  });

  it('imports the key in Settings, lists a held listing beside its look-alike, and releases it', async () => {
    // The release is stamped with this device's day, so the relay's clock reads it too.
    const fake = createFakeShelf({ minute: Math.floor(Date.now() / 60_000) });
    const shelf = createShelf({ fetch: fake.fetch });
    const birch = newSigningKeys();
    const oak = newSigningKeys();
    await shelf.put(base64url(birch.publicKey), listingBy(birch, 'Eastside Tenants Union'));
    await release(fake, base64url(birch.publicKey));
    await shelf.put(base64url(oak.publicKey), listingBy(oak, 'EASTSIDE TENANTS UNI0N'));
    const services = await deviceOn(shelf);
    const user = userEvent.setup();

    go('#/settings');
    const app = mountApp(services, 's');
    mounted.push(app);
    const view = within(app.container);
    const section = await view.findByRole('region', { name: messages.settings.stewardHeading });
    await user.type(within(section).getByLabelText(words.label), base64url(TEST_STEWARD_SECRET));
    await user.click(within(section).getByRole('button', { name: words.import }));
    await user.click(await within(section).findByRole('link', { name: words.open }));

    expect(await view.findByRole('heading', { level: 1, name: words.title })).toBeVisible();
    const waiting = await view.findByRole('region', { name: words.waitingHeading });
    const card = within(waiting).getByRole('listitem');
    expect(within(card).getByRole('heading', { name: 'EASTSIDE TENANTS UNI0N' })).toBeVisible();
    expect(within(card).getByText('Eastside Tenants Union')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: words.release }));
    expect(await within(card).findByText(words.released)).toBeVisible();
    expect(fake.records.every((record) => record.heldUntil === 0)).toBe(true);
    expect(await services.store.holdsStewardKey()).toBe(true);

    // #489: a hold on the live look-alike, from what stands on the shelf.
    const shelved = view.getByRole('region', { name: words.shelfHeading });
    const [hold] = within(shelved).getAllByRole('button', { name: words.hold });
    if (hold === undefined) throw new Error('Hold');
    await user.click(hold);
    await within(shelved).findByText(words.sent);
    const birchRecords = fake.records.filter((r) => r.address === base64url(birch.publicKey));
    expect(birchRecords.map((r) => r.heldUntil)).toEqual([fake.minute + 10_080]);
  });
});
