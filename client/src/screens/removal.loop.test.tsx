/**
 * Removing a member through the whole app (#115), on three devices that share
 * one fake relay: Ana proposes removing Cal from the People list, Cal posts
 * his one response from the ballot, Ana and Ben score it 4, a device that
 * folds the final pass posts the `remove`, the key changes past Cal, and his
 * device turns its copy read-only and stops syncing the group. A composer's
 * route on his device then says he was removed. Every change on screen comes
 * from sync.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { castBallot } from '../app/proposals';
import { parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
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

describe('removing a member in the app', () => {
  it('passes, takes Cal out, changes the key past him, and leaves his device a read-only copy', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Cal']);
    opened.push(...devices);
    const [ana, ben, cal] = devices;
    if (ana === undefined || ben === undefined || cal === undefined) throw new Error('3 devices');

    go(`#/g/${groupId}`);
    const a = mount(ana, 'a');
    await user.click(await within(a).findByRole('link', { name: 'Propose removing Cal' }));
    expect(
      await within(a).findByRole('heading', { level: 1, name: 'Propose a removal' }),
    ).toBeVisible();
    await user.click(within(a).getByRole('textbox', { name: 'Why' }));
    await user.paste('Threats in the group chat.');
    await user.click(within(a).getByRole('button', { name: 'Propose this removal' }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(new RegExp(`^#/g/${groupId}/p/[A-Za-z0-9_-]{43}$`));
    });
    const proposal = window.location.hash.split('/').at(-1) ?? '';
    await syncAll(devices);

    const c = mount(cal, 'c');
    const field = await within(c).findByRole('textbox', { name: 'Your response' });
    await user.click(field);
    await user.paste('I wasn’t there.');
    await user.click(within(c).getByRole('button', { name: 'Post your response' }));
    await syncAll(devices);
    expect(
      await within(c).findByRole('region', { name: 'Cal’s response' }, { timeout: 3_000 }),
    ).toHaveTextContent('I wasn’t there.');

    for (const device of [ana, ben]) {
      await castBallot(device.services, groupId, { proposal, scores: { [proposal]: 4 }, note: '' });
    }
    // The ballots go up; each device folds the pass and posts its remove; the first lands,
    // the duty writes the new key, and Cal's device reads the remove and archives the group.
    for (let pass = 0; pass < 4; pass += 1) await syncAll(devices);

    const held = await cal.services.store.getGroup(groupId);
    expect(held?.archived).toEqual({ reason: 'removed' });
    expect(held?.outbox).toEqual([]);
    const types = held?.log.map((record) => parseRecord(record.bytes)?.event.type) ?? [];
    expect(types).toContain('remove');
    for (const device of [ana, ben]) {
      const group = await device.services.store.getGroup(groupId);
      const state = fold(group?.log ?? [], group?.relayNow ?? null);
      expect(state.members.map((m) => m.name)).toEqual(['Ana', 'Ben']);
      expect(group?.epoch).toBe(1);
    }
    const before = fake.requests.length;
    await act(() => cal.services.sync.syncOnce());
    expect(fake.requests.length).toBe(before);

    go(`#/g/${groupId}`);
    expect(
      await within(c).findByText(/^You were removed from this group by a vote on .+\.$/),
    ).toBeVisible();
    go(`#/g/${groupId}/propose/${groupId}.0`);
    expect(
      await within(c).findByRole('heading', { level: 1, name: 'You were removed from this group' }),
    ).toBeVisible();
  });
});
