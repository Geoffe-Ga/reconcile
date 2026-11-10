/**
 * The service worker under the deploy CSP (#76): the production build,
 * served by `vite preview` with deploy/Caddyfile's policy, registers `/sw.js`
 * and reaches `navigator.serviceWorker.ready` with no `securitypolicyviolation`
 * event (the `openProfile` fixture fails on any) and no CSP error on the
 * console. The worker, the manifest and the app all come from the app's own
 * origin.
 */
import { readFileSync } from 'node:fs';

import { acceptNotice, expect, heading, test } from './support/fixtures';

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
