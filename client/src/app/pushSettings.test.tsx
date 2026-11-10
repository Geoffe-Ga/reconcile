/**
 * Settings › Notifications through the whole app (#99), on devices sharing a
 * fake relay (src/test/fakeRelay.ts), each with a fake browser's
 * notifications and push manager (src/test/fakePush.ts): one switch per
 * group, all off to start; turning one on asks permission inside the tap,
 * subscribes with the relay's own key and PUTs the group's mailbox; a denial
 * shows the blocked line and stores nothing; turning the last one off DELETEs
 * and unsubscribes. axe passes on each state.
 */
import { fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { browserPushPort } from '../platform/pushPort';
import { mailboxAt } from '../store/mailbox';
import { createPush } from '../store/push';
import { createPushRelay } from '../net/push';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { fakeEndpoint } from '../test/fakePush';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { FOUNDING, go, members, type MountedApp, mountApp } from '../test/members';

freshIndexedDBPerTest();

const DISCLOSURE =
  'Notifications only ever say “Something new in Reconcile.” To send them, the relay keeps this phone’s push address for each group you turn on, for up to 30 days. That lets whoever runs the relay see that the same phone is in each of those groups. Apple or Google can see when this phone is woken. Notifications may show on your lock screen and a paired watch.';
const SWITCH = `Notify me about ${FOUNDING.groupName}`;
const BLOCKED = 'Notifications are blocked for Reconcile in this device’s settings.';
const UNAVAILABLE = 'This device can’t get notifications from Reconcile.';

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** Ana and Ben in one group; Ana's Settings open at Notifications. */
async function settings(fake: FakeRelay = createFakeRelay()) {
  const made = await members(fake, ['Ana', 'Ben']);
  opened.push(...made.devices);
  const [ana] = made.devices;
  if (ana === undefined) throw new Error('Expected Ana.');
  go('#/settings');
  const app = mountApp(ana.services, 'ana');
  mounted.push(app);
  const view = within(app.container);
  const section = await view.findByRole('region', { name: 'Notifications' });
  const stored = await ana.services.store.getGroup(made.groupId);
  if (stored === undefined) throw new Error('Expected the group.');
  return { fake, ana, groupId: made.groupId, view, section, mailbox: mailboxAt(stored, 0) };
}

describe('Settings › Notifications (#99)', () => {
  it('says what push shows and what the relay sees first, with one switch per group, off', async () => {
    const { section, fake } = await settings();
    const before = fake.requests.length;

    const paragraphs = within(section).getAllByText(/./, { selector: 'p' });
    expect(paragraphs[0]).toHaveTextContent(DISCLOSURE);
    const toggle = within(section).getByRole('switch', { name: SWITCH });
    expect(toggle).not.toBeChecked();
    expect(within(section).getAllByRole('switch')).toHaveLength(1);
    expect(fake.requests.slice(before).filter((r) => r.url.startsWith('/v1/push'))).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('turns on inside the tap: permission, then a subscription with the relay’s key, then the PUT', async () => {
    const { section, ana, fake, groupId, mailbox } = await settings();
    ana.push.answer = 'granted';
    const toggle = within(section).getByRole('switch', { name: SWITCH });

    fireEvent.click(toggle);
    // Asked synchronously, inside the click: nothing was awaited first.
    expect(ana.push.asked).toBe(1);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(ana.push.subscribed).toEqual([{ userVisibleOnly: true, key: fake.pushKey }]);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);
    expect((await ana.services.store.getGroup(groupId))?.push?.endpoint).toBe(fakeEndpoint(1));
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the blocked line on a denial, and stores and sends nothing', async () => {
    const { section, ana, fake, groupId } = await settings();
    ana.push.answer = 'denied';
    const before = fake.requests.length;

    await userEvent.setup().click(within(section).getByRole('switch', { name: SWITCH }));

    expect(await within(section).findByText(BLOCKED)).toBeVisible();
    expect(within(section).getByRole('switch', { name: SWITCH })).not.toBeChecked();
    expect(fake.requests.slice(before).filter((r) => r.url.startsWith('/v1/push'))).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the blocked line at once when the device already blocks notifications', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    ana.push.permission = 'denied';
    go('#/settings');
    const app = mountApp(ana.services, 'ana');
    mounted.push(app);

    const section = await within(app.container).findByRole('region', { name: 'Notifications' });

    expect(within(section).getByText(BLOCKED)).toBeVisible();
  });

  it('says the device can’t get notifications when the relay has push off', async () => {
    const { section, ana, fake } = await settings();
    ana.push.answer = 'granted';
    fake.pushKey = null;

    await userEvent.setup().click(within(section).getByRole('switch', { name: SWITCH }));

    expect(await within(section).findByText(UNAVAILABLE)).toBeVisible();
    expect(within(section).getByRole('switch', { name: SWITCH })).not.toBeChecked();
  });

  it('turns the last group off with a DELETE, then ends the subscription', async () => {
    const { section, ana, fake, mailbox } = await settings();
    ana.push.answer = 'granted';
    const user = userEvent.setup();
    const toggle = within(section).getByRole('switch', { name: SWITCH });
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    const before = fake.requests.length;

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
    await waitFor(() => {
      expect(ana.push.subscription).toBeNull();
    });
    const sent = fake.requests.slice(before).filter((r) => r.url.startsWith('/v1/push'));
    expect(sent.map((r) => [r.method, r.url])).toEqual([['DELETE', `/v1/push/${mailbox}`]]);
    expect(fake.endpoints(mailbox)).toEqual([]);
  });

  it('shows no switch, only why, on a device without the Push API', async () => {
    const fake = createFakeRelay();
    const made = await members(fake, ['Ana']);
    opened.push(...made.devices);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort({ ...ana.push.environment, container: undefined }),
    });
    go('#/settings');
    const app = mountApp({ ...ana.services, push }, 'ana');
    mounted.push(app);

    const section = await within(app.container).findByRole('region', { name: 'Notifications' });

    expect(within(section).getByText(UNAVAILABLE)).toBeVisible();
    expect(within(section).queryByRole('switch')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
