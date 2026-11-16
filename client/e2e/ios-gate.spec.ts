/**
 * The iOS install gate (#76, ADR-0029): an iPhone in Safari, in Chrome, or in
 * an in-app browser, outside the installed app, makes no keys. A plain visit
 * (past the landing page, ADR-0078),
 * an invite link and a reconcile card's link all show the install guide and a
 * Copy button; none shows Create group, Join, Bring or the pilot notice, and
 * IndexedDB holds no records. An invite link still shows its preview, and a
 * card's link is held to copy into the installed app (#280); each leaves the
 * address bar.
 */
import { type Page } from '@playwright/test';

import { makeCard, type NewCoalition } from './support/coalition';
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

const COALITION: NewCoalition = {
  name: 'Rivers United',
  statement: ['We keep the river clean.'],
  why: 'We share a river.',
  yourName: 'Ana',
};

/** The links a founder sends: an invite to the group, and a card from it (#280). */
interface FounderLinks {
  readonly invite: string;
  readonly card: string;
}

/** A desktop profile, where keys may be made, founds the group and makes a card from its home. */
async function founderLinks(openProfile: OpenProfile): Promise<FounderLinks> {
  const ana = await openProfile('Ana');
  await ana.page.goto('/');
  await acceptNotice(ana);
  const invite = await foundGroup(ana.page, GROUP);
  return { invite, card: await makeCard(ana, COALITION) };
}

/** Nothing here makes keys or records anything, and no link bar (#444) stands over the gate. */
async function expectNothingMade(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'I understand' })).toHaveCount(0);
  await expect(page.getByRole('search')).toHaveCount(0);
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

/** The guide, with the card's link to copy and where to paste it, its seed out of the address bar (#280). */
async function expectCardGuide(page: Page, cardLink: string): Promise<void> {
  await expect(heading(page, 'Add Reconcile to your Home Screen')).toBeVisible();
  const card = page.getByRole('region', { name: 'A reconcile card' });
  await expect(card.getByRole('textbox', { name: 'Your card link' })).toHaveValue(cardLink);
  await expect(card.getByRole('button', { name: 'Copy card link' })).toBeVisible();
  await expect(page.getByRole('listitem').last()).toHaveText(
    'Open Reconcile from your Home Screen and paste your card link into the bar at the top.',
  );
  await expect(page.getByRole('button', { name: 'Bring to my group' })).toHaveCount(0);
  expect(page.url()).toBe(new URL('/', cardLink).href);
}

for (const [name, userAgent] of Object.entries(IPHONES)) {
  test(`an iPhone in ${name} gets the install guide and Copy, and no keys`, async ({
    openProfile,
  }) => {
    // Each test gets its own relay (e2e/support/fixtures.ts), so each founds its own group.
    const { invite: inviteLink, card: cardLink } = await founderLinks(openProfile);
    const phone = await openProfile(name, {
      userAgent,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const { page } = phone;

    await test.step('a plain visit: the landing page, then the guide', async () => {
      await page.goto('/');
      // The landing page makes nothing either (ADR-0078).
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

    await test.step('a reconcile card’s link, opened in a new page, is held to copy (#280)', async () => {
      const carded = await page.context().newPage();
      await carded.goto(cardLink);
      await expectCardGuide(carded, cardLink);
      await expectAccessible({ name, page: carded }, 'install guide with a card');
      await expectNothingMade(carded);
      await carded.close();
    });
  });
}
