/**
 * A Document built from headers up, then reordered (#103), end to end through
 * the real relay and the deploy CSP. Ana founds a group whose Mission
 * statement has one section, and Ben joins. From Add a section here, Ana
 * proposes 'Values' as a section header at the start and 'Organization' as a
 * subsection header at the end, and both pass. Ben then adds a section after
 * 'Values', which passes, and Ana proposes moving 'Organization' to the
 * start, which passes too. Both profiles read the same order, each header set
 * as a header.
 *
 * Ana uses a wide desktop window; Ben uses a 390 px phone in the dark theme,
 * where nothing may scroll sideways. axe checks the Add a section here menu,
 * the header composer, the Document view with its Move buttons, the move
 * composer, a move's ballot on both profiles, and the reordered Document,
 * whose first header is a subsection header, on both.
 */
import type { Locator, Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const MISSION = 'Mission statement';
const SHARE = 'We share what we have.';
const CARE = 'We care for each other.';

const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** The Document's sections, as they read, in order. */
function sections(page: Page): Locator {
  return page.locator('.document > .atom .atom-text');
}

/** Group home, from anywhere in the group: its back link, unless it's there already. */
async function goHome(person: Person): Promise<void> {
  const { page } = person;
  if (await heading(page, GROUP).isVisible()) return;
  await page.getByRole('link', { name: GROUP }).click();
  await expect(heading(page, GROUP)).toBeVisible();
}

/** From anywhere in the group: Group home, then the Mission statement. */
async function openDocument(person: Person): Promise<void> {
  const { page } = person;
  await goHome(person);
  await page
    .getByRole('region', { name: 'Documents' })
    .getByRole('link', { name: MISSION, exact: true })
    .click();
  await expect(heading(page, MISSION)).toBeVisible();
}

/** Scores the Proposal on screen 4, in `pills`, and sends the ballot. */
async function voteFor(person: Person, pills: string): Promise<void> {
  const { page } = person;
  await pick(page, '4 · Strongly supportive', page.getByRole('radiogroup', { name: pills }));
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** From Group home's Needs your vote, the Proposal titled `title`, scored 4, which closes it. */
async function passFromHome(person: Person, title: string, pills: string): Promise<void> {
  const { page } = person;
  await goHome(person);
  await page
    .getByRole('region', { name: 'Needs your vote' })
    .getByRole('link', { name: new RegExp(title) })
    .click();
  await expect(heading(page, title)).toBeVisible();
  await voteFor(person, pills);
  await expect(page.getByRole('region', { name: 'Result' })).toContainText('This passed.');
}

/**
 * From the Document view, Add a section here named `gap`, then the header
 * choice `choice`, whose one Heading line is `words`, and Propose this header.
 */
async function proposeHeader(person: Person, gap: string, choice: string, words: string) {
  const { page } = person;
  await page.getByRole('button', { name: gap }).click();
  await page.getByRole('menuitem', { name: choice, exact: true }).click();
  await page.getByRole('textbox', { name: 'Heading' }).fill(words);
  await page.getByRole('textbox', { name: 'Why' }).fill('An outline first, then the words.');
  await page.getByRole('button', { name: 'Propose this header' }).click();
}

test('a group builds a Document from headers up and moves a section, and every profile shows the same order', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });

  await test.step('A founds the group, and B joins as a Co-Creator', async () => {
    await visit(ana.page, '/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: MISSION,
      atoms: [SHARE],
      founder: ana.name,
    });
    await visit(ben.page, invite);
    await acceptNotice(ben);
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await pick(ben.page, 'Co-Creator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(ana.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ben',
    );
  });

  await test.step('A proposes Values as a section header, and Organization as a subsection header', async () => {
    const { page } = ana;
    await openDocument(ana);
    await page.getByRole('button', { name: 'Add a section here, at the start' }).click();
    await expect(page.getByRole('menuitem')).toHaveText([
      'Section',
      'Section header',
      'Subsection header',
    ]);
    await expectAccessible(ana, 'Add a section here’s menu');
    await page.keyboard.press('Escape');
    await proposeHeader(ana, 'Add a section here, at the start', 'Section header', 'Values');
    await expect(heading(page, 'Add section header: Values')).toBeVisible();
    await expect(
      page.getByText('Adds a section header ‘Values’ at the start', { exact: true }),
    ).toBeVisible();
    await voteFor(ana, 'Score for version 1');
    await openDocument(ana);
    await page.getByRole('button', { name: 'Add a section here, after section 1' }).click();
    await page.getByRole('menuitem', { name: 'Subsection header', exact: true }).click();
    await expect(heading(page, 'Add a subsection header')).toBeVisible();
    await page.getByRole('textbox', { name: 'Heading' }).fill('Organization');
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Add subsection header: Organization',
    );
    await expectAccessible(ana, 'Add a subsection header');
    await page.getByRole('textbox', { name: 'Why' }).fill('How we work together.');
    await page.getByRole('button', { name: 'Propose this header' }).click();
    await expect(heading(page, 'Add subsection header: Organization')).toBeVisible();
    await voteFor(ana, 'Score for version 1');
  });

  await test.step('B passes both headers, and the outline reads Values, then the section, then Organization', async () => {
    await passFromHome(ben, 'Add section header: Values', 'Score for version 1');
    await passFromHome(ben, 'Add subsection header: Organization', 'Score for version 1');
    await openDocument(ben);
    await expect(sections(ben.page)).toHaveText(['Values', SHARE, 'Organization']);
    await expect(ben.page.getByRole('heading', { level: 2, name: 'Values' })).toBeVisible();
    await expect(ben.page.getByRole('heading', { level: 3, name: 'Organization' })).toBeVisible();
    expect(await fitsWidth(ben.page)).toBe(true);
  });

  await test.step('B adds a section after Values, and it passes', async () => {
    const { page } = ben;
    await page.getByRole('button', { name: 'Add a section here, after section 1' }).click();
    await page.getByRole('menuitem', { name: 'Section', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('What we value');
    await page.getByRole('textbox', { name: 'Why' }).fill('Say what Values means.');
    await page.getByRole('textbox', { name: 'Section text' }).fill(CARE);
    await page.getByRole('button', { name: 'Propose this section' }).click();
    await expect(heading(page, 'What we value')).toBeVisible();
    await expect(page.getByText('Adds a section after ‘Values’', { exact: true })).toBeVisible();
    await voteFor(ben, 'Score for version 1');
    await passFromHome(ana, 'What we value', 'Score for version 1');
  });

  await test.step('A moves Organization to the start, and both profiles score the move', async () => {
    const { page } = ana;
    await openDocument(ana);
    await expect(sections(page)).toHaveText(['Values', CARE, SHARE, 'Organization']);
    await expectAccessible(ana, 'Document view with Move this section');
    await page.getByRole('button', { name: 'Move this section, section 4' }).click();
    await expect(heading(page, 'Move this section')).toBeVisible();
    const place = page.getByRole('radiogroup', { name: 'Where it goes' });
    await expect(place.getByRole('radio')).toHaveCount(4);
    await expect(place.getByRole('radio', { name: `Put it after: ${SHARE}` })).toBeDisabled();
    await expectAccessible(ana, 'the move composer');
    await page.getByRole('textbox', { name: 'Title' }).fill('Organization first');
    await page.getByRole('textbox', { name: 'Why' }).fill('Say how we work before what we value.');
    await pick(page, 'Put it first', place);
    await page.getByRole('button', { name: 'Propose this move' }).click();
    await expect(heading(page, 'Organization first')).toBeVisible();
    const ballot = page.getByRole('region', { name: 'Moving section 4' });
    await expect(
      ballot.getByRole('region', { name: 'Moves this section to the start' }),
    ).toBeVisible();
    await expectAccessible(ana, 'a move’s ballot');
    await voteFor(ana, 'Your score');

    await goHome(ben);
    await ben.page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: /Organization first/ })
      .click();
    await expect(heading(ben.page, 'Organization first')).toBeVisible();
    expect(await fitsWidth(ben.page)).toBe(true);
    await expectAccessible(ben, 'a move’s ballot, on a phone');
    await voteFor(ben, 'Your score');
    await expect(ben.page.getByRole('region', { name: 'Result' })).toContainText(
      'This passed. The section has moved.',
    );
  });

  await test.step('every profile shows the same order, each header as a header', async () => {
    for (const person of [ana, ben]) {
      const { page } = person;
      await openDocument(person);
      await expect(sections(page)).toHaveText(['Organization', 'Values', CARE, SHARE]);
      await expect(page.locator('.document > .atom.atom-heading .atom-text')).toHaveText([
        'Organization',
        'Values',
      ]);
      expect(await fitsWidth(page)).toBe(true);
      // Organization, a subsection header, now comes first: it reads h2, so no level is skipped.
      await expectAccessible(person, 'the Document, reordered');
    }
  });
});
