/**
 * Stewards and a 7-day suspension (#102), end to end through the real relay
 * and the deploy CSP: Ana founds a group and holds seat 1; Ben and Kim join.
 * Kim scores Ana's Proposal, then Ana suspends Kim from the People list,
 * through the React Aria modal dialog. Everyone reads the suspension, and
 * Kim's ballot is disabled under the suspended line, her earlier score kept.
 * Then Ben, on a phone in the dark theme, sees that a steward election is due
 * for seat 1 and proposes himself, and the ballot reads "Make Ben steward
 * (seat 1)". axe checks each screen, and the fixture fails the test on any
 * CSP violation, the modal's included. Nothing moves time.
 */
import type { Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const REASON = 'Posting threats in the chat.';
const SUSPENDED =
  /^A steward suspended you until .+\. You can read, but not post, propose or vote\.$/;

/** A phone's width: the narrowest Group home and the composer must fit without scrolling sideways. */
const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** The People list. */
function people(page: Page) {
  return page.getByRole('region', { name: 'People', exact: true });
}

/** `person` joins from `invite` under their own name, at `level` when named. */
async function join(person: Person, invite: string, level?: string): Promise<void> {
  const { page } = person;
  await page.goto(invite);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  if (level !== undefined) await pick(page, level);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(people(page)).toContainText(person.name);
}

test('a steward suspends Kim, everyone sees it, and Ben proposes himself for seat 1', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const kim = await openProfile('Kim');
  let proposalUrl = '';

  await test.step('Ana founds the group, and Ben and Kim join', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Document text' }).fill('Quiet hours start at 10pm.');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    await join(ben, invite, 'Co-Creator');
    await join(kim, invite);
  });

  await test.step('Ana proposes, and Kim scores it', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Later quiet hours');
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    proposalUrl = page.url();

    await kim.page.goto(proposalUrl);
    await pick(kim.page, '3 · Supportive');
    await kim.page.getByRole('button', { name: 'Send your vote' }).click();
    await expect(kim.page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
  });

  await test.step('Ana, the steward, suspends Kim through the dialog', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: GROUP }).click();
    await expect(people(page)).toContainText('Steward');
    await expect(people(page).getByRole('button', { name: 'Suspend Ana' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Suspend Kim' }).click();
    const dialog = page.getByRole('dialog', { name: 'Suspend Kim?' });
    await expect(dialog).toContainText(
      'Everyone in the group will see this. It ends after 7 days.',
    );
    // Opening it moves focus into the dialog.
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expectAccessible(ana, 'Suspend dialog');
    // The dialog keeps focus inside: Tab from its last button comes back to its first field.
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('textbox', { name: 'Reason (optional)' })).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Reason (optional)' }).fill(REASON);
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(people(page)).toContainText(/Suspended until .+\./);
    await expect(people(page)).toContainText(`Reason: ${REASON}`);
    await expect(page.getByRole('button', { name: /^Suspend / })).toHaveCount(0);
    await expectAccessible(ana, 'People with a suspension');
  });

  await test.step('Kim reads that she is suspended, over a disabled ballot', async () => {
    const { page } = kim;
    await page.goto(proposalUrl);
    await expect(page.getByText(SUSPENDED)).toBeVisible();
    const ballot = page.getByRole('radiogroup', { name: 'Score for version 1' });
    await expect(ballot.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    await expect(ballot.getByRole('radio', { name: '4 · Strongly supportive' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /your vote$/ })).toHaveCount(0);
    await expectAccessible(kim, 'disabled ballot while suspended');
  });

  await test.step('Ben, on a phone, proposes himself for the due seat 1', async () => {
    const { page } = ben;
    await expect(people(page)).toContainText(/Suspended until .+\./);
    const stewards = page.getByRole('region', { name: 'Stewards', exact: true });
    await expect(stewards).toContainText('A steward election is due for seat 1.');
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'Group home with stewards, on a phone');
    await stewards.getByRole('link', { name: 'Propose a steward for seat 1' }).click();
    await expect(heading(page, 'Propose a steward for seat 1')).toBeVisible();
    await expectAccessible(ben, 'Propose a steward');
    await pick(page, 'Ben');
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Make Ben steward (seat 1)',
    );
    await page.getByRole('textbox', { name: 'Why' }).fill('I can step in when things go wrong.');
    expect(await fitsWidth(page)).toBe(true);
    await page.getByRole('button', { name: 'Propose this steward' }).click();
    await expect(page.getByRole('region', { name: 'Make Ben steward (seat 1)' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'steward ballot, on a phone');
  });
});
