/**
 * The iOS install gate (#76, ADR-0029): an iPhone in Safari, in Chrome, or in
 * an in-app browser, outside the installed app, makes no keys. A plain visit
 * and an invite link both show the install guide and a Copy button; neither
 * shows Create group, Join or the pilot notice, and IndexedDB holds no
 * records. An invite link still shows its preview, and leaves the address bar.
 */
import { type Browser, expect, type Page, test } from '@playwright/test';

import {
  acceptNotice,
  expectAccessible,
  foundGroup,
  GROUP,
  heading,
  storedRecords,
  TITLE,
  watchCspViolations,
} from './helpers';

const ios = (browser: string): string =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;

/** iPhone browsers, none of them running from the Home Screen. */
const IPHONES = {
  Safari: ios('Version/18.5 Mobile/15E148 Safari/604.1'),
  'Chrome (CriOS)': ios('CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1'),
  'an in-app browser (FBIOS)': ios(
    'Mobile/22F76 [FBAN/FBIOS;FBAV/520.0.0.38.101;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBLC/en_US]',
  ),
};

test.describe.configure({ mode: 'serial' });

let inviteLink = '';

test.beforeAll(async ({ browser }) => {
  // A desktop profile, where keys may be made, founds the group the link invites to.
  const desktop = await browser.newContext();
  const page = await desktop.newPage();
  await page.goto('/');
  await acceptNotice(page);
  inviteLink = await foundGroup(page, 'Ana');
  await desktop.close();
});

/** Opens an iPhone profile with `userAgent`; the caller closes it. */
async function iphone(browser: Browser, userAgent: string) {
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const violations = await watchCspViolations(context);
  return { context, page: await context.newPage(), violations };
}

/** Nothing here makes keys or records anything. */
async function expectNothingMade(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'I understand' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Create group' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Join group' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveCount(0);
  expect(await storedRecords(page)).toBe(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
}

for (const [name, userAgent] of Object.entries(IPHONES)) {
  test(`an iPhone in ${name} gets the install guide and Copy, and no keys`, async ({ browser }) => {
    const { context, page, violations } = await iphone(browser, userAgent);

    await test.step('a plain visit', async () => {
      await page.goto('/');
      await expect(heading(page, 'Add Reconcile to your Home Screen')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
      await expectNothingMade(page);
    });

    await test.step('an invite link, opened in a new page', async () => {
      const invited = await context.newPage();
      await invited.goto(inviteLink);
      await expect(heading(invited, 'Add Reconcile to your Home Screen')).toBeVisible();
      const preview = invited.getByRole('region', { name: GROUP });
      await expect(preview.getByText(TITLE)).toBeVisible();
      await expect(preview.getByRole('textbox', { name: 'Your invite link' })).toHaveValue(
        inviteLink,
      );
      await expect(preview.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
      // The invite's secret has left the address bar.
      expect(invited.url()).toBe(new URL('/', inviteLink).href);
      await expectAccessible(invited, `the install guide in ${name}`);
      await expectNothingMade(invited);
    });

    await test.step('an invite link opened in the guide’s own window', async () => {
      await page.goto(inviteLink);
      await expect(page.getByRole('region', { name: GROUP }).getByText(TITLE)).toBeVisible();
      expect(page.url()).toBe(new URL('/', inviteLink).href);
      await expectNothingMade(page);
    });

    for (const open of context.pages()) await open.evaluate(() => undefined);
    expect(violations, 'CSP violations').toEqual([]);
    await context.close();
  });
}
