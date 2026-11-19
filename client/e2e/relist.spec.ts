/**
 * Listing a front door again after a steward's narrowing (#501;
 * docs/spec/listed-doors.md §3.3), end to end under the deploy CSP and
 * through the real relay. Ana founds a group, and Ben (on a phone, in the
 * dark theme) and Cal join. One Proposal opens the front door and lists it,
 * and everyone votes it through at the entrenched bar, which closes early
 * once all three have scored; nothing moves time.
 *
 * Then Ana, the steward, turns the door off now. From that moment Group
 * rules says the listing has ended for good. The group turns her
 * off-Proposal down, all three scoring 0, so the narrowing lapses and the
 * door reopens: it stands open, and Group rules still says it is not listed,
 * and offers "Propose listing this door" straight away. Its composer says
 * listing again moves the door to a new link, and asks the higher bar,
 * though the standing value still reads listed: the fold classes it as a
 * listing. That one vote lists the door at new keys: the link Group rules
 * gives is no longer the finalized address. axe runs on each screen, in
 * both themes.
 */
import type { Page } from '@playwright/test';

import { copyInvite, expect, expectAccessible, heading, test, visit } from './support/fixtures';
import { found, join, vote } from './support/steps';

const GROUP = 'Riverside Tenants';
const PHONE = { width: 390, height: 844 };
const ENDED =
  'Not listed. A steward’s narrowing took this door off the public shelf for good. Your group can vote afresh to list it again, at a new link.';
const LISTED = 'Listed on the public shelf, under the covenant your group accepted.';

/** The front door's card on Group rules. */
function doorCard(page: Page) {
  return page.getByRole('region', { name: 'Front door' });
}

/** The link Group rules gives for the open front door. */
async function doorLink(page: Page): Promise<string> {
  const field = doorCard(page).getByRole('textbox', { name: 'Front door link' });
  await expect(field).toHaveValue(/\/#door\/[\w-]{43}$/);
  return field.inputValue();
}

test('a narrowing ends a listing for good, and the group lists its door again at a new link', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile('Cal');
  let rulesUrl = '';
  let oldLink = '';

  /** Everyone scores the Proposal at `url` with `pill`, giving `note` as a 0's reason. */
  async function everyone(url: string, pill: string, note?: string): Promise<void> {
    for (const person of [ana, cal, ben]) {
      await visit(person.page, url);
      await vote(person, pill, note);
    }
  }

  /** Ana proposes from the open composer with `why`, and returns the Proposal's URL. */
  async function propose(why: string, title: string): Promise<string> {
    const { page } = ana;
    await page.getByRole('textbox', { name: 'Why' }).fill(why);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    // The composer's own heading is the motion too: wait for the Proposal's route.
    await expect(page).toHaveURL(/#\/g\/[\w-]+\/p\/[\w-]+$/);
    await expect(heading(page, title)).toBeVisible();
    return page.url();
  }

  await test.step('Ana founds the group, and Ben and Cal join', async () => {
    const home = await found(ana, {
      name: GROUP,
      title: 'House rules',
      atoms: ['We keep rents fair.', 'Bins out on Sunday.'],
      founder: ana.name,
    });
    const invite = await copyInvite(ana.page);
    await join(ben, invite, GROUP, 'Co-Creator');
    await join(cal, invite, GROUP, 'Co-Creator');
    await visit(ana.page, home);
    const people = ana.page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText(cal.name, { timeout: 45_000 });
    await expect(people).toContainText(ben.name, { timeout: 45_000 });
    await ana.page.getByRole('link', { name: /Chat bot and front door/ }).click();
    rulesUrl = ana.page.url();
  });

  await test.step('one Proposal opens the front door and lists it, and everyone votes it through', async () => {
    const { page } = ana;
    await doorCard(page)
      .getByRole('link', { name: 'Propose turning this on for the front door' })
      .click();
    const list = page.getByRole('checkbox', { name: 'Also list it on the public shelf' });
    await page.locator('label', { has: list }).click();
    await expect(list).toBeChecked();
    const url = await propose('We want neighbours to find us.', 'Open a front door');
    await everyone(url, '4 · Strongly supportive');
    await expect(
      ben.page.getByText(
        'This passed. Your group’s front door is open and listed on the public shelf.',
      ),
    ).toBeVisible();
    await visit(page, rulesUrl);
    await expect(doorCard(page).getByText(LISTED)).toBeVisible();
    oldLink = await doorLink(page);
  });

  let offUrl = '';
  await test.step('Ana, the steward, turns the door off now, and the listing ends at once', async () => {
    const { page } = ana;
    await doorCard(page).getByRole('link', { name: 'Turn off now for the front door' }).click();
    await page.getByRole('textbox', { name: 'Why' }).fill('Spam is coming through the door.');
    await page.getByRole('button', { name: 'Turn off now' }).click();
    await expect(page.getByRole('region', { name: 'Close the front door' })).toBeVisible();
    offUrl = page.url();
    await visit(ben.page, rulesUrl);
    await expect(doorCard(ben.page).getByText(ENDED)).toBeVisible({ timeout: 45_000 });
    await expectAccessible(ben, 'Group rules on a phone, dark, narrowed');
  });

  await test.step('the group turns the off-Proposal down, the door reopens, and it stays off the shelf', async () => {
    await everyone(offUrl, '0 · Strongly opposed', 'Keep the door open.');
    await expect(ben.page.getByText('This didn’t pass.')).toBeVisible();
    for (const person of [ana, ben]) {
      await visit(person.page, rulesUrl);
      const card = doorCard(person.page);
      await expect(card.getByText('Open', { exact: true })).toBeVisible({ timeout: 45_000 });
      await expect(card.getByText(ENDED)).toBeVisible();
      await expect(card.getByText(LISTED)).toHaveCount(0);
      await expect(card.getByRole('link', { name: 'Propose listing this door' })).toBeVisible();
      await expectAccessible(person, `Group rules, listing ended, as ${person.name}`);
    }
  });

  await test.step('one fresh entrenched vote lists the door again, at a new link', async () => {
    const { page } = ana;
    await visit(page, rulesUrl);
    await doorCard(page).getByRole('link', { name: 'Propose listing this door' }).click();
    await expect(heading(page, 'List the front door on the public shelf')).toBeVisible();
    await expect(
      page.getByText(
        'The shelf keeps this door’s old listing final, so listing it again moves it to a new link, and the old link closes.',
      ),
    ).toBeVisible();
    await expect(page.getByText(/higher bar/)).toBeVisible();
    await expectAccessible(ana, 'Listing composer, listing again');
    const url = await propose(
      'We want neighbours to find us again.',
      'List the front door on the public shelf',
    );
    await visit(ben.page, url);
    await expect(
      ben.page.getByText(/It moves to a new link, and the old link closes\./),
    ).toBeVisible();
    await expectAccessible(ben, 'Ballot listing again, on a phone, dark');
    await everyone(url, '4 · Strongly supportive');
    await expect(
      ben.page.getByText('This passed. Your group’s front door is listed on the public shelf.'),
    ).toBeVisible();
    for (const person of [ana, ben]) {
      await visit(person.page, rulesUrl);
      await expect(doorCard(person.page).getByText(LISTED)).toBeVisible({ timeout: 45_000 });
      await expect(doorCard(person.page).getByText(ENDED)).toHaveCount(0);
      await expectAccessible(person, `Group rules, listed again, as ${person.name}`);
    }
    const newLink = await doorLink(page);
    expect(newLink).not.toBe(oldLink);
  });
});
