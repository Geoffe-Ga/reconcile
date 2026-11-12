/**
 * The proposer sets the voting window (#106), end to end through the real
 * relay and the deploy CSP: Ana, on a 390 px phone, opens the composer with
 * the ordinary default of 7 days, is refused 20 with a message tied to the
 * field, and proposes 10. Her phone and Ben's dark desktop both fold the same
 * 10-day deadline from the relay's receipt of the Proposal.
 *
 * axe checks the composer, with the field valid and refused, and the
 * Proposal on both profiles. Nothing moves time.
 */
import { type Page } from '@playwright/test';

import { acceptNotice, expect, expectAccessible, heading, pick, test } from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const ATOM = 'Quiet hours start at 10pm.';
const PROPOSAL = 'Later quiet hours';

/** A phone's width: the composer must fit it without scrolling sideways. */
const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test('A proposes with a 10-day window, and both profiles fold its 10-day deadline', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: PHONE });
  const ben = await openProfile('Ben', {
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  });
  let proposalUrl = '';

  await test.step('A creates a group, and B joins it', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Document text' }).fill(ATOM);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();

    await ben.page.goto(invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await pick(ben.page, 'Collaborator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ben',
    );
  });

  await test.step('the composer offers 7 days, and refuses 20 with a tied message', async () => {
    const { page } = ana;
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    const days = page.getByRole('textbox', { name: 'Voting time (days)' });
    await expect(days).toHaveValue('7');
    await expect(days).toHaveAccessibleDescription(
      /^Closes about \w{3} \d{1,2} \w{3}\. The exact time is set when the relay receives it\.$/,
    );
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ana, 'composer with the voting time');

    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await days.fill('20');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByText('Choose from 3 to 14 days.')).toBeVisible();
    await expect(days).toHaveAttribute('aria-invalid', 'true');
    await expect(days).toHaveAccessibleDescription(/Choose from 3 to 14 days\.$/);
    await expect(heading(page, 'Propose a change')).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ana, 'composer with a refused voting time');
  });

  await test.step('A proposes 10 days, and sees how long voting runs', async () => {
    const { page } = ana;
    await page.getByRole('textbox', { name: 'Voting time (days)' }).fill('10');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, PROPOSAL)).toBeVisible();
    await expect(page.getByText('Voting runs 10 days')).toBeVisible();
    await expect(page.getByText('Closes in 10 days')).toBeVisible();
    proposalUrl = page.url();
    await expectAccessible(ana, 'Proposal with a 10-day window');
  });

  await test.step('B’s device folds the same 10-day deadline', async () => {
    const { page } = ben;
    await page.goto(proposalUrl);
    await expect(heading(page, PROPOSAL)).toBeVisible();
    await expect(page.getByText('Voting runs 10 days')).toBeVisible();
    await expect(page.getByText('Closes in 10 days')).toBeVisible();
    const anaDeadline = await ana.page.locator('.countdown time').getAttribute('datetime');
    await expect(page.locator('.countdown time')).toHaveAttribute('datetime', anaDeadline ?? '');
    await expectAccessible(ben, 'Proposal with a 10-day window, dark');
  });
});
