/**
 * The tracer loop closes (#66): Propose → Vote → Update, on several devices
 * that share one fake relay. Each device's app stays mounted throughout, so
 * every change on screen comes from sync, never from a reload.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { VOTE_WINDOW_MINUTES } from '../engine/fold';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  go,
  joinLater,
  members,
  type MountedApp,
  mountApp,
  proposeFrom,
  score,
} from '../test/members';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function group(names: readonly string[], chat: string | null = null) {
  const fake = createFakeRelay();
  const made = await members(fake, names, chat);
  opened.push(...made.devices);
  return { fake, ...made };
}

function mount(device: TestDevice | undefined, prefix: string): HTMLElement {
  if (device === undefined) throw new Error('Expected a device.');
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice | undefined): Promise<void> {
  await act(() => device?.services.sync.syncOnce());
}

describe('propose, vote, and see the Update', () => {
  it('closes early once everyone has scored, and both devices show the new text', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [ana, ben] = devices;
    const startMinute = fake.minute;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana, 'a');
    const b = mount(ben, 'b');

    // A proposes new wording for the first section, and lands on its ballot.
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    // Proposing reads the group's key from the store and signs before the route moves on.
    await waitFor(() => {
      expect(window.location.hash).toMatch(new RegExp(`^#/g/${groupId}/p/[A-Za-z0-9_-]{43}$`));
    });
    await score(within(a), user, '3 · Supportive');
    expect(await within(a).findByText('Sent')).toBeVisible();

    // B syncs, sees the Proposal appear, and scores it.
    await sync(ben);
    expect(await within(b).findByRole('heading', { level: 1, name: 'Quiet hours' })).toBeVisible();
    await score(within(b), user, '4 · Strongly supportive');

    // B's send reads back both ballots: everyone has scored, so the vote closes early.
    const bResult = await within(b).findByRole('region', { name: 'Result' });
    expect(bResult).toHaveTextContent('This passed. The Document now reads:Quiet after 10pm.');
    await sync(ana);
    const aResult = await within(a).findByRole('region', { name: 'Result' });
    expect(aResult).toHaveTextContent('This passed. The Document now reads:Quiet after 10pm.');
    expect(fake.minute).toBe(startMinute);
    for (const app of [a, b]) {
      for (const radio of within(app).getAllByRole('radio')) expect(radio).toBeDisabled();
    }

    // Both Documents now read the new text.
    go(`#/g/${groupId}/doc`);
    for (const app of [a, b]) {
      expect(await within(app).findByText('Quiet after 10pm.')).toBeVisible();
      expect(within(app).queryByText('Quiet hours start at ten.')).not.toBeInTheDocument();
    }
  });

  it('lapses with only the proposer’s ballot once relay time passes the deadline', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [ana, ben] = devices;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    await score(within(a), user, '4 · Strongly supportive');
    await within(a).findByText('Sent');
    // Let the pass that sent the ballot finish reading back before relay time moves on.
    await sync(ana);

    fake.minute += VOTE_WINDOW_MINUTES;
    await sync(ana);
    expect(await within(a).findByRole('region', { name: 'Result' })).toHaveTextContent(
      'Not enough people weighed in. This isn’t a no.',
    );
    for (const radio of within(a).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(within(a).queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();

    // Ben never voted. His device, opening it late, sees the same lapse and no open ballot.
    await sync(ben);
    const b = mount(ben, 'b');
    expect(await within(b).findByRole('region', { name: 'Result' })).toHaveTextContent(
      'Not enough people weighed in.',
    );
    for (const radio of within(b).getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('keeps a ballot cast offline on the device, sends it on recovery, and says so', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben', 'Cy']);
    const [ana, ben] = devices;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    await within(a).findByRole('radio', { name: '4 · Strongly supportive' });
    await sync(ben);
    const b = mount(ben, 'b');

    fake.offline = true;
    await score(within(b), user, '2 · Neutral');
    // "Sending…" first; the saved line once the failed sync pass has reported it.
    const status = await within(b).findByText(/^Saved on this device/);
    expect(status).toHaveTextContent('Saved on this device. It will send when you’re back online.');

    fake.offline = false;
    await sync(ben);
    expect(await within(b).findByText('Sent')).toBeVisible();
    await waitFor(() => {
      expect(within(b).getByRole('radio', { name: '2 · Neutral' })).toBeChecked();
    });

    // While polling fails, Group home says the relay can't be reached, and since when.
    fake.offline = true;
    await sync(ben);
    go(`#/g/${groupId}`);
    expect(
      await within(b).findByText(/^Can’t reach the relay right now\. Last synced /),
    ).toBeVisible();
    fake.offline = false;
    await sync(ben);
    await waitFor(() => {
      expect(within(b).queryByText(/Can’t reach the relay/)).not.toBeInTheDocument();
    });
  });

  it('makes a Proposal’s new chat link the next prefill and Group home’s Join discussion', async () => {
    const user = userEvent.setup();
    const { groupId, devices } = await group(['Ana', 'Ben'], 'https://chat.example.org/riverside');
    const [ana] = devices;
    go(`#/g/${groupId}/doc`);
    const a = mount(ana, 'a');
    await proposeFrom(within(a), user, 1, {
      title: 'Quiet hours',
      text: 'Quiet after 10pm.',
      link: 'https://chat.example.org/quiet-hours',
    });
    await within(a).findByRole('radio', { name: '3 · Supportive' });

    go(`#/g/${groupId}`);
    const discussion = await within(a).findByRole('region', { name: 'Discussion' });
    expect(within(discussion).getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/quiet-hours',
    );
    const card = within(a).getByRole('link', { name: /Quiet hours/ });
    expect(card).toHaveTextContent('Closes in 7 days');

    go(`#/g/${groupId}/doc`);
    await user.click(
      await within(a).findByRole('button', { name: 'Propose a change to section 2' }),
    );
    expect(
      await within(a).findByRole('textbox', { name: 'Discussion link (optional)' }),
    ).toHaveValue('https://chat.example.org/quiet-hours');
  });

  it('tells someone who joined after a Proposal opened that they can’t vote on it', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group(['Ana', 'Ben']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    go(`#/g/${groupId}/doc`);
    const a = mount(ana, 'a');
    await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
    await within(a).findByRole('radio', { name: '3 · Supportive' });

    // Cy joins afterwards, through the same invite, and opens the same Proposal.
    const cy = await joinLater(fake, ana, groupId, 'Cy');
    opened.push(cy);
    const c = mount(cy, 'c');
    expect(
      await within(c).findByText('You joined after this opened, so you can’t vote on it.'),
    ).toBeVisible();
    expect(within(c).queryAllByRole('radio')).toEqual([]);
  });
});
