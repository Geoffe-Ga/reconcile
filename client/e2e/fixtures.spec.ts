/**
 * What e2e/support/fixtures.ts promises the specs, checked in both browsers
 * (#123).
 *
 * `visit` leaves a page that is already at a URL as it is. WebKit reloads a
 * page sent to its own URL, where Chromium stays put, and the reloaded page
 * comes under the app's service worker. WebKit never lets `context.route` see
 * a request from a page under a service worker, so a spec that reloaded one
 * would let its Discord posts slip past the fixture to Discord itself.
 *
 * `routeDiscord`'s watch names every request the browser sent to Discord that
 * the fixture never answered, and `openProfile` fails a test on any, so none
 * can reach Discord unseen.
 *
 * `readRelayLater` (#127) moves only the `now` a profile reads from its
 * mailbox GETs: the relay keeps its own minutes on every record. `watchFor`
 * (#127) names each needle a profile's pages ever showed, and no other.
 */
import { connectFromPage } from './support/connect';
import {
  acceptNotice,
  type DiscordRequest,
  expect,
  heading,
  isDiscord,
  routeDiscord,
  test,
  visit,
} from './support/fixtures';
import { readRelayLater, relayMinute } from './support/relayNow';
import { tag } from './support/scan';
import { found } from './support/steps';
import { onlyGroup, storedLogs } from './support/stored';
import { watchFor } from './support/watch';

const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const INTO_THREAD = `${WEBHOOK}?thread_id=1309000000000000010`;

test('visit leaves a page already at the URL as it is, and goes to any other', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const { page } = ana;
  await page.goto('/');
  await acceptNotice(ana);
  const here = page.url();
  await page.evaluate(() => {
    Reflect.set(window, 'e2eSamePage', true);
  });

  await visit(page, here);
  expect(await page.evaluate(() => Reflect.get(window, 'e2eSamePage') as unknown)).toBe(true);

  const settings = new URL('/#/settings', here).href;
  await visit(page, settings);
  expect(page.url()).toBe(settings);

  // A path relative to the app, as the steps pass, names the same page: no navigation at all,
  // since WebKit reloads a page sent to its own URL, and the reloaded page comes under the
  // service worker, where `context.route` no longer sees its requests (#494).
  let navigated = 0;
  page.on('framenavigated', () => {
    navigated += 1;
  });
  await visit(page, '/#/settings');
  expect(navigated).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, 'e2eSamePage') as unknown)).toBe(true);
});

test('the Discord watch names each request the fixture never answered', async ({ browser }) => {
  // Its own profile, as `openProfile` fails any test that leaves one unanswered.
  const context = await browser.newContext({ bypassCSP: false });
  try {
    const discord: DiscordRequest[] = [];
    const watch = await routeDiscord(context, discord);
    const page = await context.newPage();
    // A page's route runs before its context's: this one keeps the post into a
    // thread from the fixture, as WebKit keeps every request of a page under a
    // service worker from it.
    await page.route(
      (url) => isDiscord(url) && url.searchParams.has('thread_id'),
      (route) => route.abort(),
    );
    await page.goto('/');

    expect(await connectFromPage(page, [WEBHOOK, INTO_THREAD])).toEqual([204, 'blocked']);
    expect(discord.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${WEBHOOK}`,
    ]);
    expect(watch.unanswered()).toEqual([`POST ${INTO_THREAD}`]);
  } finally {
    await context.close();
  }
});

test('readRelayLater moves the now a profile reads, and not the minutes the relay keeps', async ({
  openProfile,
  request,
}) => {
  const ana = await openProfile('Ana');
  const days = 10;
  const later = await readRelayLater(ana, days * 1_440);
  const before = await relayMinute(request);
  await found(ana, {
    name: 'Riverside Tenants',
    founder: 'Ana',
    title: 'House rules',
    atoms: ['Quiet hours start at ten.'],
  });
  const after = await relayMinute(request);

  // The device reads the relay's minute as 10 days on...
  const { relayNow } = await onlyGroup(ana.page);
  expect(relayNow).toBeGreaterThanOrEqual(before + days * 1_440);
  expect(relayNow).toBeLessThanOrEqual(after + days * 1_440);
  expect(later.rewritten()).toBeGreaterThan(0);
  // ...while the genesis keeps the minute the relay received it.
  const [held] = await storedLogs(ana.page);
  const [genesis] = held?.log ?? [];
  expect(genesis?.[1]).toBeGreaterThanOrEqual(before);
  expect(genesis?.[1]).toBeLessThanOrEqual(after);
  await later.stop();
});

test('watchFor names each needle a profile’s pages showed, and none they never did', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const never = `NEVER-SHOWN-${tag()}`;
  const watch = await watchFor(ana, ['Before you start', 'Your groups', never]);
  await visit(ana.page, '/');
  await acceptNotice(ana);
  await expect(heading(ana.page, 'Your groups')).toBeVisible();
  expect([...(await watch.seen())].sort()).toEqual(['Before you start', 'Your groups']);
});
