/**
 * Push (#99), in Chromium (not its headless shell, which has no
 * notifications), under the deploy CSP, with no push service: the
 * relay runs as `relay.sh` starts it, with push off, and the test delivers
 * pushes to the service worker itself over the DevTools protocol
 * (`ServiceWorker.deliverPushMessage`), so nothing reaches Google or anyone.
 *
 * - Settings › Notifications says what push shows and what the relay sees
 *   first, and shows one switch per group, off; axe passes.
 * - With notifications allowed, turning one on asks the relay for its key,
 *   which a relay with push off refuses: the page says so, the switch stays
 *   off, and no subscription is made.
 * - With no Reconcile window open, a push carrying a canary shows exactly
 *   one notification, "Something new in Reconcile", with only its tag, read
 *   in the worker itself; a second replaces the first.
 * - Once the app opens again, it closes them.
 */
import type { BrowserContext, CDPSession } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type NewGroup,
  test,
} from './support/fixtures';

// Chromium itself, in its new headless mode: the headless shell refuses notifications.
test.use({ channel: 'chromium' });

const GROUP: NewGroup = {
  name: 'Riverside Tenants',
  title: 'House rules',
  atoms: ['Quiet hours start at 10pm.'],
  founder: 'Ana',
};
const CANARY = 'CANARY-push Ana proposed Later quiet hours in Riverside Tenants';

/** What a shown notification holds, as the worker reads it. */
interface Shown {
  readonly title: string;
  readonly tag: string;
  readonly body: string;
  readonly data: unknown;
  readonly icon: string;
  readonly badge: string;
  readonly actions: number;
  readonly timestamp: number;
}

/**
 * Every notification the service worker shows now, read in the worker itself,
 * so no Reconcile window is open to close them; none while it isn't running.
 */
async function shown(context: BrowserContext): Promise<Shown[]> {
  const [worker] = context.serviceWorkers();
  if (worker === undefined) return [];
  return worker.evaluate(async () => {
    const scope = self as unknown as { registration: ServiceWorkerRegistration };
    const list = await scope.registration.getNotifications();
    return list.map((n) => ({
      title: n.title,
      tag: n.tag,
      body: n.body,
      data: n.data as unknown,
      icon: n.icon,
      badge: (n as Notification & { badge?: string }).badge ?? '',
      actions: (n as Notification & { actions?: unknown[] }).actions?.length ?? 0,
      timestamp: (n as Notification & { timestamp?: number }).timestamp ?? 0,
    }));
  });
}

/** The worker's registration id, which the DevTools protocol delivers pushes by. */
async function registrationId(cdp: CDPSession): Promise<string> {
  const found = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const [first] = registrations;
      if (first !== undefined) resolve(first.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  return found;
}

test('shows one content-free notification per push, and Settings explains it first', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const { page } = ana;

  await test.step('a group, and Settings › Notifications', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    await foundGroup(page, GROUP);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.goto('/#/settings');
    await expect(heading(page, 'Settings')).toBeVisible();
    const section = page.getByRole('region', { name: 'Notifications' });
    await expect(section.getByText(/^Notifications only ever say/)).toBeVisible();
    await expect(
      section.getByRole('switch', { name: `Notify me about ${GROUP.name}` }),
    ).not.toBeChecked();
    await expectAccessible(ana, 'Settings, Notifications');
  });

  await test.step('a relay with push off: the page says so, and nothing subscribes', async () => {
    await page.context().grantPermissions(['notifications']);
    const section = page.getByRole('region', { name: 'Notifications' });
    const toggle = section.getByRole('switch', { name: `Notify me about ${GROUP.name}` });
    const keyAnswer = page.waitForResponse((response) => response.url().endsWith('/v1/push/key'));
    // The switch's whole card is its label: tap it, as a person would.
    await section.getByText(`Notify me about ${GROUP.name}`).click();
    expect((await keyAnswer).status()).toBe(404);
    await expect(
      section.getByText('This device can’t get notifications from Reconcile.'),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
    const subscribed = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return (await registration.pushManager.getSubscription()) !== null;
    });
    expect(subscribed).toBe(false);
    await expectAccessible(ana, 'Settings, Notifications, unavailable');
  });

  await test.step('with no window open, each push shows only “Something new in Reconcile”, once', async () => {
    const context = page.context();
    const cdp = await context.newCDPSession(page);
    const id = await registrationId(cdp);
    const origin = new URL(page.url()).origin;
    // As on a phone in a pocket: no Reconcile window is open to close what shows.
    await page.goto('about:blank');
    const push = () =>
      cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: id, data: CANARY });

    await push();
    await expect.poll(async () => (await shown(context)).length).toBe(1);
    const [first] = await shown(context);
    expect(first).toEqual({
      title: 'Something new in Reconcile',
      tag: 'reconcile',
      body: '',
      data: null,
      icon: '',
      badge: '',
      actions: 0,
      timestamp: first?.timestamp,
    });
    expect(JSON.stringify(first)).not.toContain('CANARY');

    await push();
    // The second replaces the first: still one, shown later.
    await expect
      .poll(async () => (await shown(context)).map((n) => n.timestamp > (first?.timestamp ?? 0)))
      .toEqual([true]);
  });

  await test.step('the app closes them once it comes to the front', async () => {
    await page.goto('/#/settings');
    await expect(heading(page, 'Settings')).toBeVisible();
    await expect.poll(async () => (await shown(page.context())).length).toBe(0);
  });
});
