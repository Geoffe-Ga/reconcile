/**
 * The service worker under the deploy CSP (#76): the production build,
 * served by `vite preview` with deploy/Caddyfile's policy, registers `/sw.js`
 * and reaches `navigator.serviceWorker.ready` with no `securitypolicyviolation`
 * event (the `openProfile` fixture fails on any) and no CSP error on the
 * console. The worker, the manifest and the app all come from the app's own
 * origin.
 *
 * The page may connect to its own origin and to one path more, Discord's
 * webhooks, which a group's chat bot posts to (#119). A `fetch` anywhere
 * else, another path on Discord or `discordapp.com` included, is blocked
 * with a `securitypolicyviolation`. Every request off the app's origin is
 * answered by the test, so nothing reaches Discord or any other host.
 */
import { readFileSync } from 'node:fs';

import type { BrowserContext } from '@playwright/test';

import { connectFromPage } from './support/connect';
import {
  acceptNotice,
  type DiscordRequest,
  expect,
  heading,
  isDiscord,
  routeDiscord,
  test,
} from './support/fixtures';

/** The Caddyfile's one Content-Security-Policy value, as deploy/check.sh reads it. */
function deployCsp(): string {
  const caddyfile = readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  const match = /^\s*Content-Security-Policy "(.*)"$/m.exec(caddyfile);
  if (match?.[1] === undefined)
    throw new Error('deploy/Caddyfile sets no Content-Security-Policy.');
  return match[1];
}

/** A console line about the CSP, as Chromium and WebKit word them. */
const CSP_CONSOLE = /Content[ -]Security[ -]Policy|Refused to/i;

test('reaches a ready service worker under the deploy CSP, with no violation', async ({
  openProfile,
}) => {
  const csp = deployCsp();
  const ana = await openProfile('Ana');
  const { page } = ana;
  const cspErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && CSP_CONSOLE.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBe(csp);
  expect(csp).toContain("; connect-src 'self' https://discord.com/api/webhooks/;");
  await acceptNotice(ana);
  await expect(heading(page, 'Your groups')).toBeVisible();

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(new URL('/', page.url()).href);

  const worker = await page.request.get('/sw.js');
  expect(worker.headers()['content-security-policy']).toBe(csp);
  expect(worker.headers()['content-type']).toMatch(/javascript/);
  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as Record<
    string,
    unknown
  >;
  expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' });

  // A reload runs the app under the worker, still under the CSP.
  await page.reload();
  await expect(heading(page, 'Your groups')).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(
    new URL('/sw.js', page.url()).href,
  );
  expect(cspErrors, 'CSP errors on the console').toEqual([]);
});

const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';

/** Where the page tries to connect, and what it must get: Discord's answer, or blocked. */
const TRIES: readonly (readonly [string, number | 'blocked'])[] = [
  [WEBHOOK, 204],
  ['https://example.com/collect', 'blocked'],
  ['https://discord.com/api/v10/channels/1199000000000000001/messages', 'blocked'],
  ['https://discordapp.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ', 'blocked'],
];

/** The name the page keeps its CSP violations under, as "directive origin". */
const VIOLATIONS = 'e2eConnectViolations';

/** Runs in the page before any script: keeps each CSP violation on `window`. */
function keepCspViolations(key: string): void {
  const seen: string[] = [];
  Reflect.set(window, key, seen);
  window.addEventListener(
    'securitypolicyviolation',
    (event) => {
      seen.push(`${event.effectiveDirective} ${new URL(event.blockedURI).origin}`);
    },
    true,
  );
}

/** Answers every request off `origin` that isn't Discord's, so a CSP that let one through can't reach a real host. */
async function answerOtherHosts(context: BrowserContext, origin: string): Promise<void> {
  await context.route(
    (url) => url.origin !== origin && !isDiscord(url),
    (route) =>
      route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' }),
  );
}

test('connects only to its own origin and Discord’s webhook path, blocking any other with a violation', async ({
  browser,
  baseURL,
}) => {
  // Its own profile, as this test expects violations that `openProfile` would fail on.
  const context = await browser.newContext({ bypassCSP: false });
  try {
    const discord: DiscordRequest[] = [];
    await routeDiscord(context, discord);
    await answerOtherHosts(context, new URL(baseURL ?? '').origin);
    await context.addInitScript(keepCspViolations, VIOLATIONS);
    const page = await context.newPage();
    await page.goto('/');
    await acceptNotice({ name: 'Ana', page });

    const got = await connectFromPage(
      page,
      TRIES.map(([url]) => url),
    );
    expect(got).toEqual(TRIES.map(([, outcome]) => outcome));
    expect(discord.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${WEBHOOK}`,
    ]);

    const violations = await page.evaluate(async (key) => {
      // A frame and then a task, so every queued violation report has arrived.
      await new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      });
      return Reflect.get(window, key) as string[];
    }, VIOLATIONS);
    expect([...violations].sort()).toEqual([
      'connect-src https://discord.com',
      'connect-src https://discordapp.com',
      'connect-src https://example.com',
    ]);
  } finally {
    await context.close();
  }
});
