/**
 * Linking a second device (#96) through the whole app, on a fake relay:
 * Settings opens Link a new device, which shows a real code and sends
 * nothing; Start opens Link to my other device, whose pasted code posts this
 * device's key, and nothing else, to the code's pairing mailbox. The
 * handshake and transfer themselves are `link/session.test.ts`'s, and the
 * whole loop between two browsers is `e2e/link-device.spec.ts`'s.
 */
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { pairingChannelOf, parseLinkCode } from '../crypto/link';
import { offerLink } from '../link/session';
import { openStore } from '../store/db';
import { testDevice, type TestDevice } from '../test/appServices';
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

function mount(device: TestDevice, prefix: string) {
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return within(app.container);
}

describe('linking through the app', () => {
  it('opens Link a new device from Settings, which shows a fresh code and posts nothing', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    go('#/settings');
    const app = mount(ana, 'a');
    const before = fake.requests.length;

    await user.click(await app.findByRole('link', { name: 'Link a new device' }));

    expect(window.location.hash).toBe('#/link-new');
    expect(await app.findByRole('img', { name: 'Linking code' })).toBeVisible();
    const code = app.getByText(/^RL1\./).textContent;
    expect(parseLinkCode(code)).not.toBeNull();
    await app.findByText('Waiting for your new device…');
    expect(fake.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
  });

  it('makes no code on a device whose keys another tab has just locked with a passkey (#95)', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    // Another tab locks the keys; this tab's store never unlocked the vault.
    const otherTab = await openStore('ana');
    await otherTab.sealKeys(
      { credentialId: Uint8Array.of(1), prfSalt: new Uint8Array(32).fill(2) },
      new Uint8Array(32).fill(3),
    );
    otherTab.close();
    go('#/link-new');
    const before = fake.requests.length;

    const app = mount(ana, 'a');

    expect(await app.findByRole('alert')).toHaveTextContent(
      'Your keys on this device are locked with your passkey.',
    );
    expect(app.queryByRole('img', { name: 'Linking code' })).not.toBeInTheDocument();
    expect(app.queryByText(/^RL1\./)).not.toBeInTheDocument();
    expect(fake.requests.slice(before)).toEqual([]);
  });

  it('opens Link to my other device from Start, whose pasted code posts only this device’s key', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const phone = await testDevice(fake, 'phone');
    const laptop = await testDevice(fake, 'laptop');
    opened.push(phone, laptop);
    const offer = offerLink(phone.services);
    const code = parseLinkCode(offer.code);
    if (code === null) throw new Error('Expected a code.');
    go('#/');
    const app = mount(laptop, 'l');

    await user.click(await app.findByRole('link', { name: 'Link to my other device' }));
    expect(window.location.hash).toBe('#/link-this');
    await user.type(
      await app.findByRole('textbox', { name: 'Code from your other device' }),
      offer.code,
    );
    await user.click(app.getByRole('button', { name: 'Link this device' }));

    await app.findByText('Waiting for your other device…');
    const puts = fake.requests.filter((request) => request.method === 'PUT');
    expect(puts.map((request) => new URL(request.url, 'http://relay.test').pathname)).toEqual([
      `/v1/mailbox/${pairingChannelOf(code.seed).mailbox}`,
    ]);
    expect(await laptop.services.store.listGroups()).toEqual([]);
    offer.drop();
  });
});
