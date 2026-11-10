/**
 * The tracer loop (#67), end to end: three people, each in a browser profile
 * of their own, found a group, join it (Ben at Join's preselected
 * Collaborator, Cal as a Co-Creator), propose a change, vote (one of them
 * offline) and see the Update, through the real relay, with the build served
 * under the deploy CSP.
 *
 * axe checks every screen they settle on, and any CSP violation in any page
 * fails the test. Nothing here moves time: everyone scores, so the vote
 * closes early.
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
const CHAT = 'https://chat.example.org/riverside';
const TITLE = 'House rules';
const FIRST_ATOM = 'Quiet hours start at 10pm.';
const SECOND_ATOM = 'Shared spaces are cleaned every Sunday.';
const ATOMS = [FIRST_ATOM, SECOND_ATOM];
/**
 * Everyone on the People list, with who invited them and the level each chose:
 * both joined from Ana's link, and Cal picks Co-Creator at Join. Ana founded
 * the group, so she holds steward seat 1 (#102).
 */
const PEOPLE = [
  'Ana, Co-Creator, Steward',
  'Ben, invited by Ana, Collaborator',
  'Cal, invited by Ana, Co-Creator',
];
const PROPOSAL = 'Later quiet hours on weekends';
const NEW_TEXT = 'Quiet hours start at 10pm, and at 11pm on Fridays and Saturdays.';

