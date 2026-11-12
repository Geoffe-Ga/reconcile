/**
 * Entrenched and eternal sections (#116), end to end through the real relay
 * and the deploy CSP. Ana founds a group whose Mission statement has three
 * sections, and Ben joins. Ana proposes entrenching the first section and
 * making the second eternal, from Protect this section; each class Proposal
 * runs 14 days at the higher bar, and both pass. Both profiles then read the
 * first section as entrenched and the second as eternal, with no action on
 * it but its History (#104). Ana proposes a change to the entrenched section, whose ballot shows the
 * higher bar.
 *
 * Ana uses a wide desktop window in the light theme; Ben a 390 px phone in
 * the dark theme, where nothing may scroll sideways. axe, with contrast, runs
 * on the Document view, the protect composer with Eternal chosen and a class
 * ballot in both themes, and on the entrenched change's composer and ballot.
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
const CARE = 'We care for each other.';
const QUIET = 'Quiet hours start at ten.';
const BINS = 'Bins go out on Tuesday.';
const PERMANENT = 'This is permanent. Once it passes, the only way out is to leave the group.';
const ETERNAL_LINE = 'This section is eternal. It can’t be changed.';

const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** The Document's section blocks, in order. */
function blocks(page: Page): Locator {
  return page.locator('.document > .atom');
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

/** From Group home's Needs your vote, the Proposal titled `title`. */
async function openFromHome(person: Person, title: string): Promise<void> {
  const { page } = person;
  await goHome(person);
  await page
    .getByRole('region', { name: 'Needs your vote' })
    .getByRole('link', { name: new RegExp(title) })
    .click();
  await expect(heading(page, title)).toBeVisible();
}

/** Fills a protect composer's title and why, chooses `choice`, and proposes it. */
async function protect(person: Person, title: string, choice: string): Promise<void> {
  const { page } = person;
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('textbox', { name: 'Why' }).fill('It holds our group together.');
  await pick(page, choice, page.getByRole('radiogroup', { name: 'Protection' }));
  await page.getByRole('button', { name: 'Propose this protection' }).click();
  await expect(heading(page, title)).toBeVisible();
}

test('a group entrenches one section and makes another eternal, and every profile reads them so', async ({
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
      atoms: [CARE, QUIET, BINS],
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

  await test.step('A proposes entrenching the first section, at the higher bar, and both profiles pass it', async () => {
    const { page } = ana;
    await openDocument(ana);
    await page.getByRole('button', { name: 'Protect this section, section 1' }).click();
    await expect(heading(page, 'Protect this section')).toBeVisible();
    await expect(
      page.getByText(
        'Protecting a section, or removing its protection, needs your group’s higher bar: an average of 3.0 or more, with zeros under 5%.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('14');
    await pick(page, 'Eternal', page.getByRole('radiogroup', { name: 'Protection' }));
    await expect(page.getByText(PERMANENT)).toBeVisible();
    await expectAccessible(ana, 'the protect composer, Eternal chosen');
    await protect(ana, 'Protect what we value', 'Entrenched');
    const ballot = page.getByRole('region', { name: 'Protection for section 1' });
    await expect(
      ballot.getByRole('region', { name: 'Marks this section entrenched' }),
    ).toBeVisible();
    await expect(ballot.getByRole('meter', { name: 'Average · needs 3.0' })).toBeVisible();
    await expectAccessible(ana, 'a class ballot');
    await voteFor(ana, 'Your score');

    await openFromHome(ben, 'Protect what we value');
    expect(await fitsWidth(ben.page)).toBe(true);
    await expectAccessible(ben, 'a class ballot, on a dark phone');
    await voteFor(ben, 'Your score');
    await expect(ben.page.getByRole('region', { name: 'Result' })).toContainText(
      'This passed. The section is now entrenched.',
    );
  });

  await test.step('A proposes making the second section eternal, which can’t be undone, and it passes', async () => {
    const { page } = ana;
    await openDocument(ana);
    await page.getByRole('button', { name: 'Protect this section, section 2' }).click();
    await protect(ana, 'Quiet hours forever', 'Eternal');
    await expect(
      page.getByRole('region', { name: 'Marks this section eternal. This can’t be undone.' }),
    ).toBeVisible();
    await voteFor(ana, 'Your score');
    await openFromHome(ben, 'Quiet hours forever');
    await voteFor(ben, 'Your score');
    await expect(ben.page.getByRole('region', { name: 'Result' })).toContainText(
      'This passed. The section is now eternal.',
    );
  });

  await test.step('every profile reads the first section entrenched and the second eternal, with nothing to change on it', async () => {
    for (const person of [ana, ben]) {
      const { page } = person;
      await openDocument(person);
      await expect(blocks(page).locator('.atom-badge')).toHaveText(['Entrenched', 'Eternal']);
      await expect(blocks(page).nth(0).locator('.atom-badge svg')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
      const eternal = blocks(page).nth(1);
      // Only its History stays, as on every section (#104).
      await expect(eternal.getByRole('button')).toHaveCount(1);
      await expect(eternal.getByRole('button', { name: 'History of section 2' })).toBeVisible();
      await expect(eternal.getByText(ETERNAL_LINE)).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Change its protection, section 1' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Add a section here, after section 2' }),
      ).toBeVisible();
      expect(await fitsWidth(page)).toBe(true);
      await expectAccessible(person, 'the Document with entrenched and eternal sections');
    }
  });

  await test.step('B opens Protect this section on the third section on a dark phone, and Eternal warns it is permanent', async () => {
    const { page } = ben;
    await page.getByRole('button', { name: 'Protect this section, section 3' }).click();
    await expect(heading(page, 'Protect this section')).toBeVisible();
    await pick(page, 'Eternal', page.getByRole('radiogroup', { name: 'Protection' }));
    await expect(page.getByText(PERMANENT)).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'the protect composer, Eternal chosen, on a dark phone');
  });

  await test.step('A proposes a change to the entrenched section, whose composer and ballot show the higher bar', async () => {
    const { page } = ana;
    await openDocument(ana);
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await expect(
      page.getByText(
        'This section is entrenched. Changing, moving or removing it needs your group’s higher bar: an average of 3.0 or more, with zeros under 5%, and a longer vote.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('14');
    await expectAccessible(ana, 'a change to an entrenched section');
    await page.getByRole('textbox', { name: 'Title' }).fill('Care, and say so');
    await page.getByRole('textbox', { name: 'Why' }).fill('Say it out loud.');
    await page.getByRole('textbox', { name: 'New text' }).fill('We care for each other, out loud.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, 'Care, and say so')).toBeVisible();
    await expect(
      page.getByText(
        'This section is entrenched, so this needs your group’s higher bar: an average of 3.0 or more, with zeros under 5%.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('meter', { name: 'Zeros · under 5%' })).toBeVisible();
    await expectAccessible(ana, 'a ballot on an entrenched section');
  });
});
