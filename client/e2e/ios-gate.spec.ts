/**
 * The iOS install gate (#76, ADR-0029): an iPhone in Safari, in Chrome, or in
 * an in-app browser, outside the installed app, makes no keys. A plain visit
 * (past the landing page, ADR-0077) and an invite link both show the install
 * guide and a Copy button; neither
 * shows Create group, Join or the pilot notice, and IndexedDB holds no
 * records. An invite link still shows its preview, and leaves the address bar.
 */
import { type Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type NewGroup,
  type OpenProfile,
  storedRecords,
  test,
} from './support/fixtures';

const GROUP: NewGroup = {
  name: 'Riverside Tenants',
  title: 'House rules',
  atoms: ['Quiet hours start at 10pm.'],
  founder: 'Ana',
};

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

/** A desktop profile, where keys may be made, founds the group; returns its invite link. */
async function founderInvite(openProfile: OpenProfile): Promise<string> {
  const ana = await openProfile('Ana');
  await ana.page.goto('/');
  await acceptNotice(ana);
  return foundGroup(ana.page, GROUP);
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

/** The guide, with the invite's preview and its link to copy. */
async function expectInviteGuide(page: Page, inviteLink: string): Promise<void> {
  await expect(heading(page, 'Add Reconcile to your Home Screen')).toBeVisible();
  const preview = page.getByRole('region', { name: GROUP.name });
  await expect(preview.getByText(GROUP.title)).toBeVisible();
  await expect(preview.getByText(`From ${GROUP.founder}’s invite`)).toBeVisible();
  await expect(preview.getByText(GROUP.atoms[0] ?? '')).toBeVisible();
  await expect(preview.getByRole('textbox', { name: 'Your invite link' })).toHaveValue(inviteLink);
  await expect(preview.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
  // The invite's seed has left the address bar.
  expect(page.url()).toBe(new URL('/', inviteLink).href);
}

for (const [name, userAgent] of Object.entries(IPHONES)) {
  test(`an iPhone in ${name} gets the install guide and Copy, and no keys`, async ({
    openProfile,
  }) => {
    // Each test gets its own relay (e2e/support/fixtures.ts), so each founds its own group.
    const inviteLink = await founderInvite(openProfile);
    const phone = await openProfile(name, {
      userAgent,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const { page } = phone;

    await test.step('a plain visit: the landing page, then the guide', async () => {
      await page.goto('/');
      // The landing page makes nothing either (ADR-0077).
      await expect(page.getByRole('heading', { level: 1, name: 'Reconcile' })).toBeVisible();
      await expectNothingMade(page);
      await page.getByRole('button', { name: 'Start a Group' }).first().click();
      await expect(heading(page, 'Add Reconcile to your Home Screen')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
      await expectNothingMade(page);
    });

    await test.step('an invite link, opened in a new page', async () => {
      const invited = await page.context().newPage();
      await invited.goto(inviteLink);
      await expectInviteGuide(invited, inviteLink);
      await expectAccessible({ name, page: invited }, 'install guide');
      await expectNothingMade(invited);
      await invited.close();
    });

    await test.step('an invite link opened in the guide’s own window', async () => {
      await page.goto(inviteLink);
      await expectInviteGuide(page, inviteLink);
      await expectNothingMade(page);
    });
  });
}