/** Joins from Join's form, at Join's preselected level unless `level` names another, then waits for Group home. */
async function join(person: Person, level?: string): Promise<void> {
  await expect(heading(person.page, GROUP)).toBeVisible();
  // The invite's seed has left the address bar, and the preview names the inviter.
  await expect(person.page).toHaveURL(/#\/join$/);
  await expect(person.page.getByText('From Ana’s invite')).toBeVisible();
  await expect(person.page.getByText(FIRST_ATOM)).toBeVisible();
  await expect(person.page.getByRole('radio', { name: 'Collaborator' })).toBeChecked();
  await expectAccessible(person, 'Join');
  await person.page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  if (level !== undefined) await pick(person.page, level);
  await person.page.getByRole('button', { name: 'Join group' }).click();
  await expect(person.page).toHaveURL(/#\/g\/[A-Za-z0-9_-]+$/);
}

/** Group home lists everyone; the Document view shows every section. */
async function expectGroupAndDocument(person: Person): Promise<void> {
  const { page } = person;
  await expect(heading(page, GROUP)).toBeVisible();
  const people = page.getByRole('region', { name: 'People' }).getByRole('listitem');
  // Each row in order; the steward's own rows also hold Suspend (#102).
  await expect(people).toHaveCount(PEOPLE.length);
  await expect(people).toContainText(PEOPLE);
  await expectAccessible(person, 'Group home');
  await page.getByRole('link', { name: TITLE }).click();
  await expect(heading(page, TITLE)).toBeVisible();
  await expect(page.getByRole('article').getByRole('paragraph')).toHaveText(ATOMS);
  await expectAccessible(person, 'Document view');
}

/** From the Document view, back to Group home, then into the Proposal waiting under Needs your vote. */
async function openProposal(person: Person): Promise<void> {
  const { page } = person;
  await page.getByRole('link', { name: GROUP }).click();
  const open = page.getByRole('region', { name: 'Needs your vote' });
  await open.getByRole('link', { name: PROPOSAL }).click();
  await expect(heading(page, PROPOSAL)).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
  // Nobody has scored yet, and the consent meter says so in words.
  await expect(page.getByRole('group', { name: 'How version 1 stands so far' })).toContainText(
    'No scores yet',
  );
  await expectAccessible(person, 'Proposal view');
}

/** The ballot's send status: Sending…, Saved on this device…, then Sent. */
function sendStatus(page: Page): Locator {
  return page.locator('.ballot-send').getByRole('status');
}

/** Picks a score pill and sends the ballot. */
async function score(person: Person, pill: string): Promise<void> {
  const { page } = person;
  await pick(page, pill);
  await page.getByRole('button', { name: 'Send your vote' }).click();
}

/**
 * Once the vote has closed: the result, which thanks Ana with no numbers and
 * then gives the totals, then Group home's Decided list and the Document with
 * the new section.
 */
async function expectUpdate(person: Person): Promise<void> {
  const { page } = person;
  const result = page.getByRole('region', { name: 'Result' });
  await expect(result.locator('.result-outcome').getByRole('paragraph')).toHaveText([
    'This passed. The Document now reads:',
    NEW_TEXT,
    'Thank you, Ana.',
  ]);
  await expect(result.getByRole('list', { name: 'Totals' })).toContainText(
    'Scored by 3 · average 3.3 · no zeros',
  );
  await expectAccessible(person, 'Result');
  await page.getByRole('link', { name: GROUP }).click();
  await expect(page.getByRole('region', { name: 'Open Proposals' })).toContainText(
    'Nothing to vote on yet.',
  );
  await expect(
    page.getByRole('region', { name: 'Decided' }).getByRole('link', { name: PROPOSAL }),
  ).toContainText('Passed');
  await page.getByRole('link', { name: TITLE }).click();
  await expect(page.getByRole('article').getByRole('paragraph')).toHaveText([
    NEW_TEXT,
    SECOND_ATOM,
  ]);
  await expectAccessible(person, 'Document view');
}

test('three members propose, vote and see the Update', async ({ openProfile }) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const cal = await openProfile('Cal', { colorScheme: 'dark' });
  let inviteLink = '';

  await test.step('A creates a group', async () => {
    const { page } = ana;
    await page.goto('/');
    await acceptNotice(ana);
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expectAccessible(ana, 'Start');
    await page.getByRole('link', { name: 'Create group' }).click();
    await expect(heading(page, 'Create a group')).toBeVisible();
    await expectAccessible(ana, 'Create group');
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Chat link (optional)' }).fill(CHAT);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Document text' }).fill(ATOMS.join('\n\n'));
    await page.getByRole('button', { name: 'Create group' }).click();

    // Group home appears once the genesis is back from the relay.
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(page.getByRole('region', { name: 'People' }).getByRole('listitem')).toHaveText([
      'Ana, Co-Creator, Steward',
    ]);
    await expect(
      page.getByText('Anyone who opens this link in the next 2 days can read everything'),
    ).toBeVisible();
    await expectAccessible(ana, 'Group home');
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const field = page.getByRole('textbox', { name: 'Invite link' });
    await expect(field).toHaveAttribute('readonly', '');
    inviteLink = await field.inputValue();
    // The link carries only the invite seed; the sealed envelope holds the group secret.
    expect(inviteLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#join\/[\w-]{43}$/);
    await expectAccessible(ana, 'Group home, invite link made');
  });

  await test.step('B joins from the link in A’s invite field, and C as a Co-Creator', async () => {
    // B opens the link itself.
    await ben.page.goto(inviteLink);
    await acceptNotice(ben);
    await join(ben);

    // C pastes it on Start, in the dark theme.
    await cal.page.goto('/');
    await acceptNotice(cal);
    await expect(heading(cal.page, 'Your groups')).toBeVisible();
    await expectAccessible(cal, 'Start');
    await cal.page.getByRole('textbox', { name: 'Invite link' }).fill(inviteLink);
    await cal.page.getByRole('button', { name: 'Join with an invite link' }).click();
    // C will open the composer, which only the creating level holds.
    await join(cal, 'Co-Creator');
  });

  await test.step('all three see the Document and everyone in the group', async () => {
    for (const person of [ana, ben, cal]) await expectGroupAndDocument(person);
  });

  await test.step('C checks the composer in the dark theme, typing nothing', async () => {
    const { page } = cal;
    await page.getByRole('button', { name: 'Propose a change to section 2' }).click();
    await expect(heading(page, 'Propose a change')).toBeVisible();
    await expectAccessible(cal, 'Composer');
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Preview' })).toHaveText(SECOND_ATOM);
    await expectAccessible(cal, 'Composer preview');
    await page.goBack();
    await expect(heading(page, TITLE)).toBeVisible();
  });

  await test.step('A proposes a change to the first section', async () => {
    const { page } = ana;
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await expect(heading(page, 'Propose a change')).toBeVisible();
    // Each founding section was normalized as Atom text before signing, so it ends in one LF.
    await expect(page.getByRole('textbox', { name: 'New text' })).toHaveValue(`${FIRST_ATOM}\n`);
    // With no Proposal yet, the discussion link starts as the group's chat link.
    await expect(page.getByRole('textbox', { name: 'Discussion link (optional)' })).toHaveValue(
      CHAT,
    );
    await expectAccessible(ana, 'Composer');
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Preview' })).toHaveText(FIRST_ATOM);
    await expectAccessible(ana, 'Composer preview');
    await page.getByRole('tab', { name: 'Write' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page
      .getByRole('textbox', { name: 'Why' })
      .fill('Friday and Saturday evenings run later for most of us.');
    await page.getByRole('textbox', { name: 'New text' }).fill(NEW_TEXT);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page).toHaveURL(/#\/g\/[\w-]+\/p\/[\w-]+$/);
    // The ballot appears once the relay has ordered the Proposal.
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    await expectAccessible(ana, 'Proposal view');

    await openProposal(ben);
    await openProposal(cal);
  });

  await test.step('C goes offline, scores, and sees its ballot saved on this device', async () => {
    await cal.page.context().setOffline(true);
    await score(cal, '3 · Supportive');
    await expect(sendStatus(cal.page)).toHaveText(
      'Saved on this device. It will send when you’re back online.',
    );
    await expectAccessible(cal, 'ballot, saved offline');
  });

  await test.step('A and B score', async () => {
    await score(ana, '4 · Strongly supportive');
    await score(ben, '3 · Supportive');
    for (const person of [ana, ben]) await expect(sendStatus(person.page)).toHaveText('Sent');
    await expectAccessible(ben, 'ballot, sent');
  });

  await test.step('C comes back online and its ballot sends', async () => {
    // Coming back online syncs at once, whatever the backoff (spec §7, #168).
    await cal.page.context().setOffline(false);
    await expect(sendStatus(cal.page)).toHaveText('Sent');
  });

  await test.step('the vote closes early, and all three show the new section', async () => {
    for (const person of [ana, ben, cal]) await expectUpdate(person);
  });
});
