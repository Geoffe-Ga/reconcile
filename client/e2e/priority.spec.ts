/**
 * Priority votes (#107), end to end through the real relay and the deploy
 * CSP: Ana asks her group what to focus on with seven options, she and Ben
 * score every option, the vote closes early, the options that pass rank by
 * average, and the top one shows on both Group homes as the current focus.
 *
 * Ana uses a wide desktop window. Ben uses a 375 px phone in the dark theme,
 * where the seven options stack with no sideways scroll. axe checks the
 * composer, the seven-option ballot, the result and Group home.
 */
import { type Locator, type Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type Person,
  pick,
  test,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const QUESTION = 'What should we focus on?';
const OPTIONS = [
  'Fix the website',
  'Plan the picnic',
  'New bylaws',
  'Rent strike',
  'Fund the food bank',
  'Repaint the hall',
  'Start a newsletter',
];

/** A phone's width: the narrowest the ballot must fit without scrolling sideways. */
const PHONE = { width: 375, height: 812 };

/** The score pills for `option`. */
function scores(page: Page, option: string): Locator {
  return page.getByRole('radiogroup', { name: `Score for ${option}` });
}

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** Scores each option with the pill numbered in `pills`, in ballot order, and sends the ballot. */
async function vote(person: Person, pills: readonly number[], reason?: string): Promise<void> {
  const { page } = person;
  const labels = ['Strongly opposed', 'Opposed', 'Neutral', 'Supportive', 'Strongly supportive'];
  for (const [index, pill] of pills.entries()) {
    const option = OPTIONS[index] ?? '';
    await pick(page, `${String(pill)} · ${labels[pill] ?? ''}`, scores(page, option));
  }
  if (reason !== undefined) {
    await page.getByRole('textbox', { name: 'Your reason for a 0' }).fill(reason);
  }
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** The result, once the vote has closed: the focus, then the ranking, then the rest. */
async function expectRanking(person: Person): Promise<void> {
  const { page } = person;
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result.locator('.result-outcome')).toContainText(
    'Your group’s focus is now:Plan the picnic',
  );
  await expect(
    result.getByRole('list', { name: 'Passed, best first' }).getByRole('listitem'),
  ).toHaveText([
    'Plan the picnic',
    'Repaint the hall',
    'Fix the website',
    'Fund the food bank',
    'Start a newsletter',
  ]);
  await expect(
    result.getByRole('list', { name: 'Didn’t clear the floor' }).getByRole('listitem'),
  ).toHaveText(['New bylaws', 'Rent strike']);
  await expectAccessible(person, 'priority result');
  await page.getByRole('link', { name: GROUP }).click();
  const focus = page.getByRole('region', { name: 'Focus' });
  await expect(focus.getByRole('link', { name: /Current focus/ })).toContainText('Plan the picnic');
  await expectAccessible(person, 'Group home with a focus');
}

test('A asks what to focus on, both score seven options, and the top one becomes the focus', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });

  await test.step('A creates a group, and B joins it', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: 'House rules',
      atoms: ['Quiet hours start at 10pm.'],
      founder: ana.name,
    });
    await ben.page.goto(invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ben',
    );
  });

  await test.step('A asks with seven options, after the composer refuses a repeat', async () => {
    const { page } = ana;
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
    await page.getByRole('link', { name: 'Ask what to focus on' }).click();
    await expect(heading(page, 'Ask what to focus on')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue(QUESTION);
    await expectAccessible(ana, 'priority composer');
    await page.getByRole('textbox', { name: 'Why' }).fill('We can only do one thing well.');
    for (const [index, option] of OPTIONS.entries()) {
      if (index >= 2) await page.getByRole('button', { name: 'Add option' }).click();
      await page.getByRole('textbox', { name: `Option ${String(index + 1)}` }).fill(option);
    }
    await expect(page.getByRole('button', { name: 'Add option' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Option 7' }).fill('Fix the website ');
    await page.getByRole('button', { name: 'Ask your group' }).click();
    await expect(page.getByText('This option is already on the list.')).toBeVisible();
    await expectAccessible(ana, 'priority composer with an error');
    await page.getByRole('textbox', { name: 'Option 7' }).fill(OPTIONS[6] ?? '');
    await page.getByRole('button', { name: 'Ask your group' }).click();
    await expect(scores(page, OPTIONS[0] ?? '')).toBeVisible();
    await expect(page.getByText('Proposal 1 · Priority vote', { exact: true })).toBeVisible();
  });

  await test.step('on a phone the seven options stack, with no sideways scroll', async () => {
    const { page } = ben;
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: QUESTION })
      .click();
    await expect(scores(page, OPTIONS[6] ?? '')).toBeVisible();
    await expect(page.getByRole('group', { name: 'How Rent strike stands so far' })).toContainText(
      'No scores yet',
    );
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'seven-option ballot, on a phone');
  });

  await test.step('both score every option, and the vote closes early', async () => {
    await vote(ana, [3, 4, 1, 4, 2, 3, 2]);
    await expectAccessible(ana, 'seven-option ballot, after voting');
    await vote(ben, [3, 4, 1, 0, 2, 4, 2], 'A strike needs more people first.');
    for (const person of [ana, ben]) await expectRanking(person);
  });
});
