/**
 * Telling affected devices through the whole app (#491; listed-doors.md
 * §6.5): a device that asked to join at a door the steward then suspended
 * reads one line on Start and on Discover, matched on the device from the
 * shelf it reads anyway. Every request is captured: once the shelf's hourly
 * read is in, showing, matching and dismissing the line send nothing, to the
 * relay or the shelf, so the platform never learns which devices matched.
 * Dismissed on Start, it shows on neither screen again, after a reload too.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf } from '../net/shelf';
import { createShelfReader } from '../shelf/read';
import { signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { type TestDevice, testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { createFakeShelf, notify, release } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, type MountedApp, mountApp } from '../test/members';
import { messages } from './messages';
import { formatDay } from './time';

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

const words = messages.removals;

describe(
  'A removed door, told on the device that asked to join it (#491)',
  { timeout: 60_000 },
  () => {
    it('shows on Start and Discover, dismisses for good, and sends no request doing it', async () => {
      const fakeShelf = createFakeShelf();
      const shelf = createShelf({ fetch: fakeShelf.fetch });
      const door = newSigningKeys();
      const address = base64url(door.publicKey);
      const name = 'Oak St Tenants';
      await shelf.put(
        address,
        signShelfBody(door, {
          v: 1,
          kind: 'listing',
          open: true,
          name,
          skeleton: nameSkeleton(name),
          covenant: base64url(new Uint8Array(32).fill(9)),
        }),
      );
      await release(shelf, address);
      await notify(shelf, { v: 1, kind: 'notice', act: 'suspend', address, clause: 'C2' });

      const fake = createFakeRelay();
      const device = await testDevice(fake, 'Nobody');
      opened.push(device);
      const { store } = device.services;
      const sentAt = device.services.now();
      await store.addSent({
        id: 'app-1',
        door: address,
        groupName: name,
        seed: new Uint8Array(32).fill(1),
        replyKey: new Uint8Array(32).fill(2),
        sentAt,
      });
      const reader = createShelfReader({ shelf, keep: store, now: () => 0 });
      // The hourly read every device makes, whoever it is: the same for all.
      await reader.current();
      const relayAsked = fake.requests.length;
      const shelfAsked = fakeShelf.urls.length;
      const services = { ...device.services, shelf: reader };

      go('#/');
      const app = mountApp(services, 's');
      mounted.push(app);
      const view = within(app.container);
      const line = words.asked(formatDay(sentAt), 'spam');
      const card = await view.findByRole('region', { name: words.heading });
      expect(card).toHaveTextContent(line);

      go('#/discover');
      const onDiscover = await view.findByRole('region', { name: words.heading });
      expect(onDiscover).toHaveTextContent(line);
      await userEvent
        .setup()
        .click(within(onDiscover).getByRole('button', { name: words.dismiss }));
      await waitFor(async () => {
        expect((await store.removalsAt(sentAt)).dismissed).toEqual([address]);
      });
      expect(view.queryByRole('region', { name: words.heading })).toBeNull();

      // A reload: the app mounts again, on Start, and the line stays dismissed.
      app.unmount();
      mounted.splice(0);
      go('#/');
      const again = mountApp(services, 'r');
      mounted.push(again);
      const reloaded = within(again.container);
      await reloaded.findByRole('heading', { level: 1, name: messages.start.title });
      await store.removalsAt(sentAt);
      expect(reloaded.queryByRole('region', { name: words.heading })).toBeNull();

      expect(fake.requests.slice(relayAsked).map((r) => r.url)).toEqual([]);
      expect(fakeShelf.urls.slice(shelfAsked)).toEqual([]);
    });
  },
);
