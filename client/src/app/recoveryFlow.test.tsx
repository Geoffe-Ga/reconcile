/**
 * Recovery contacts (#109) through the whole app, on devices that share one
 * fake relay: Ana opens the picker from Settings, which starts at 3 of 5 and
 * lists only the other people in her group; she saves 2 of 3, and Settings
 * says so; each contact's Settings lists the share they hold, and their
 * group home shows it once, until OK; and once a contact leaves, Ana's
 * Settings says they no longer share a group and asks her to choose again.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { fold } from '../engine/fold';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { leaveGroup } from './actions';

freshIndexedDBPerTest();

/** Saving starts the relay backup and sends the shares, so Settings comes back after a moment. */
const SAVED = { timeout: 5_000 };

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

function mount(device: TestDevice, prefix: string) {
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return within(app.container);
}

function unmountAll(): void {
  for (const app of mounted.splice(0)) app.unmount();
}

/** Ana, Ben, Cal and Dee in Ana's group, every device synced. */
async function fourMembers() {
  const made = await members(createFakeRelay(), ['Ana', 'Ben', 'Cal', 'Dee']);
  opened.push(...made.devices);
  const [ana, ben, cal, dee] = made.devices;
  if (!ana || !ben || !cal || !dee) throw new Error('Expected four devices.');
  return { groupId: made.groupId, ana, ben, cal, dee, devices: made.devices };
}

/** Every device syncs twice, so each sees what the others sent. */
async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const device of devices) await device.services.sync.syncOnce();
  }
}

/** Ana picks Ben, Cal and Dee at 2 of 3 from Settings, through the picker. */
async function chooseFromSettings(ana: TestDevice) {
  const user = userEvent.setup();
  go('#/settings');
  const app = mount(ana, 'a');
  const section = await app.findByRole('region', { name: 'Recovery contacts' });
  expect(section).toHaveTextContent('You haven’t chosen anyone yet.');
  await user.click(within(section).getByRole('link', { name: 'Choose recovery contacts' }));
  expect(window.location.hash).toBe('#/recovery');
  await app.findByRole('heading', { level: 1, name: 'Choose recovery contacts' });
  return { user, app };
}

