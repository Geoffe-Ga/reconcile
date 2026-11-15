/**
 * Erase Reconcile from this device (#78), end to end under the deploy CSP.
 *
 * A seeded profile founds a group, opens Settings and holds Erase for three
 * seconds. Letting go early erases nothing. Every request from the hold on is
 * captured: none goes anywhere but the app's own origin, none sends a byte,
 * and after the reload none reaches the relay. The reloaded app shows first
 * run, the pilot notice that localStorage no longer remembers, then Start
 * with no groups, and IndexedDB holds no group or key records.
 */
import type { Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  storedRecords,
  test,
} from './support/fixtures';
import { onlyGroup } from './support/stored';

const GROUP = 'Canary Lane Tenants';

test('erasing a seeded profile leaves first run, no groups and no records, and calls no one', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 390, height: 844 } });
  const { page } = ana;

  await test.step('Ana founds a group, so there is something to erase', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    await foundGroup(page, {
      name: GROUP,
      title: 'House rules',
      atoms: ['Quiet hours start at ten.'],
      founder: 'Ana',
    });
    await onlyGroup(page);
    expect(await storedRecords(page)).toBe(1);
  });

  const hold = page.getByRole('button', { name: 'Hold to erase' });

  await test.step('Settings reveals Erase’s words and its hold; a tap erases nothing', async () => {
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(heading(page, 'Settings')).toBeVisible();
    await page.getByRole('button', { name: 'Erase Reconcile from this device' }).click();
    await expect(
      page.getByText(
        'This erases Reconcile’s data on this device. Your groups carry on for everyone else, and a backup file you saved can bring them back here.',
      ),
    ).toBeVisible();
    await expectAccessible(ana, 'Settings, Erase open');
    await hold.click();
    await expect(page.getByText('You let go early, so nothing was erased.')).toBeVisible();
    expect(await storedRecords(page)).toBe(1);
  });

  const requests: Request[] = [];
  let reloaded = false;

  await test.step('a 3-second hold erases, sends nothing, and reloads at /', async () => {
    const origin = new URL(page.url()).origin;
    page.on('request', (request) => {
      requests.push(request);
    });
    await hold.hover();
    await page.mouse.down();
    await page.waitForURL(`${origin}/`, { timeout: 15_000 });
    reloaded = true;
    await page.mouse.up();
    for (const request of requests) {
      expect(new URL(request.url()).origin, request.url()).toBe(origin);
      expect(request.method(), request.url()).toBe('GET');
      expect(request.postDataBuffer(), request.url()).toBeNull();
    }
  });

  await test.step('first run comes back, then Start with no groups and no records', async () => {
    expect(reloaded).toBe(true);
    const afterReload = requests.length;
    // The device is new again, so its plain visit starts on the landing page (ADR-0077).
    await expect(page.getByRole('heading', { level: 1, name: 'Reconcile' })).toBeVisible();
    await acceptNotice(ana);
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expect(page.getByText('You aren’t in any groups on this device yet.')).toBeVisible();
    expect(await storedRecords(page)).toBe(0);
    await expectAccessible(ana, 'Start after Erase');
    const toRelay = requests
      .slice(afterReload)
      .filter((request) => new URL(request.url()).pathname.startsWith('/v1/'));
    expect(toRelay.map((request) => request.url())).toEqual([]);
  });
});
