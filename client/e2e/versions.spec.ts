/**
 * Competing versions on one ballot (#72), end to end through the real relay
 * and the deploy CSP: Ana proposes, Ben adds his own wording as version 2,
 * both score both versions, and the passing version with the higher average
 * becomes the section's text on every profile.
 *
 * Ana uses a wide desktop window, where the versions sit side by side. Ben
 * uses a 375 px phone in the dark theme, where they stack with no sideways
 * scroll. axe checks each ballot. Nothing moves time: both score both
 * versions, so the vote closes early.
 */
import { type Locator, type Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
} from './support';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const FIRST_ATOM = 'Quiet hours start at 10pm.';
const SECOND_ATOM = 'Shared spaces are cleaned every Sunday.';
const PROPOSAL = 'Later quiet hours';
const ANA_TEXT = 'Quiet hours start at 11pm.';
const BEN_TEXT = 'Quiet hours start at 11pm, and at midnight on Fridays and Saturdays.';

/** A phone's width: the narrowest the ballot must fit without scrolling sideways. */
const PHONE = { width: 375, height: 812 };

/** Version `n`'s card on the ballot. */
function version(page: Page, n: number, author: string): Locator {
  return page.getByRole('region', { name: `Version ${String(n)} · ${author}` });
}

/** Version `n`'s score pills. */
function scores(page: Page, n: number): Locator {
  return page.getByRole('radiogroup', { name: `Score for version ${String(n)}` });
}

/** The ballot's send status. */
function sendStatus(page: Page): Locator {
  return page.locator('.ballot-send').getByRole('status');
}

/** Scores each version with its pill, in order, and sends the ballot. */
async function vote(person: Person, pills: readonly string[]): Promise<void> {
  const { page } = person;
  for (const [index, pill] of pills.entries()) await pick(page, pill, scores(page, index + 1));
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(sendStatus(page)).toHaveText('Sent');
}

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** Once the vote has closed: Ben's version passed, and the Document reads it. */
async function expectBensVersion(person: Person): Promise<void> {
  const { page } = person;
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result.getByRole('paragraph')).toHaveText([
    'Version 2 passed. The Document now reads:',
    BEN_TEXT,
  ]);
  await expectAccessible(person, 'Result');
  await page.getByRole('link', { name: GROUP }).click();
  await page.getByRole('link', { name: TITLE }).click();
  await expect(page.getByRole('article').getByRole('paragraph')).toHaveText([
    BEN_TEXT,
    SECOND_ATOM,
  ]);
}

test('B adds a version to A’s Proposal, both score both, and the better one passes', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  let proposalUrl = '';

  await test.step('A creates a group, and B joins it as a Co-Creator', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page
      .getByRole('textbox', { name: 'Document text' })
      .fill(`${FIRST_ATOM}\n\n${SECOND_ATOM}`);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();

    await ben.page.goto(invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    // Adding a version is proposing, which only the creating level holds.
    await pick(ben.page, 'Co-Creator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ben',
    );
  });

  await test.step('A proposes on the first section and scores it', async () => {
    const { page } = ana;
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill(ANA_TEXT);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(scores(page, 1)).toBeVisible();
    proposalUrl = page.url();
    await vote(ana, ['3 · Supportive']);
  });

  await test.step('B adds a version from the Document view', async () => {
    const { page } = ben;
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Add your version to section 1' }).click();
    await expect(heading(page, 'Add your version')).toBeVisible();
    const text = page.getByRole('textbox', { name: 'Your version' });
    await expect(text).toHaveValue(`${FIRST_ATOM}\n`);
    await expectAccessible(ben, 'Add your version');
    // The composer refuses a copy of a version already on the ballot.
    await text.fill(ANA_TEXT);
    await page.getByRole('button', { name: 'Add your version' }).click();
    await expect(
      page.getByText(
        'This reads the same as a version already on the ballot. Change it to add something new.',
      ),
    ).toBeVisible();
    await text.fill(BEN_TEXT);
    await page.getByRole('button', { name: 'Add your version' }).click();
    await expect(page).toHaveURL(proposalUrl);
    await expect(version(page, 2, 'Ben')).toBeVisible();
  });

  await test.step('on a phone the versions stack, with no sideways scroll', async () => {
    const { page } = ben;
    const first = await version(page, 1, 'Ana').boundingBox();
    const second = await version(page, 2, 'Ben').boundingBox();
    expect(second?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 1);
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'ballot with two versions, on a phone');
  });

  await test.step('A is asked to score the new version, beside the first', async () => {
    const { page } = ana;
    await expect(version(page, 2, 'Ben')).toBeVisible();
    await expect(
      page.getByText('A new version was added. Score it to update your ballot.'),
    ).toBeVisible();
    await expect(scores(page, 1).getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    const first = await version(page, 1, 'Ana').boundingBox();
    const second = await version(page, 2, 'Ben').boundingBox();
    expect(Math.abs((second?.y ?? 0) - (first?.y ?? 1))).toBeLessThan(1);
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ana, 'ballot with two versions, side by side');
    await pick(page, '4 · Strongly supportive', scores(page, 2));
    await page.getByRole('button', { name: 'Update your vote' }).click();
    await expect(sendStatus(page)).toHaveText('Sent');
  });

  await test.step('B scores both, and the vote closes early', async () => {
    await vote(ben, ['2 · Neutral', '4 · Strongly supportive']);
    for (const person of [ana, ben]) await expectBensVersion(person);
  });
});
