/**
 * The steps most specs take (#127): a fresh profile's first run, found a
 * group from one, join one from its invite link at a level, open a vote from
 * Needs your vote, and score it; and the public shelf's (#434): list a door,
 * put a Dispatch to the shelf line's vote, and import the steward's key and
 * release a listing. A spec about something else takes these rather than its
 * own copy.
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

/** Group rules' front door card. */
function doorCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Front door' });
}

/**
 * From the Group home at `home`, `person` proposes opening a front door that
 * is also listed on the public shelf (#485; ADR-0081) and passes it as the
 * group's one voter. `onComposer` runs on the listing composer once its
 * covenant shows, for axe. Returns the door's link from Group rules, whose
 * hash names the door's address, which the listing goes up under.
 */
export async function listDoor(
  person: Person,
  home: string,
  onComposer?: () => Promise<void>,
): Promise<string> {
  const { page } = person;
  await visit(page, home);
  await page.getByRole('link', { name: /Chat bot and front door/ }).click();
  const rules = page.url();
  await doorCard(page)
    .getByRole('link', { name: 'Propose turning this on for the front door' })
    .click();
  await expect(heading(page, 'Open a front door')).toBeVisible();
  const list = page.getByRole('checkbox', { name: 'Also list it on the public shelf' });
  // A group is never prompted toward listing (#485): the choice starts unticked.
  await expect(list).not.toBeChecked();
  await page.getByText('Also list it on the public shelf').click();
  await expect(list).toBeChecked();
  await expect(page.getByRole('region', { name: /The covenant/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Why' }).fill('We want neighbours to find us.');
  if (onComposer !== undefined) await onComposer();
  await page.getByRole('button', { name: 'Propose this change' }).click();
  await vote(person, '4 · Strongly supportive');
  await expect(
    page.getByText('This passed. Your group’s front door is open and listed on the public shelf.'),
  ).toBeVisible({ timeout: SYNC_MS });
  await visit(page, rules);
  const field = doorCard(page).getByRole('textbox', { name: 'Front door link' });
  await expect(field).toHaveValue(/\/#door\/[\w-]{43}$/, { timeout: SYNC_MS });
  return field.inputValue();
}

/** A Dispatch's words. */
export interface DispatchWords {
  readonly title: string;
  readonly text: string;
}

/**
 * From the Group home at `home` of a group whose door is listed, `person`
 * sends a Dispatch that asks for the public shelf (#430), which puts it to
 * the group's vote with a second line, and lands on its two-line ballot.
 */
export async function proposeForShelf(
  person: Person,
  home: string,
  words: DispatchWords,
): Promise<void> {
  const { page } = person;
  await visit(page, home);
  await page
    .getByRole('region', { name: 'Dispatches', exact: true })
    .getByRole('link', { name: 'Send a Dispatch' })
    .click();
  await expect(heading(page, 'Send a Dispatch')).toBeVisible();
  const shelf = page.getByRole('checkbox', { name: 'Also ask to put it on the public shelf' });
  await expect(shelf).toBeVisible({ timeout: SYNC_MS });
  await page.getByRole('textbox', { name: 'Title' }).fill(words.title);
  await page.getByRole('textbox', { name: 'Text (optional)' }).fill(words.text);
  await page.getByText('Also ask to put it on the public shelf').click();
  await expect(shelf).toBeChecked();
  await page.getByRole('button', { name: 'Put it to a vote' }).click();
  await expect(heading(page, words.title)).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Score for the public shelf' })).toBeVisible();
}

/**
 * Scores the open two-line ballot (#430): `dispatch` for sending it and
 * `shelf` for the shelf line, such as '4 · Strongly supportive', with
 * `reason` as the reason a 0 needs, and sends it.
 */
export async function voteTwoLines(
  person: Person,
  dispatch: string,
  shelf: string,
  reason?: string,
): Promise<void> {
  const { page } = person;
  await pick(page, dispatch, page.getByRole('radiogroup', { name: 'Score for sending it' }));
  await pick(page, shelf, page.getByRole('radiogroup', { name: 'Score for the public shelf' }));
  if (reason !== undefined) {
    await page.getByRole('textbox', { name: 'Your reason for a 0' }).fill(reason);
  }
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/**
 * On Settings › Steward key (#488), `person`, past first run, imports the
 * steward's `secret`, as `scripts/steward_key.py` prints it, and this device
 * holds the steward's key.
 */
export async function importStewardKey(person: Person, secret: string): Promise<void> {
  const { page } = person;
  await visit(page, '/#/settings');
  const section = page.getByRole('region', { name: 'Steward key' });
  await section.getByLabel('Steward secret').fill(secret);
  await section.getByRole('button', { name: 'Import' }).click();
  await expect(section.getByText('This device holds the steward key.')).toBeVisible();
}

/** On the steward's console (#488), releases the waiting listing named `name`. */
export async function release(steward: Person, name: string): Promise<void> {
  const { page } = steward;
  await visit(page, '/#/steward');
  await expect(heading(page, 'Steward’s console')).toBeVisible();
  const waiting = page
    .getByRole('region', { name: 'Waiting for release' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await waiting.getByRole('button', { name: 'Release' }).click();
  await expect(
    waiting.getByText('Released. Devices show it at their next read of the shelf.'),
  ).toBeVisible();
}
