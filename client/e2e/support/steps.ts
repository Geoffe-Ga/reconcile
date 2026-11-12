/**
 * The steps most specs take (#127): a fresh profile's first run, found a
 * group from one, join one from its invite link at a level, open a vote from
 * Needs your vote, and score it. A spec about something else takes these
 * rather than its own copy.
 */
import type { Locator, Page } from '@playwright/test';

import {
  acceptNotice,
  createGroup,
  expect,
  heading,
  type NewGroup,
  type Person,
  pick,
  visit,
} from './fixtures';

/**
 * How long a step waits for what another device sent: a pass every 3 seconds
 * on each side (spec §7), a little more under a busy machine.
 */
export const SYNC_MS = 45_000;

/** A fresh profile's first run: Start, through the pilot notice, with nothing on the device yet. */
export async function firstRun(person: Person): Promise<void> {
  const { page } = person;
  await visit(page, '/');
  await acceptNotice(person);
  await expect(heading(page, 'Your groups')).toBeVisible();
}

/** From a fresh profile's first run, founds `group`, and returns its Group home's URL. */
export async function found(person: Person, group: NewGroup): Promise<string> {
  const { page } = person;
  await visit(page, '/#/create');
  await acceptNotice(person);
  await createGroup(page, group);
  return page.url();
}

/**
 * `person` opens the invite `link` to `group` and joins under their own
 * name, at Join's preselected Collaborator unless `level` names another, and
 * the URL of the Group home it lands on is returned. A profile that has never
 * opened the app meets the pilot notice first.
 */
export async function join(
  person: Person,
  link: string,
  group: string,
  level?: string,
): Promise<string> {
  const { page } = person;
  const fresh = page.url() === 'about:blank';
  await visit(page, link);
  if (fresh) await acceptNotice(person);
  await expect(heading(page, group)).toBeVisible();
  // The invite's seed has left the address bar.
  await expect(page).toHaveURL(/#\/join$/);
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  if (level !== undefined) await pick(page, level);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page).toHaveURL(/#\/g\/[\w-]+$/);
  await expect(heading(page, group)).toBeVisible();
  return page.url();
}

/** Group home's People list. */
export function people(page: Page): Locator {
  return page.getByRole('region', { name: 'People', exact: true });
}

/**
 * From the Group home at `home`, opens the vote titled `title` once it shows
 * under Needs your vote, with `tag` above its title when given, such as a
 * coalition vote's (#120).
 */
export async function openVote(
  person: Person,
  home: string,
  title: string,
  tag?: string,
): Promise<void> {
  const { page } = person;
  await visit(page, home);
  const card = page.getByRole('region', { name: 'Needs your vote' }).getByRole('link', {
    name: title,
  });
  await expect(card).toBeVisible({ timeout: SYNC_MS });
  if (tag !== undefined) await expect(card).toContainText(tag);
  await card.click();
  await expect(heading(page, title)).toBeVisible();
}

/** The note field's label for a ballot whose score is the pill's first character (spec §8). */
function noteLabel(pill: string): string {
  if (pill.startsWith('0')) return 'Your reason for a 0';
  if (pill.startsWith('1')) return 'What would make this a 3 for you?';
  return 'Note (optional)';
}

/**
 * Scores the open vote with the pill `pill`, such as '4 · Strongly
 * supportive', writes `note` when given (a 0 needs one, as its reason), and
 * sends the ballot.
 */
export async function vote(person: Person, pill: string, note?: string): Promise<void> {
  const { page } = person;
  await pick(page, pill);
  if (note !== undefined) await page.getByRole('textbox', { name: noteLabel(pill) }).fill(note);
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}
