/**
 * Offline (#76), in Chromium: after one visit and a sync, the service worker
 * has the whole build on the device, so an offline reload opens the app and
 * shows the last-synced Document from IndexedDB. The relay, under `/v1`, is
 * never cached: offline, its requests fail rather than come from a cache.
 */
import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type NewGroup,
  test,
} from './support/fixtures';

const GROUP: NewGroup = {
  name: 'Riverside Tenants',
  title: 'House rules',
  atoms: ['Quiet hours start at 10pm.', 'Shared spaces are cleaned every Sunday.'],
  founder: 'Ana',
};

/** The path of every request Cache Storage holds, across every cache. */
async function cachedPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
  }
  return paths;
}

test('opens offline with the last-synced Document, and never caches the relay', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const { page } = ana;

  await test.step('one visit: found a group and sync it', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    await foundGroup(page, GROUP);
    await page.getByRole('link', { name: GROUP.title }).click();
    await expect(page.getByRole('article').getByRole('paragraph')).toHaveText(GROUP.atoms);
    // The worker is active once it has every file of the build.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
  });

  await test.step('offline, a reload shows the last-synced Document', async () => {
    await page.context().setOffline(true);
    await page.reload();
    await expect(heading(page, GROUP.title)).toBeVisible();
    await expect(page.getByRole('article').getByRole('paragraph')).toHaveText(GROUP.atoms);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expectAccessible(ana, 'Document view, offline');
  });

  await test.step('Cache Storage holds the build and nothing under /v1', async () => {
    const paths = await page.evaluate(cachedPaths);
    expect(paths).toContain('/');
    expect(paths).toContain('/manifest.webmanifest');
    expect(paths.some((path) => path.endsWith('.woff2'))).toBe(true);
    // The screens' painted edges are kept; the landing page's painting never is (ADR-0077).
    expect(paths).toContain('/edges/sky.webp');
    expect(paths.filter((path) => path.startsWith('/painting/'))).toEqual([]);
    expect(paths.filter((path) => path === '/v1' || path.startsWith('/v1/'))).toEqual([]);
  });

  await test.step('offline, the relay fails rather than answering from a cache', async () => {
    // The app's own sync request to /v1 failed, so Group home says so.
    await page.getByRole('link', { name: GROUP.name }).click();
    await expect(page.getByText(/^Can’t reach the relay right now\./)).toBeVisible();
    await expect(page.goto('/v1/health')).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
  });
});
