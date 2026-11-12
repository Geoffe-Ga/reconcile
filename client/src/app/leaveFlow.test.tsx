/**
 * Coming back, telling the group, and leaving (#77), through the whole app on
 * devices that share one fake relay: Group home leads with what needs your
 * vote, Tell your group shares fixed words only, and Leave deletes the group
 * once the relay has the leave, even when the leave waited offline through a
 * reload.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TestDevice } from '../test/appServices';
import { TEST_ORIGIN, testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { mailboxAt } from '../store/mailbox';
import {
  appUser,
  go,
  members,
  type MountedApp,
  mountApp,
  proposeFrom,
  score,
} from '../test/members';
import type { AppServices } from './services';
import { chatMessage } from './chatMessages';
import type { WebShare } from './share';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function group(names: readonly string[]) {
  const fake = createFakeRelay();
  const made = await members(fake, names);
  opened.push(...made.devices);
  return { fake, ...made };
}

function mount(services: AppServices | undefined, prefix: string): HTMLElement {
  if (services === undefined) throw new Error('Expected a device.');
  const app = mountApp(services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice | undefined): Promise<void> {
  await act(() => device?.services.sync.syncOnce());
}

describe('Group home brings people back', () => {
  it('lists a new Proposal under Needs your vote for the others, and not once they’ve voted', async () => {
    const user = appUser();
    const { groupId, devices } = await group(['Ana', 'Ben']);
    const [ana, ben] = devices;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana?.services, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    await within(a).findByRole('button', { name: 'Tell your group' });

    await sync(ben);
    go(`#/g/${groupId}`);
    const b = mount(ben?.services, 'b');
    const needs = await within(b).findByRole('region', { name: 'Needs your vote' });
    await user.click(within(needs).getByRole('link', { name: /Quiet hours/ }));
    await score(within(b), user, '3 · Supportive');
    await within(b).findByText('Sent');

    go(`#/g/${groupId}`);
    const open = await within(b).findByRole('region', { name: 'Open Proposals' });
    expect(within(open).getByRole('link', { name: /Quiet hours/ })).toBeVisible();
    expect(within(b).queryByRole('region', { name: 'Needs your vote' })).not.toBeInTheDocument();
  });
});

describe('Tell your group', () => {
  it('shares fixed words, the deadline and the app’s address, with no title, once the Proposal is sent', async () => {
    const user = userEvent.setup();
    const { groupId, devices } = await group(['Ana', 'Ben']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected a device.');
    const share = vi.fn<WebShare>(() => Promise.resolve());
    go(`#/g/${groupId}/doc`);
    const a = mount({ ...ana.services, share }, 'a');
    await proposeFrom(within(a), user, 1, {
      title: 'Quiet hours',
      why: 'People sleep earlier.',
      text: 'Quiet after 10pm.',
    });

    await user.click(await within(a).findByRole('button', { name: 'Tell your group' }));

    const stored = await ana.services.store.getGroup(groupId);
    const proposal = stored?.log.at(-1);
    expect(proposal).toBeDefined();
    expect(share).toHaveBeenCalledTimes(1);
    const [data] = share.mock.calls[0] ?? [];
    expect(data).toEqual({
      text: chatMessage('open', { deadline: (proposal?.received ?? 0) + 7 * 1_440 }),
      url: `${TEST_ORIGIN}/`,
    });
    expect(data !== undefined && 'title' in data).toBe(false);
    expect(window.location.hash).toContain(groupId);
    for (const word of [groupId, 'Riverside', 'Quiet', 'House rules', 'Ana', 'Ben', '#']) {
      expect(JSON.stringify(data)).not.toContain(word);
    }
    expect(await within(a).findByText('Shared.')).toBeVisible();
  });

  it('lets anyone add the title for one share, and sharing sends the relay nothing', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [ana, ben] = devices;
    if (ben === undefined) throw new Error('Expected a device.');
    go(`#/g/${groupId}/doc`);
    const a = mount(ana?.services, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    await within(a).findByRole('button', { name: 'Tell your group' });
    await sync(ben);
    const share = vi.fn<WebShare>(() => Promise.resolve());
    go(`#/g/${groupId}`);
    const b = mount({ ...ben.services, share }, 'b');
    const needs = await within(b).findByRole('region', { name: 'Needs your vote' });
    await user.click(within(needs).getByRole('link', { name: /Quiet hours/ }));
    const requests = fake.requests.length;

    await user.click(await within(b).findByRole('checkbox', { name: 'Include the title' }));
    await user.click(within(b).getByRole('button', { name: 'Tell your group' }));

    const [data] = share.mock.calls[0] ?? [];
    expect(data?.text).toMatch(
      /^A new Proposal is open in Reconcile: "Quiet hours"\. Voting ends \w{3} \d{1,2} \w{3}\.$/,
    );
    for (const word of [groupId, 'Riverside', 'House rules', 'Ana', 'Ben', '#']) {
      expect(JSON.stringify(data)).not.toContain(word);
    }
    expect(await within(b).findByText('Shared.')).toBeVisible();
    expect(within(b).getByRole('checkbox', { name: 'Include the title' })).not.toBeChecked();
    expect((await ben.services.store.getGroup(groupId))?.outbox).toEqual([]);
    expect(fake.requests).toHaveLength(requests);
  });

  it('copies the same words where the browser has no Web Share, and says so', async () => {
    const user = userEvent.setup();
    const { groupId, devices } = await group(['Ana', 'Ben']);
    const [ana] = devices;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana?.services, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });

    await user.click(await within(a).findByRole('button', { name: 'Tell your group' }));

    expect(await within(a).findByText('Copied. Paste it into your group’s chat.')).toBeVisible();
    expect(ana?.copied).toHaveLength(1);
    expect(ana?.copied[0]).toMatch(
      /^A new Proposal is open in Reconcile\. Voting ends \w{3} \d{1,2} \w{3}\. https:\/\/reconcile\.test\/$/,
    );
  });
});

describe('Leave this group', () => {
  it('goes to Your groups, and the group leaves this device once the relay has the leave', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [ana, ben] = devices;
    go(`#/g/${groupId}`);
    const b = mount(ben?.services, 'b');
    const people = await within(b).findByRole('region', { name: 'People' });
    await user.click(within(people).getByRole('button', { name: 'Leave this group' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Leave this group' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
    await sync(ben);
    expect(await ben?.services.store.listGroups()).toEqual([]);
    expect(
      await within(b).findByText('You aren’t in any groups on this device yet.'),
    ).toBeVisible();
    const secret = (await ana?.services.store.getGroup(groupId))?.secret ?? new Uint8Array();
    expect(fake.blobs(mailboxAt({ secret }, fake.minute))).toHaveLength(3);

    // Ana's device sees Ben gone from People.
    await sync(ana);
    go(`#/g/${groupId}`);
    const a = mount(ana?.services, 'a');
    const rows = await within(a).findByRole('region', { name: 'People' });
    expect(
      within(rows)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Ana, Co-Creator, Steward']);
  });

  it('waits offline as Leaving…, through a reload, with proposing and voting off, then goes', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [, ben] = devices;
    if (ben === undefined) throw new Error('Expected a device.');
    fake.offline = true;
    go(`#/g/${groupId}`);
    const first = mountApp(ben.services, 'b1');
    const b = first.container;
    await user.click(await within(b).findByRole('button', { name: 'Leave this group' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Leave this group' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
    const item = await within(b).findByRole('link', { name: /Riverside Tenants/ });
    expect(within(item).getByText('Leaving…')).toBeVisible();

    // Its home says so and takes no votes; its Document takes no Proposals.
    await user.click(item);
    expect(await within(b).findByText('Leaving…', { selector: '.leaving-note *' })).toBeVisible();
    expect(within(b).queryByRole('button', { name: 'Leave this group' })).not.toBeInTheDocument();
    go(`#/g/${groupId}/doc`);
    await within(b).findByText('Quiet hours start at ten.');
    expect(within(b).queryByRole('button', { name: /Propose a change/ })).not.toBeInTheDocument();

    // A reload: the app and store open again on the same database.
    first.unmount();
    ben.services.store.close();
    const reopened = await testDevice(fake, 'ben');
    opened.push(reopened);
    go('#/');
    const again = mount(reopened.services, 'b2');
    const kept = await within(again).findByRole('link', { name: /Riverside Tenants/ });
    expect(within(kept).getByText('Leaving…')).toBeVisible();
    await sync(reopened);
    expect(await reopened.services.store.getGroup(groupId)).toBeDefined();

    fake.offline = false;
    await sync(reopened);
    expect(await reopened.services.store.getGroup(groupId)).toBeUndefined();
    expect(
      await within(again).findByText('You aren’t in any groups on this device yet.'),
    ).toBeVisible();
  });
});
