/**
 * Dissolving a group (#108), end to end through the real relay and the
 * deploy CSP.
 *
 * Ana founds a group, and Ben, on a 390 px phone in the dark theme, and Cy
 * join. Ana proposes dissolving it from the bottom of Group home, with
 * "Also erase it from every device" left off, and all three score the ballot
 * 4. The vote closes early, a device posts the `dissolve`, and every profile
 * shows the archive's note and the same Document, read-only. From then on no
 * request from any profile names the group's mailbox: the requests are
 * captured, and the weekly mailbox ids are derived from the group secret as
 * spec §3 says (#110). axe checks the composer and the archive; the fixture fails the test
 * on any CSP violation. Nothing moves time.
 */
import type { Page } from '@playwright/test';

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
import { groupMailboxes } from './support/stored';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const ATOMS = ['Quiet hours start at 10pm.', 'Bins go out on Tuesday.'];
const ARCHIVED = /^This group dissolved on .+\. This is a read-only copy\.$/;
const PHONE = { width: 390, height: 844 };

/** The group secret of the one group in the app's IndexedDB on `page`, read with no hook into the app. */
function storedSecret(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const ask = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const db = await ask(indexedDB.open('reconcile'));
    try {
      const groups = (await ask(db.transaction('groups').objectStore('groups').getAll())) as {
        secret: Uint8Array;
      }[];
      return Array.from(groups[0]?.secret ?? []);
    } finally {
      db.close();
    }
  });
}

/** Every URL a profile's page requests, in order, from now on. */
function captureRequests(person: Person): string[] {
  const urls: string[] = [];
  person.page.on('request', (request) => {
    urls.push(request.url());
  });
  return urls;
}

/** `person` joins from `invite` under their own name. */
async function join(person: Person, invite: string): Promise<void> {
  const { page } = person;
  await page.goto(invite);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText(
    person.name,
  );
}

/** Scores the open dissolve ballot 4 and sends it. */
async function vote(person: Person): Promise<void> {
  const { page } = person;
  await pick(page, '4 · Strongly supportive', page.getByRole('radiogroup', { name: 'Your score' }));
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** The Document's sections as a profile reads them, from its Document view. */
async function documentText(page: Page): Promise<string[]> {
  await page.getByRole('link', { name: TITLE }).click();
  await expect(heading(page, TITLE)).toBeVisible();
  await expect(page.getByRole('button', { name: /Propose a change/ })).toHaveCount(0);
  return page.locator('article.document .atom').allInnerTexts();
}

test('three members dissolve their group, and every device keeps the same read-only copy', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cy = await openProfile('Cy');
  const everyone = [ana, ben, cy];
  const requests = new Map(everyone.map((person) => [person, captureRequests(person)]));
  let ballot = '';

  await test.step('Ana founds the group, and Ben and Cy join', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: TITLE,
      atoms: ATOMS,
      founder: 'Ana',
    });
    await join(ben, invite);
    await join(cy, invite);
  });

  await test.step('Ana proposes dissolving it from the bottom of Group home, wipe off', async () => {
    const { page } = ana;
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Cy');
    await page.getByRole('link', { name: 'Propose dissolving the group' }).click();
    await expect(heading(page, 'Propose dissolving the group')).toBeVisible();
    const wipe = page.getByRole('checkbox', { name: 'Also erase it from every device' });
    await expect(wipe).not.toBeChecked();
    await expect(page.getByText(/No app can stop someone who already kept a copy/)).toBeVisible();
    await expectAccessible(ana, 'Dissolve composer');
    await page.getByRole('textbox', { name: 'Title' }).fill('Dissolve Riverside Tenants');
    await page.getByRole('textbox', { name: 'Why' }).fill('We have all moved out of the building.');
    await page.getByRole('button', { name: 'Propose dissolving' }).click();
    await expect(page.getByRole('region', { name: 'Dissolve the group' })).toContainText(
      'Every device keeps a read-only copy.',
    );
    ballot = page.url();
  });

  await test.step('all three score it 4, and the vote closes early', async () => {
    await vote(ana);
    for (const person of [ben, cy]) {
      await person.page.goto(ballot);
      await vote(person);
    }
  });

  await test.step('every profile shows the archive, and the same Document, read-only', async () => {
    const documents: string[][] = [];
    for (const person of everyone) {
      const { page } = person;
      await page.goto(ballot);
      await expect(page.getByText('This passed. Your group has dissolved.')).toBeVisible();
      await page.getByRole('link', { name: GROUP }).click();
      await expect(page.getByText(ARCHIVED)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove from this device' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Invite people' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Leave this group' })).toHaveCount(0);
      await expectAccessible(person, 'Archive');
      documents.push(await documentText(page));
    }
    expect(documents).toEqual([ATOMS, ATOMS, ATOMS]);
  });

  await test.step('no profile’s request names the group’s mailbox again', async () => {
    // Its weekly mailboxes (#110), whichever weeks this run fell in.
    const mailboxes = groupMailboxes(Uint8Array.from(await storedSecret(ana.page)));
    const names = (url: string) => mailboxes.some((mailbox) => url.includes(mailbox));
    const sent = everyone.map((person) => requests.get(person) ?? []);
    // The control: each profile did name it while the group went on.
    for (const urls of sent) expect(urls.some(names)).toBe(true);
    const marks = sent.map((urls) => urls.length);
    // Focus runs a sync pass at once, and a poll follows every 3 seconds; give it several.
    for (const { page } of everyone) {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    await ana.page.waitForTimeout(7_000);
    for (const { page } of everyone) {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    const later = sent.map((urls, i) => urls.slice(marks[i]).filter(names));
    expect(later).toEqual([[], [], []]);
  });
});
