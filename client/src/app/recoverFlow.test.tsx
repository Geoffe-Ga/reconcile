/**
 * Recovering with contacts (#118) through the whole app, on devices that
 * share one fake relay: Ben approves from Settings › Help someone recover;
 * Ana's Start and group home show the alert and cancel it; and a fresh
 * device recovers from Start, asks whether the groups it found are hers
 * (#398), and on Yes opens the picker asking Ana to choose her contacts
 * again.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { newRecoveryKeys, recoveryCheck, recoveryCode, recoveryNumber } from '../crypto/recovery';
import { approveRecovery } from '../recovery/holder';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, type MountedApp, mountApp } from '../test/members';
import { HOLD, keyOf, recoveryWorld } from '../test/recovery';
import { messages } from './messages';

freshIndexedDBPerTest();

const SYNCED = { timeout: 8_000 };

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

describe('recovering with contacts through the app', { timeout: 60_000 }, () => {
  it('Ben approves from Settings; Ana’s Start and group home show the alert, and Cancel stops it', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    const request = newRecoveryKeys();
    const code = recoveryCode(request);
    const user = userEvent.setup();

    go('#/settings');
    let app = mount(world.ben, 'b');
    const section = await app.findByRole('region', { name: 'Recovery contacts' });
    await user.click(within(section).getByRole('link', { name: messages.recovery.help }));
    expect(window.location.hash).toBe('#/help-recover');
    await app.findByRole('heading', { level: 1, name: messages.helpRecover.title });
    await user.click(app.getByRole('textbox', { name: messages.helpRecover.codeLabel }));
    await user.paste(code);
    await user.click(app.getByRole('button', { name: messages.helpRecover.next }));
    expect(app.getByRole('radio', { name: 'Ana (Riverside Tenants)' })).toBeChecked();
    expect(await axeViolations()).toEqual([]);
    await user.type(
      app.getByRole('textbox', { name: messages.helpRecover.numberLabel }),
      recoveryCheck(code),
    );
    await user.type(
      app.getByRole('textbox', { name: messages.helpRecover.secondLabel }),
      recoveryNumber(request.secretKey),
    );
    await user.click(app.getByRole('button', { name: messages.helpRecover.approve }));
    const holds = await app.findByRole('list', { name: messages.helpRecover.heldHeading }, SYNCED);
    await waitFor(() => {
      expect(holds).toHaveTextContent(/^Holding Ana’s share until .+\. Open Reconcile after then/);
    }, SYNCED);
    expect(await axeViolations()).toEqual([]);
    unmountAll();

    await world.ana.services.sync.syncOnce();
    go('#/');
    app = mount(world.ana, 'a');
    const alert = await app.findByText(/^Someone asked your recovery contacts/, {}, SYNCED);
    expect(alert.closest('.recovery-alert')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
    go(`#/g/${world.groupId}`);
    await app.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(app.getByText(/^Someone asked your recovery contacts/)).toBeVisible();
    await user.click(app.getByRole('button', { name: messages.recoveryAlert.cancel }));
    expect(await app.findByText(messages.recoveryAlert.cancelled, {}, SYNCED)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    unmountAll();

    // Test devices don't poll: two passes, as the poller would make, the first maybe joined
    // to one that was already on its way when the cancel was queued.
    await world.ana.services.sync.syncOnce();
    await world.ana.services.sync.syncOnce();
    await world.ben.services.sync.syncOnce();
    go('#/help-recover');
    app = mount(world.ben, 'b2');
    expect(await app.findByText(/this recovery was cancelled/, {}, SYNCED)).toHaveTextContent(
      'Ana’s share stays with you: this recovery was cancelled.',
    );
  });

  it('a fresh device recovers from Start, then asks Ana to choose her contacts again', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    const fresh = await testDevice(fake, 'fresh');
    opened.push(...world.devices, fresh);
    const user = userEvent.setup();

    go('#/');
    const app = mount(fresh, 'f');
    const lost = await app.findByRole('region', { name: messages.start.recoverHeading });
    await user.click(within(lost).getByRole('link', { name: messages.start.recover }));
    expect(window.location.hash).toBe('#/recover');
    const field = await app.findByRole('textbox', { name: messages.recover.codeLabel });
    const code = (field as HTMLInputElement).value;
    expect(code).toMatch(/^RR1\./);
    const check = recoveryCheck(code);
    expect(app.getByText(`${check.slice(0, 3)} ${check.slice(3)}`)).toBeVisible();
    // The second number, read off the screen as Ana would read it out (#398).
    const [, second] = app.getAllByRole('definition');
    const number = second?.textContent ?? '';
    const kept = await fresh.services.store.getRecoverRequest();
    expect(number.replace(' ', '')).toBe(recoveryNumber(kept?.secretKey ?? new Uint8Array(32)));
    expect(await axeViolations()).toEqual([]);

    for (const [contact, groupId] of [
      [world.ben, world.groupId],
      [world.dee, world.groupId],
    ] as const) {
      const person = await keyOf(world.ana, groupId);
      await approveRecovery(contact.services, { code, groupId, person, check, number });
    }
    fake.minute += HOLD;
    await world.ben.services.sync.syncOnce();
    await world.dee.services.sync.syncOnce();

    // Nothing is restored until Ana says these are her groups (#398).
    const question = await app.findByRole(
      'region',
      { name: messages.recover.foundHeading },
      SYNCED,
    );
    expect(
      within(question)
        .getAllByRole('listitem')
        .map((line) => line.textContent),
    ).toEqual(['Riverside Tenants', 'Riverside Tenants']);
    expect(await fresh.services.store.listGroups()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
    await user.click(within(question).getByRole('button', { name: messages.recover.yes }));

    expect(await app.findByText(messages.recovery.recovered, {}, SYNCED)).toBeVisible();
    expect(window.location.hash).toBe('#/recovery');
    expect(await axeViolations()).toEqual([]);
    expect((await fresh.services.store.listGroups()).map(({ groupId }) => groupId).sort()).toEqual(
      [world.groupId, world.allotment].sort(),
    );
  });
});
