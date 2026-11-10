/**
 * Earning a vote through the whole app (#101), on several devices that share
 * one fake relay: Ana, Ben and Cal hold rights from the bootstrap, and Kim,
 * who joins fourth, reads her own line on when her vote arrives. Ana vouches
 * for her from the People list, and once it syncs every device reads "1 of 2
 * vouches" and "Vouched for by Ana", and Ana is asked for no second vouch.
 * Every change on screen comes from sync, never from a reload.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

function mount(device: TestDevice | undefined, prefix: string): HTMLElement {
  if (device === undefined) throw new Error('Expected a device.');
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice | undefined): Promise<void> {
  await act(() => device?.services.sync.syncOnce());
}

/** The People list's row for the person named, in one app. */
function row(app: HTMLElement, name: string): HTMLElement {
  const people = within(within(app).getByRole('region', { name: 'People' })).getAllByRole(
    'listitem',
  );
  const found = people.find((item) => item.querySelector('.person-name')?.textContent === name);
  if (found === undefined) throw new Error(`Expected a row for ${name}.`);
  return found;
}

describe('earning a vote in the app', () => {
  it('Ana vouches for Kim from the People list, and every device reads it', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Cal', 'Kim']);
    opened.push(...devices);
    const [ana, ben, , kim] = devices;
    go(`#/g/${groupId}`);
    const a = mount(ana, 'a');
    const b = mount(ben, 'b');
    const k = mount(kim, 'k');

    expect(
      await within(k).findByText(/^You can vote on Proposals that open after .+, once 2 people/),
    ).toBeVisible();
    // Each app renders its People list once it has read the group from the store.
    await waitFor(() => {
      expect(row(a, 'Kim')).toHaveTextContent(/New · 0 of 2 vouches · wait ends/);
    });

    await user.click(within(row(a, 'Kim')).getByRole('button', { name: 'Vouch for Kim' }));
    const dialog = await within(document.body).findByRole('dialog', { name: 'Vouch for Kim?' });
    await user.click(within(dialog).getByRole('button', { name: 'Vouch' }));

    await waitFor(() => {
      expect(row(a, 'Kim')).toHaveTextContent('Vouched for by Ana');
    });
    expect(row(a, 'Kim')).toHaveTextContent(/New · 1 of 2 vouches/);
    expect(within(a).queryByRole('button', { name: 'Vouch for Kim' })).toBeNull();
    await sync(ben);
    await sync(kim);
    await waitFor(() => {
      expect(row(b, 'Kim')).toHaveTextContent('Vouched for by Ana');
    });
    expect(within(row(b, 'Kim')).getByRole('button', { name: 'Vouch for Kim' })).toBeVisible();
    await waitFor(() => {
      expect(row(k, 'Kim')).toHaveTextContent(/New · 1 of 2 vouches/);
    });
    expect(within(k).queryByRole('button', { name: /^Vouch for/ })).toBeNull();
  });
});
