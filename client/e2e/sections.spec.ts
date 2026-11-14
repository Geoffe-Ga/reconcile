/**
 * Adding and removing sections (#75), end to end through the real relay and
 * the deploy CSP: Ana proposes a new section after the first one, and a new
 * wording of the second. Ben proposes removing the second, which joins that
 * Proposal's ballot beside the new wording (ADR-0004). Both score everything,
 * so both votes close early: the add passes, the removal beats the rewording,
 * and every profile shows the same Document.
 *
 * Ana uses a wide desktop window; Ben uses a 390 px phone in the dark theme,
 * where nothing may scroll sideways. axe checks the Document view with its
 * gaps and the composers, and both ballots: the add's, and the one that holds
 * a rewording and a removal.
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
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const FIRST_ATOM = 'Quiet hours start at 10pm.';
const SECOND_ATOM = 'Shared spaces are cleaned every Sunday.';
const NEW_ATOM = 'Guests are welcome until 11pm.';
const ADD = 'Guests';
const REWORD = 'Cleaning on Saturdays';

const PHONE = { width: 390, height: 844 };

/** Version `n`'s score pills. */
function scores(page: Page, n: number): Locator {
  return page.getByRole('radiogroup', { name: `Score for version ${String(n)}` });
}

/** The ballot's send status. */
function sendStatus(page: Page): Locator {
  return page.locator('.ballot-send').getByRole('status');
}

/** True when nothing on the page scrolls sideways: the document, nor the region it scrolls in under the link bar (#444). */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    [document.documentElement, document.querySelector('.app-page')].every(
      (box) => box === null || box.scrollWidth <= box.clientWidth,
    ),
  );
}

/** Scores each version with its pill, in order, and sends the ballot. */
async function vote(person: Person, pills: readonly string[]): Promise<void> {
  const { page } = person;
  for (const [index, pill] of pills.entries()) await pick(page, pill, scores(page, index + 1));
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(sendStatus(page)).toHaveText('Sent');
}

/** From anywhere in the group, Group home, then the Document view. */
async function openDocument(person: Person): Promise<void> {
  const { page } = person;
  await page.getByRole('link', { name: GROUP }).click();
  await page.getByRole('link', { name: TITLE, exact: true }).click();
  await expect(heading(page, TITLE)).toBeVisible();
}

/** From anywhere in the group, Group home, then a Proposal waiting under Needs your vote (#77). */
async function openProposal(person: Person, title: string): Promise<void> {
  const { page } = person;
  await page.getByRole('link', { name: GROUP }).click();
  await page
    .getByRole('region', { name: 'Needs your vote' })
    .getByRole('link', { name: title })
    .click();
  await expect(heading(page, title)).toBeVisible();
}

/** The Document as one profile sees it, once both votes have closed. */
async function expectDocument(person: Person): Promise<void> {
  await openDocument(person);
  await expect(person.page.getByRole('article').getByRole('paragraph')).toHaveText([
    FIRST_ATOM,
    NEW_ATOM,
  ]);
}

test('a group adds one section and removes another, and every profile shows the same Document', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });

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
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const link = page.getByRole('textbox', { name: 'Invite link' });
    await expect(link).toHaveValue(/#join\/[\w-]{43}$/);
    const invite = await link.inputValue();

    await ben.page.goto(invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await pick(ben.page, 'Co-Creator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
  });

  await test.step('A proposes a new section after the first, and scores it', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await expect(page.getByRole('button', { name: /^Add a section/ })).toHaveCount(3);
    await expectAccessible(ana, 'Document view');
    await page.getByRole('button', { name: 'Add a section here, after section 1' }).click();
    // Add a section here offers a section or a header (#103).
    await page.getByRole('menuitem', { name: 'Section', exact: true }).click();
    await expect(heading(page, 'Add a section')).toBeVisible();
    await expectAccessible(ana, 'Add a section');
    await page.getByRole('textbox', { name: 'Title' }).fill(ADD);
    await page.getByRole('textbox', { name: 'Why' }).fill('Guests visit most evenings.');
    await page.getByRole('textbox', { name: 'Section text' }).fill(NEW_ATOM);
    await page.getByRole('button', { name: 'Propose this section' }).click();
    await expect(heading(page, ADD)).toBeVisible();
    const ballot = page.getByRole('region', { name: 'New section' });
    await expect(ballot.getByText(`Adds a section after ‘${FIRST_ATOM}’`)).toBeVisible();
    await expect(ballot.locator('.word-diff ins')).toHaveText(NEW_ATOM);
    await expectAccessible(ana, 'an add’s ballot');
    await vote(ana, ['4 · Strongly supportive']);
  });

  await test.step('A proposes a new wording of the second section, and scores it', async () => {
    const { page } = ana;
    await openDocument(ana);
    await page.getByRole('button', { name: 'Propose a change to section 2' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(REWORD);
    await page.getByRole('textbox', { name: 'Why' }).fill('Saturdays suit more of us.');
    await page
      .getByRole('textbox', { name: 'New text' })
      .fill('Shared spaces are cleaned every Saturday.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, REWORD)).toBeVisible();
    await vote(ana, ['3 · Supportive']);
  });

  await test.step('B proposes removing the second section, which joins its ballot', async () => {
    const { page } = ben;
    // Ben is still on Group home, where he joined.
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add your version to section 2' })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'Document view, on a phone');
    await page.getByRole('button', { name: 'Propose removing this section, section 2' }).click();
    await expect(heading(page, 'Propose removing this section')).toBeVisible();
    await expect(page.locator('.word-diff del')).toHaveText(SECOND_ATOM);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expectAccessible(ben, 'removal on an open ballot');
    await page.getByRole('button', { name: 'Add removal to the ballot' }).click();
    await expect(heading(page, REWORD)).toBeVisible();
    const removal = page.getByRole('region', { name: 'Version 2 · Ben' });
    await expect(removal.getByText('Removes this section')).toBeVisible();
    await expect(removal.locator('.word-diff del')).toHaveText(SECOND_ATOM);
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'a ballot with a rewording and a removal');
    await vote(ben, ['1 · Opposed', '4 · Strongly supportive']);
  });

  await test.step('B scores the add, which closes its vote early', async () => {
    await openProposal(ben, ADD);
    await vote(ben, ['4 · Strongly supportive']);
    await expect(ben.page.getByRole('region', { name: 'Result' })).toContainText(
      'This passed. The Document now reads:',
    );
  });

  await test.step('A scores the removal too, and the removal passes', async () => {
    const { page } = ana;
    await openProposal(ana, REWORD);
    await expect(
      page.getByText('A new version was added. Score it to update your ballot.'),
    ).toBeVisible();
    await pick(page, '4 · Strongly supportive', scores(page, 2));
    await page.getByRole('button', { name: 'Update your vote' }).click();
    await expect(sendStatus(page)).toHaveText('Sent');
    await expect(page.getByRole('region', { name: 'Result' })).toContainText(
      'Version 2 passed. The Document no longer has this section.',
    );
    await expectAccessible(ana, 'a removal’s result');
  });

  await test.step('every profile shows the same Document', async () => {
    for (const person of [ana, ben]) await expectDocument(person);
    expect(await fitsWidth(ben.page)).toBe(true);
  });
});
