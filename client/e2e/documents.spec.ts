/**
 * Several Documents per group (#92), end to end through the real relay and the
 * deploy CSP: Ana founds a group with two Documents, Mission statement and
 * House rules, from two blocks on Create group. Ben joins. Ana proposes a new
 * Document, Budget, and both score it, which closes the vote early. Then both
 * profiles list all three Documents on Group home, in order, open Budget and
 * read the same sections, and its ballot and Decided entry name it.
 *
 * Ana uses a wide desktop window; Ben uses a 390 px phone in the dark theme,
 * where nothing may scroll sideways. axe checks Create group with two blocks,
 * Group home with its Documents, the new-Document composer, the ballot, the
 * second Document's view and the new Document's.
 */
import type { Locator, Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const MISSION = 'Mission statement';
const MISSION_ATOMS = ['We share what we can.', 'We meet every week.'];
const RULES = 'House rules';
const RULES_ATOMS = ['Quiet hours start at 10pm.', 'Bins go out on Sunday.'];
const BUDGET = 'Budget';
const PROPOSAL = 'Start a budget';
const BUDGET_TEXT = '# Budget\n\nWe share costs evenly.';

const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** The block of Document `number` on Create group. */
function block(page: Page, number: number): Locator {
  return page.getByRole('group', { name: `Document ${String(number)}` });
}

/** Scores the one version 4 and sends the ballot. */
async function voteFor(person: Person): Promise<void> {
  const { page } = person;
  const pills = page.getByRole('radiogroup', { name: 'Score for version 1' });
  await pick(page, '4 · Strongly supportive', pills);
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** Group home's list of Documents. */
function documentsList(page: Page): Locator {
  return page.getByRole('region', { name: 'Documents' });
}

/** Group home, from anywhere in the group: its back link, unless it's there already. */
async function goHome(person: Person): Promise<void> {
  const { page } = person;
  if (await heading(page, GROUP).isVisible()) return;
  await page.getByRole('link', { name: GROUP }).click();
  await expect(heading(page, GROUP)).toBeVisible();
}

/** From anywhere in the group: Group home, then the Document titled `title`, which must show `sections`. */
async function readDocument(person: Person, title: string, sections: readonly string[]) {
  const { page } = person;
  await goHome(person);
  await documentsList(page).getByRole('link', { name: title, exact: true }).click();
  await expect(heading(page, title)).toBeVisible();
  await expect(page.locator('.atom-text')).toHaveText([...sections]);
}

test('a group founds two Documents, adds a third by Proposal, and every profile reads it', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });

  await test.step('A founds the group with two Document blocks, and B joins as a Co-Creator', async () => {
    const { page } = ana;
    await visit(page, '/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    const first = block(page, 1);
    await expect(first.getByRole('textbox', { name: 'Document title' })).toHaveValue(MISSION);
    await first.getByRole('textbox', { name: 'Document text' }).fill(MISSION_ATOMS.join('\n\n'));
    await page.getByRole('button', { name: 'Add another Document' }).click();
    const second = block(page, 2);
    await expect(second.getByRole('textbox', { name: 'Document title' })).toBeFocused();
    await second.getByRole('textbox', { name: 'Document title' }).fill(RULES);
    await second.getByRole('textbox', { name: 'Document text' }).fill(RULES_ATOMS.join('\n\n'));
    await expect(second.getByRole('button', { name: 'Remove Document 2' })).toBeVisible();
    await expectAccessible(ana, 'Create group with two Documents');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const link = page.getByRole('textbox', { name: 'Invite link' });
    await expect(link).toHaveValue(/#join\/[\w-]{43}$/);
    const invite = await link.inputValue();

    await visit(ben.page, invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    // The invite preview shows the first Document alone (#91, #92).
    await expect(ben.page.getByText(MISSION, { exact: true })).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await pick(ben.page, 'Co-Creator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
  });

  await test.step('Group home lists both Documents, and the second opens on its own', async () => {
    const { page } = ana;
    await expect(documentsList(page).getByRole('link')).toHaveText([
      `${MISSION}→`,
      `${RULES}→`,
      'Propose a new Document',
    ]);
    await expectAccessible(ana, 'Group home with two Documents');
    await readDocument(ana, RULES, RULES_ATOMS);
    await expectAccessible(ana, 'the second Document');
  });

  await test.step('A proposes a new Document, Budget, and scores it', async () => {
    const { page } = ana;
    await goHome(ana);
    await page.getByRole('link', { name: 'Propose a new Document' }).click();
    await expect(heading(page, 'Propose a new Document')).toBeVisible();
    await expectAccessible(ana, 'Propose a new Document');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(PROPOSAL);
    await page
      .getByRole('textbox', { name: 'Why' })
      .fill('We spend together, so we should plan it.');
    await page.getByRole('textbox', { name: 'Document title' }).fill(BUDGET);
    await page.getByRole('textbox', { name: 'First sections' }).fill(BUDGET_TEXT);
    await page.getByRole('button', { name: 'Propose this Document' }).click();
    await expect(heading(page, PROPOSAL)).toBeVisible();
    await expect(page.locator('.document-of')).toHaveText(`New Document: ${BUDGET}`);
    const ballot = page.getByRole('region', { name: 'First sections' });
    await expect(ballot.locator('.word-diff ins')).toHaveText(BUDGET_TEXT);
    await expectAccessible(ana, 'a new Document’s ballot');
    await voteFor(ana);
  });

  await test.step('B finds it under Needs your vote, named as a new Document, and scores it', async () => {
    const { page } = ben;
    const waiting = page.getByRole('region', { name: 'Needs your vote' }).getByRole('link');
    await expect(waiting.locator('.document-of')).toHaveText(`New Document: ${BUDGET}`);
    await waiting.click();
    await expect(heading(page, PROPOSAL)).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'a new Document’s ballot, on a phone');
    await voteFor(ben);
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('This passed.');
  });

  await test.step('both profiles list it after the founding two, read the same text, and see it decided', async () => {
    for (const person of [ana, ben]) {
      const { page } = person;
      await goHome(person);
      await expect(documentsList(page).locator('.card-link')).toHaveText([
        `${MISSION}→`,
        `${RULES}→`,
        `${BUDGET}→`,
      ]);
      const decided = page.getByRole('region', { name: 'Decided' }).getByRole('link');
      await expect(decided.locator('.document-of')).toHaveText(`New Document: ${BUDGET}`);
      await expect(decided).toContainText('Passed');
      expect(await fitsWidth(page)).toBe(true);
      await expectAccessible(person, 'Group home with three Documents');
      await readDocument(person, BUDGET, ['Budget', 'We share costs evenly.']);
      expect(await fitsWidth(page)).toBe(true);
      await expectAccessible(person, 'the new Document');
    }
  });
});
