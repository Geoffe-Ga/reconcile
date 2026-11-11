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
 */
import { connectFromPage } from './support/connect';
import {
  acceptNotice,
  type DiscordRequest,
  expect,
  isDiscord,
  routeDiscord,
  test,
  visit,
} from './support/fixtures';

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
