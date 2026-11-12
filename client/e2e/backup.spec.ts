/**
 * Back up and restore (#78), end to end through the real relay and the
 * deploy CSP.
 *
 * Ana founds a group with a canary in every field, Ben joins, and Ana
 * proposes. Ana saves a backup from Settings through the download path. The
 * file holds no canary in any spelling: not the group's name, either
 * person's name, the Atom text or the Proposal's title, and not Ana's
 * signing key or the group secret as raw bytes, hex or base64. Two fresh
 * profiles, a phone in the dark theme and a laptop, restore the file through
 * the file input, after a wrong passphrase that writes nothing, and each
 * holds Ana's log for the group, so each folds what Ana's device folds. Both
 * vote on the Proposal, the phone first, and Ben's tally counts one voter,
 * with the laptop's later ballot. axe checks Settings and Start at each step.
 */
import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  pick,
  type Person,
  test,
} from './support/fixtures';
import { describeFinding, findIn, keyCanaries, textCanary } from './support/scan';
import { onlyGroup, storedLogs } from './support/stored';

const CANARY = {
  group: 'Canary Street Commons',
  founder: 'Canaryana Founder',
  joiner: 'Canarybenedict Joiner',
  atom: 'Canary atom: the garden opens at dawn.',
  title: 'Canary title: open the garden',
};
const PASSPHRASE = 'a long walk to the river, then bread';
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };

/** Says the share sheet takes no files, so the app downloads the backup, as Android Chrome's does. */
function noFileSharing(): void {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
}

/** From Start or any screen, Settings by its link on Start. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(heading(page, 'Settings')).toBeVisible();
}

/** Ana saves a backup from Settings and returns the downloaded file's path. */
async function saveBackup(ana: Person): Promise<string> {
  const { page } = ana;
  await openSettings(page);
  const section = page.getByRole('region', { name: 'Back up your groups' });
  await section.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await section.getByLabel('Passphrase again').fill(PASSPHRASE);
  await expectAccessible(ana, 'Settings, before saving');
  await section.getByRole('button', { name: 'Make a backup file' }).click();
  const save = section.getByRole('button', { name: 'Save the file' });
  await expect(save).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  expect(download.suggestedFilename()).toMatch(/^reconcile-backup-\d{4}-\d{2}-\d{2}\.bin$/);
  await expect(
    section.getByText('Saved. Keep the file and the passphrase in different places.'),
  ).toBeVisible();
  await expectAccessible(ana, 'Settings, saved');
  return download.path();
}

/** A fresh profile restores the file from Start, first under a wrong passphrase. */
async function restore(person: Person, file: string): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await acceptNotice(person);
  const section = page.getByRole('region', { name: 'Have a backup file?' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    section.getByRole('button', { name: 'Choose backup file' }).click(),
  ]);
  await chooser.setFiles(file);
  const passphrase = section.getByLabel('Its passphrase');
  await passphrase.fill('not the passphrase');
  await section.getByRole('button', { name: 'Restore' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'That passphrase doesn’t open this backup, or the file is damaged.',
  );
  expect(await storedLogs(page)).toEqual([]);
  await passphrase.fill(PASSPHRASE);
  await section.getByRole('button', { name: 'Restore' }).click();
  await expect(section.getByText('1 group is back on this device.')).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(CANARY.group) })).toBeVisible();
  await expectAccessible(person, 'Start, restored');
}

/** `person` scores the Proposal `pill` from the list `list` on Group home, and waits for Sent. */
async function vote(person: Person, pill: string, list: string): Promise<void> {
  const { page } = person;
  await page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
  const listed = page.getByRole('region', { name: list, exact: true });
  await listed.getByRole('link', { name: new RegExp(CANARY.title) }).click();
  await pick(page, pill);
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
}

