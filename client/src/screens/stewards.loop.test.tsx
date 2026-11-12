/**
 * Stewards through the whole app (#102), on several devices that share one
 * fake relay: the founder suspends Kim from the People list, everyone reads
 * it once it syncs, and Kim's ballot is disabled; then Ben proposes a steward
 * from Group home and the ballot reads "Make Ben steward (seat 1)". Every
 * change on screen comes from sync, never from a reload.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp, settle } from '../test/members';

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

describe('stewards in the app', () => {
  it('suspends Kim from the People list, and every device reads it', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Kim']);
    opened.push(...devices);
    const [ana, ben, kim] = devices;
    go(`#/g/${groupId}`);
    const a = mount(ana, 'a');
    const b = mount(ben, 'b');
    const k = mount(kim, 'k');

    await user.click(await within(a).findByRole('button', { name: 'Suspend Kim' }));
    const dialog = await within(document.body).findByRole('dialog', { name: 'Suspend Kim?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), 'Threats.');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));

    await waitFor(() => {
      expect(within(a).getByRole('region', { name: 'People' })).toHaveTextContent(
        /Suspended until .+\.Reason: Threats\./,
      );
    });
    await sync(ben);
    await sync(kim);
    expect(within(b).getByRole('region', { name: 'People' })).toHaveTextContent('Reason: Threats.');
    expect(
      await within(k).findByText(/^A steward suspended you until .+\. You can read, but not post/),
    ).toBeVisible();
    expect(within(a).queryByRole('button', { name: /^Suspend/ })).toBeNull();
  });

  it('proposes a steward from Group home, and the ballot says who for which seat', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben', 'Cal']);
    opened.push(...devices);
    const [, ben, cal] = devices;
    if (ben === undefined) throw new Error('Expected Ben.');
    go(`#/g/${groupId}`);
    const b = mount(ben, 'b');
    const c = mount(cal, 'c');

    await user.click(await within(b).findByRole('link', { name: 'Propose a steward for seat 1' }));
    await user.click(await within(b).findByRole('radio', { name: 'Ben' }));
    await user.click(within(b).getByRole('textbox', { name: 'Why' }));
    await user.paste('I can step in when things go wrong.');
    await user.click(within(b).getByRole('button', { name: 'Propose this steward' }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(new RegExp(`^#/g/${groupId}/p/[A-Za-z0-9_-]{43}$`));
    });
    // The Proposal's pass finishes first, so it is on the relay before Cal syncs.
    await settle(ben);

    await sync(cal);
    expect(
      await within(c).findByRole('region', { name: 'Make Ben steward (seat 1)' }),
    ).toBeVisible();
    expect(within(c).getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
  });
});