// Each test runs four real devices, the real relay backup and real crypto on the fake relay.
describe('choosing recovery contacts through the app', { timeout: 30_000 }, () => {
  it('starts at 3 of 5, lists the others in the group but never Ana, and saves 2 of 3', async () => {
    const { groupId, ana, ben, devices } = await fourMembers();
    const { user, app } = await chooseFromSettings(ana);

    expect(app.getByRole('textbox', { name: 'People to pick' })).toHaveValue('5');
    expect(app.getByRole('textbox', { name: 'Needed to help you back in' })).toHaveValue('3');
    const people = app.getByRole('group', { name: 'People in Riverside Tenants' });
    const names = within(people)
      .getAllByRole('checkbox')
      .map((box) => box.closest('label')?.textContent);
    expect(names).toEqual(['Ben', 'Cal', 'Dee']);
    expect(await axeViolations()).toEqual([]);

    await user.clear(app.getByRole('textbox', { name: 'People to pick' }));
    await user.type(app.getByRole('textbox', { name: 'People to pick' }), '3');
    await user.tab();
    await user.click(app.getByRole('button', { name: 'Decrease Needed to help you back in' }));
    for (const name of ['Ben', 'Cal', 'Dee']) {
      await user.click(app.getByRole('checkbox', { name }));
    }
    await user.click(app.getByRole('button', { name: 'Save recovery contacts' }));

    const section = await app.findByRole('region', { name: 'Recovery contacts' }, SAVED);
    expect(window.location.hash).toBe('#/settings');
    expect(section).toHaveTextContent('3 recovery contacts · 2 needed');
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Ben in Riverside Tenants', 'Cal in Riverside Tenants', 'Dee in Riverside Tenants']);
    expect(within(section).getByRole('link', { name: 'Choose again' })).toBeVisible();
    // Choosing started the relay backup, whose line now shows above.
    const backup = app.getByRole('region', { name: 'Back up your groups' });
    expect(within(backup).getByText(/to the relay/)).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    // Each contact's share went to the group's log, opaque: three from Ana, naming no one.
    unmountAll();
    await syncAll(devices);
    const kept = await ben.services.store.getGroup(groupId);
    const state = kept === undefined ? null : fold(kept.log, kept.relayNow);
    const author = (await ana.services.store.getGroup(groupId))?.me.author;
    expect(state?.recoveryShares.map(({ by }) => by)).toEqual([author, author, author]);
  });

  it('shows each contact the share they hold, in Settings and once on group home', async () => {
    const { groupId, ana, ben, devices } = await fourMembers();
    const { user, app } = await chooseFromSettings(ana);
    await user.clear(app.getByRole('textbox', { name: 'People to pick' }));
    await user.type(app.getByRole('textbox', { name: 'People to pick' }), '3');
    await user.tab();
    for (const name of ['Ben', 'Cal', 'Dee']) {
      await user.click(app.getByRole('checkbox', { name }));
    }
    await user.click(app.getByRole('button', { name: 'Save recovery contacts' }));
    await app.findByText('3 recovery contacts · 3 needed', {}, SAVED);
    unmountAll();
    await syncAll(devices);

    go('#/settings');
    let bens = mount(ben, 'b');
    const held = await bens.findByRole('region', { name: 'Recovery contacts' });
    await waitFor(() => {
      expect(
        within(held).getByRole('heading', { level: 3, name: 'Shares you hold' }),
      ).toBeVisible();
    });
    expect(within(held).getAllByRole('listitem').at(-1)).toHaveTextContent(
      'You’re holding a recovery share for Ana (Riverside Tenants)',
    );
    expect(await axeViolations()).toEqual([]);
    unmountAll();

    go(`#/g/${groupId}`);
    bens = mount(ben, 'c');
    const line = await bens.findByText(
      (_text, element) =>
        element?.tagName === 'LI' &&
        element.textContent === 'You’re holding a recovery share for Ana (Riverside Tenants)',
    );
    expect(line).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    await user.click(bens.getByRole('button', { name: 'OK' }));
    await waitFor(() => {
      expect(bens.queryByText(/You’re holding a recovery share/)).not.toBeInTheDocument();
    });
    unmountAll();

    go(`#/g/${groupId}`);
    bens = mount(ben, 'd');
    await bens.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(bens.queryByText(/You’re holding a recovery share/)).not.toBeInTheDocument();
  });

  it('says a contact who left no longer shares a group, and asks to choose again below t', async () => {
    const { groupId, ana, cal, devices } = await fourMembers();
    const { user, app } = await chooseFromSettings(ana);
    await user.clear(app.getByRole('textbox', { name: 'People to pick' }));
    await user.type(app.getByRole('textbox', { name: 'People to pick' }), '3');
    await user.tab();
    for (const name of ['Ben', 'Cal', 'Dee']) {
      await user.click(app.getByRole('checkbox', { name }));
    }
    await user.click(app.getByRole('button', { name: 'Save recovery contacts' }));
    await app.findByText('3 recovery contacts · 3 needed', {}, SAVED);
    unmountAll();

    await leaveGroup(cal.services, groupId);
    await syncAll(devices);

    go('#/settings');
    const settings = mount(ana, 'e');
    const section = await settings.findByRole('region', { name: 'Recovery contacts' });
    await waitFor(() => {
      expect(section).toHaveTextContent('Cal in Riverside Tenants No longer in a shared group');
    });
    expect(section).toHaveTextContent(
      'Fewer than 3 of your recovery contacts still share a group with you. Choose again so they can help you back in.',
    );
    expect(await axeViolations()).toEqual([]);

    // Choosing again starts from the two still here, at 3 of 3.
    await user.click(within(section).getByRole('link', { name: 'Choose again' }));
    await settings.findByRole('heading', { level: 1, name: 'Choose again' });
    expect(settings.getByRole('checkbox', { name: 'Ben' })).toBeChecked();
    expect(settings.getByRole('checkbox', { name: 'Dee' })).toBeChecked();
    expect(settings.queryByRole('checkbox', { name: 'Cal' })).toBeNull();
    expect(settings.getByRole('status')).toHaveTextContent('2 of 3 picked.');
  });
});