test('a backup restores on two fresh devices, holds nothing readable, and votes as one person', async ({
  openProfile,
}) => {
  const ana = await openProfile(CANARY.founder, { viewport: LAPTOP });
  await ana.page.context().addInitScript(noFileSharing);
  const ben = await openProfile(CANARY.joiner, { viewport: LAPTOP });

  await test.step('Ana founds the group, Ben joins, and Ana proposes', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: CANARY.group,
      title: 'Our garden',
      atoms: [CANARY.atom, 'Bins go out on Tuesday.'],
      founder: CANARY.founder,
    });
    await ben.page.goto(invite);
    await acceptNotice(ben);
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(CANARY.joiner);
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(heading(ben.page, CANARY.group)).toBeVisible();
    const people = ana.page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText(CANARY.joiner);
    await expect(
      ana.page.getByText('Save a backup so you can get this group back if you lose your phone.'),
    ).toBeVisible();
    await ana.page.getByRole('link', { name: 'Our garden', exact: true }).click();
    await ana.page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await ana.page.getByRole('textbox', { name: 'Title' }).fill(CANARY.title);
    await ana.page.getByRole('textbox', { name: 'Why' }).fill('Mornings are cooler.');
    await ana.page.getByRole('textbox', { name: 'New text' }).fill('The garden opens at six.');
    await ana.page.getByRole('button', { name: 'Propose this change' }).click();
    // The ballot appears once the relay has ordered the Proposal (#113 replaced the
    // "Sent" line after proposing with Tell your group).
    await expect(ana.page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
  });

  const file = await test.step('Ana saves a backup through the download path', () =>
    saveBackup(ana));

  await test.step('the file holds no name, text, key or secret in any spelling', async () => {
    const held = await onlyGroup(ana.page);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RCB1');
    const canaries = [
      textCanary('group name', CANARY.group),
      textCanary('founder’s name', CANARY.founder),
      textCanary('joiner’s name', CANARY.joiner),
      textCanary('Atom text', CANARY.atom),
      textCanary('Proposal title', CANARY.title),
      ...keyCanaries('Ana’s signing key', Uint8Array.from(held.signingKey)),
      ...keyCanaries('group secret', Uint8Array.from(held.secret)),
      ...keyCanaries('Ana’s encryption key (#98)', Uint8Array.from(held.kxKey ?? [])),
    ];
    expect(held.kxKey).toHaveLength(32);
    expect(findIn(bytes, 'backup file', canaries).map(describeFinding)).toEqual([]);
  });

  await test.step('Ana’s group home stops suggesting a backup', async () => {
    await ana.page.getByRole('link', { name: 'Your groups' }).click();
    await ana.page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
    await expect(heading(ana.page, CANARY.group)).toBeVisible();
    await expect(ana.page.getByText(/Save a backup so you can/)).toBeHidden();
  });

  const phone = await openProfile('Ana’s phone', { viewport: PHONE, colorScheme: 'dark' });
  const laptop = await openProfile('Ana’s laptop', { viewport: LAPTOP });

  await test.step('two fresh devices restore it, and each holds Ana’s log', async () => {
    await restore(phone, file);
    await restore(laptop, file);
    const original = await storedLogs(ana.page);
    for (const device of [phone, laptop]) {
      expect(await storedLogs(device.page)).toEqual(original);
    }
  });

  await test.step('both vote, and the tally counts one voter with the later ballot', async () => {
    await vote(phone, '1 · Opposed', 'Needs your vote');
    // The laptop is the same person, so once it syncs the phone's ballot, nothing needs its vote.
    await vote(laptop, '4 · Strongly supportive', 'Open Proposals');
    const { page } = ben;
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(CANARY.title) })
      .click();
    const meter = page.getByRole('group', { name: 'How version 1 stands so far' });
    // One voter, Ana, whose later ballot (4) replaced the phone's 1.
    await expect(meter).toContainText('Scored by 1 · needs 2');
    await expect(meter).toContainText('4.0 · Passes');
  });
});
