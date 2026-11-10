/**
 * Dissolving through the whole app (#108), on three devices that share one
 * fake relay: Ana proposes it from the bottom of Group home, everyone scores
 * it 4, a device that folds the final pass posts the `dissolve`, and every
 * device turns its copy read-only and stops syncing the group. A composer's
 * route then says the group has dissolved, and Remove from this device
 * erases Ana's copy. Every change on screen comes from sync.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { castBallot } from '../app/proposals';
import { parseRecord } from '../engine/event';
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

function mount(device: TestDevice, prefix: string): HTMLElement {
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await act(() => device.services.sync.syncOnce());
}

/** From Group home, through the composer, to the new dissolve Proposal; returns its id. */
async function proposeDissolving(app: HTMLElement, groupId: string): Promise<string> {
  const user = userEvent.setup();
  await user.click(await within(app).findByRole('link', { name: 'Propose dissolving the group' }));
  await user.click(await within(app).findByRole('textbox', { name: 'Title' }));
  await user.paste('Dissolve Riverside');
  await user.click(within(app).getByRole('textbox', { name: 'Why' }));
  await user.paste('We have all moved out.');
  await user.click(within(app).getByRole('button', { name: 'Propose dissolving' }));
  await waitFor(() => {
    expect(window.location.hash).toMatch(new RegExp(`^#/g/${groupId}/p/[A-Za-z0-9_-]{43}$`));
  });
  return window.location.hash.split('/').at(-1) ?? '';
}

/** Each device holds the group archived, with nothing waiting to send, and the log holds a dissolve. */
async function expectArchived(devices: readonly TestDevice[], groupId: string): Promise<void> {
  for (const device of devices) {
    const group = await device.services.store.getGroup(groupId);
    expect(group?.archived).toEqual({ reason: 'dissolved' });
    expect(group?.outbox).toEqual([]);
    const kinds = group?.log.map((record) => parseRecord(record.bytes)?.event.type) ?? [];
    expect(kinds).toContain('dissolve');
  }
}

describe('dissolving a group in the app', () => {
  it('passes, ends the group on every device, and leaves each a read-only copy it can remove', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Cal']);
    opened.push(...devices);
    const [ana, ben, cal] = devices;
    if (ana === undefined || ben === undefined || cal === undefined) throw new Error('3 devices');
    go(`#/g/${groupId}`);
    const a = mount(ana, 'a');

    const proposal = await proposeDissolving(a, groupId);
    await syncAll(devices);
    for (const device of devices) {
      await castBallot(device.services, groupId, { proposal, scores: { [proposal]: 4 }, note: '' });
    }
    // The ballots go up, then every device reads all three and posts its dissolve,
    // then each reads the first one and archives the group.
    await syncAll(devices);
    await syncAll(devices);
    await syncAll(devices);

    const before = fake.requests.length;
    await syncAll(devices);
    expect(fake.requests.length).toBe(before);
    await expectArchived(devices, groupId);

    go(`#/g/${groupId}`);
    const b = mount(ben, 'b');
    const c = mount(cal, 'c');
    for (const app of [a, b, c]) {
      expect(
        await within(app).findByText(/^This group dissolved on .+\. This is a read-only copy\.$/),
      ).toBeVisible();
    }

    go(`#/g/${groupId}/propose/${groupId}.0`);
    expect(
      await within(a).findByRole('heading', { level: 1, name: 'This group has dissolved' }),
    ).toBeVisible();
    go(`#/g/${groupId}/dissolve`);
    expect(
      await within(b).findByRole('heading', { level: 1, name: 'This group has dissolved' }),
    ).toBeVisible();

    go(`#/g/${groupId}`);
    await user.click(await within(a).findByRole('button', { name: 'Remove from this device' }));
    const dialog = await within(document.body).findByRole('alertdialog', {
      name: 'Remove this group from this device?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
    expect(await ana.services.store.getGroup(groupId)).toBeUndefined();
    expect(await ben.services.store.getGroup(groupId)).toBeDefined();
  });
});
