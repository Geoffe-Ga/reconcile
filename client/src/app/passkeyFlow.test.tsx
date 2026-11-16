/**
 * A passkey locks nothing until the groups have a way back (#389), through
 * the whole app on a real store and a fake authenticator. Settings sends the
 * person to Save a backup above, and opens setup the moment the file is
 * saved. A device whose keys were locked before the rule stays locked and
 * opens as before, and Settings asks it for a way back, which goes once
 * there is one.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type TestDevice, withPasskey } from '../test/appServices';
import { fakeAuthenticator } from '../test/fakeAuthenticator';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { messages } from './messages';

freshIndexedDBPerTest();

// A cheap scrypt cost: the default's second per key is pinned in crypto/backup.test.ts.
vi.mock('../crypto/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/backup')>();
  return {
    ...actual,
    sealBackup: (plaintext: Uint8Array, passphrase: string) =>
      actual.sealBackup(plaintext, passphrase, 4),
  };
});

const PASSPHRASE = 'a long walk to the river';
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

/** Ana's device with her one group, whose browser can make passkeys. */
async function ana() {
  const made = await members(createFakeRelay(), ['Ana']);
  opened.push(...made.devices);
  const [device] = made.devices;
  if (device === undefined) throw new Error('Expected Ana’s device.');
  const authenticator = fakeAuthenticator();
  return { device: withPasskey(device, authenticator), authenticator, groupId: made.groupId };
}

/** Settings on `device`, and its passkey section. */
async function settings(device: TestDevice) {
  go('#/settings');
  const app = mountApp(device.services, 'p');
  mounted.push(app);
  const section = await within(app.container).findByRole('region', {
    name: messages.settings.passkeyHeading,
  });
  return { view: app.container, section };
}

/** Saves a backup file from Settings' Save a backup, through the download path. */
async function saveBackup(container: HTMLElement) {
  const view = within(container);
  const user = userEvent.setup();
  await user.type(view.getByLabelText(messages.backup.passphrase), PASSPHRASE);
  await user.type(view.getByLabelText(messages.backup.confirm), PASSPHRASE);
  await user.click(view.getByRole('button', { name: messages.backup.make }));
  await user.click(await view.findByRole('button', { name: messages.backup.save }));
  await view.findByText(messages.backup.saved);
}

describe('a passkey and the way back (#389)', { timeout: 60_000 }, () => {
  it('waits in Settings for a backup file of every group, then locks the keys', async () => {
    const { device } = await ana();
    const { view, section } = await settings(device);

    expect(await within(section).findByText(messages.passkey.settingsGate)).toBeVisible();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();

    await saveBackup(view);
    const make = await within(section).findByRole('button', { name: messages.passkey.create });
    const user = userEvent.setup();
    await user.click(make);
    await user.click(
      await within(section).findByRole('button', { name: messages.passkey.confirm }),
    );

    expect(await within(section).findByText(messages.passkey.locked)).toBeVisible();
    expect(await device.services.store.readVault()).not.toBeNull();
  });

  it('keeps a device locked before the rule locked, and asks it for a way back until there is one', async () => {
    const { device } = await ana();
    // Locked the way #95 locked it, with no way back: straight through the store.
    const { passkey } = device.services;
    const id = await passkey.create();
    const store = device.services.store;
    await store.sealKeys(
      { credentialId: id, prfSalt: new Uint8Array(32).fill(3) },
      new Uint8Array(32).fill(9),
    );
    expect(await store.readVault()).not.toBeNull();

    const { view, section } = await settings(device);
    expect(await within(section).findByText(messages.passkey.lockedNoWayBack)).toBeVisible();
    expect(within(section).getByText(messages.passkey.locked)).toBeVisible();

    await saveBackup(view);
    await waitFor(() => {
      expect(within(section).queryByText(messages.passkey.lockedNoWayBack)).not.toBeInTheDocument();
    });
    // Still locked: nothing was unsealed.
    expect(within(section).getByText(messages.passkey.locked)).toBeVisible();
    expect(await store.readVault()).not.toBeNull();
  });
});
