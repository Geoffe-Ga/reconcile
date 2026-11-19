/**
 * Settings' Clear Bedfellows history (#480; ADR-0080 §5), through the whole
 * app on a real store: the button overwrites the sealed slot with an empty
 * history, so the next view starts at dial 0 with a new seed, and it sends
 * nothing anywhere.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { createBedfellowsHistory, EMPTY_HISTORY } from '../store/bedfellows';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { messages } from './messages';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
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

describe('Clear Bedfellows history (#480)', () => {
  it('forgets every record, the dial and the seed, and sends no request', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [device] = made.devices;
    if (device === undefined) throw new Error('Expected Ana’s device.');
    const { store } = device.services;
    await store.sealKeys({ credentialId: Uint8Array.of(1), prfSalt: SALT }, KEY);
    await store.keepBedfellows({
      dial: 6,
      lastStepWeek: 2919,
      seed: 4242,
      shown: [{ id: 'canary-entry', day: 20_000, mark: 'too-far' }],
    });
    // A view open in this session holds the history in memory too.
    const history = createBedfellowsHistory(store);
    await history.read();

    go('#/settings');
    const app = mountApp(device.services, 'p');
    mounted.push(app);
    const section = await within(app.container).findByRole('region', {
      name: messages.settings.bedfellowsHeading,
    });
    await device.services.sync.halt();
    const before = fake.requests.length;
    await userEvent
      .setup()
      .click(within(section).getByRole('button', { name: messages.bedfellowsHistory.clear }));
    await waitFor(() => {
      expect(within(section).getByRole('status')).toHaveTextContent(
        messages.bedfellowsHistory.cleared,
      );
    });

    expect(await store.readBedfellows()).toEqual(EMPTY_HISTORY);
    const view = await history.read();
    expect(view).toMatchObject({ dial: 0, shown: [], leaveOut: [] });
    expect(view.seed).not.toBe(4242);
    expect(fake.requests.length).toBe(before);
    history.close();
  });
});
