/**
 * Removal by vote (#115), end to end through the real relay and the deploy
 * CSP.
 *
 * Ana founds a group on a desktop, and Ben, on a 390 px phone in the dark
 * theme, and Cal join it: the bootstrap's three. The test reads Cal's group
 * secret from IndexedDB, as anything left on his device or in a backup would
 * hold it. Ana proposes removing Cal from the People list (axe on the
 * composer). Cal reads that he can't vote on it and posts his one response
 * (axe on the ballot with the form), which Ana and Ben read under "Cal’s
 * response" (axe on the ballot with it). Ana and Ben score it 4, which closes
 * it early; a device posts the remove, and the first remaining device to see
 * it writes a new key, wrapped to Ana and Ben. Cal's profile shows the
 * removed line, saying plainly that he keeps what he had (axe on it), and his
 * device keeps the group read-only and never names its mailboxes again.
 *
 * Ana then proposes with a canary title, and Ben finds it. The test opens
 * every blob the relay holds, in any mailbox, with keys derived from Cal's
 * secret: none holds the canary, while the Proposal opens under the group's
 * new secret, so the check can't pass by opening nothing. Nor does Cal's own
 * device hold it. Last, the relay stops and its files are scanned for either
 * secret, every device's encryption key and the response's canary.
 *
 * Making `remove` end no membership (fold.ts's `endsMembership`) makes this
 * spec fail: no key change becomes due, so Ana and Ben stay on Cal's key.
 */
import { DatabaseSync } from 'node:sqlite';

import { open } from '../src/crypto/seal';
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
import { type Canary, describeFinding, keyCanaries, scan, textCanary } from './support/scan';
import { derive, groupMailboxes, onlyGroup, storedLogs } from './support/stored';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const REMOVED =
  /^You were removed from this group by a vote on .+\. You keep what’s already on this device, but you won’t see anything new\.$/;

/** Opens `link` on `person`'s new profile, accepts the notice, and joins as them. */
async function joinFrom(person: Person, link: string): Promise<void> {
  const { page } = person;
  await page.goto(link);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText(
    person.name,
  );
}

/** The epoch of the key `person`'s device holds for its one group. */
async function epochOn(person: Person): Promise<number> {
  return (await onlyGroup(person.page)).epoch;
}

/** Every blob the relay holds, in any mailbox, with its mailbox id. */
function relayBlobs(file: string): { mailbox: string; blob: Uint8Array }[] {
  const db = new DatabaseSync(file, { timeout: 10_000 });
  try {
    return db
      .prepare('SELECT mailbox, blob FROM blobs ORDER BY seq')
      .all()
      .map((row) => ({
        mailbox: String(row.mailbox),
        blob: Uint8Array.from(row.blob as Uint8Array),
      }));
  } finally {
    db.close();
  }
}

/** Each blob that opens under the seal key `secret` derives, opened, wherever the relay keeps it. */
function openedWith(file: string, secret: Uint8Array): Buffer[] {
  const key = derive(secret, 'reconcile/v1/seal-key');
  return relayBlobs(file).flatMap(({ mailbox, blob }) => {
    const plaintext = open(mailbox, key, blob);
    return plaintext === null ? [] : [Buffer.from(plaintext)];
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

/** Scores the open removal 4 and sends it. */
async function vote(person: Person): Promise<void> {
  const { page } = person;
  await pick(page, '4 · Strongly supportive', page.getByRole('radiogroup', { name: 'Your score' }));
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

test('Ana and Ben remove Cal: his device keeps what it had, and nothing after opens with his key', async ({
  openProfile,
  relay,
}) => {
  const canary = `CANARY-AFTER-REMOVAL-${String(Date.now())}`;
  const response = `CANARY-RESPONSE-${String(Date.now())} I wasn’t there that night.`;
  const ana = await openProfile('Ana', { viewport: DESKTOP });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile('Cal', { viewport: DESKTOP });
  const calsRequests = captureRequests(cal);
  let ballot = '';

  await test.step('Ana founds the group, and Ben and Cal join it', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const link = await foundGroup(ana.page, {
      name: GROUP,
      title: TITLE,
      atoms: ['Quiet hours start at 10pm.', 'Bins go out on Tuesday.'],
      founder: ana.name,
    });
    for (const person of [ben, cal]) await joinFrom(person, link);
    await expect(ana.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Cal',
    );
  });

  // What Cal's device holds, as a copy kept anywhere else would: a backup, or another device.
  const calsGroup = await onlyGroup(cal.page);
  const calsSecret = Uint8Array.from(calsGroup.secret);
  const [anaBefore, benBefore] = [await onlyGroup(ana.page), await onlyGroup(ben.page)];
  expect(anaBefore.secret).toEqual(calsGroup.secret);

  await test.step('Ana proposes removing Cal from the People list', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: 'Propose removing Cal' }).click();
    await expect(heading(page, 'Propose a removal')).toBeVisible();
    await expect(
      page.getByText(
        'This needs a higher bar: an average of at least 3.0, and no more than one 0 unless fewer than 5% scored 0. Cal can’t vote on it, but can post one response.',
      ),
    ).toBeVisible();
    await expectAccessible(ana, 'Removal composer');
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Remove Cal');
    await page.getByRole('textbox', { name: 'Why' }).fill('Threats in the group chat, twice.');
    await page.getByRole('button', { name: 'Propose this removal' }).click();
    await expect(page.getByRole('region', { name: 'Remove Cal from the group' })).toBeVisible();
    ballot = page.url();
  });

  await test.step('Cal can’t vote on it, and posts his one response', async () => {
    const { page } = cal;
    await visit(page, ballot);
    await expect(page.getByText(/This Proposal would remove you/)).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Your score' })).toHaveCount(0);
    await expectAccessible(cal, 'Removal ballot with the response form');
    await page.getByRole('textbox', { name: 'Your response' }).fill(response);
    await page.getByRole('button', { name: 'Post your response' }).click();
    const posted = page.getByRole('region', { name: 'Cal’s response' });
    await expect(posted).toContainText(response);
    await expect(page.getByRole('textbox', { name: 'Your response' })).toHaveCount(0);
  });

  await test.step('Ana and Ben read the response and score it 4, which closes it early', async () => {
    for (const person of [ana, ben]) {
      const { page } = person;
      await visit(page, ballot);
      await expect(page.getByRole('region', { name: 'Cal’s response' })).toContainText(response);
      await expectAccessible(person, 'Removal ballot with the response');
      await vote(person);
    }
    for (const person of [ana, ben]) {
      await expect(
        person.page.getByText('This passed. Cal is no longer in this group.'),
      ).toBeVisible();
    }
  });

  await test.step('Cal’s profile shows the removed line, and keeps the group read-only', async () => {
    const { page } = cal;
    await page.getByRole('link', { name: GROUP }).click();
    await expect(page.getByText(REMOVED)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove from this device' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'People', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Invite people' })).toHaveCount(0);
    await expectAccessible(cal, 'Removed');
    await expect.poll(async () => (await onlyGroup(page)).archived).toBe('removed');
  });

  await test.step('Ana’s and Ben’s devices take up one new key, which Cal’s secret isn’t', async () => {
    await expect.poll(() => epochOn(ana)).toBe(1);
    await expect.poll(() => epochOn(ben)).toBe(1);
    const [anaAfter, benAfter] = [await onlyGroup(ana.page), await onlyGroup(ben.page)];
    expect(anaAfter.secret).toEqual(benAfter.secret);
    expect(anaAfter.secret).not.toEqual(calsGroup.secret);
    expect(await epochOn(cal)).toBe(0);
    await ana.page.getByRole('link', { name: GROUP }).click();
    await expect(
      ana.page.getByRole('region', { name: 'People', exact: true }).getByRole('listitem'),
    ).toHaveCount(2);
  });

  const mark = calsRequests.length;

  await test.step('Ana proposes with a canary title, and Ben finds it under Needs your vote', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(canary);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await ben.page.getByRole('link', { name: GROUP }).click();
    const needs = ben.page.getByRole('region', { name: 'Needs your vote' });
    await expect(needs.getByRole('link', { name: new RegExp(canary) })).toBeVisible();
  });

  await test.step('no blob the relay holds opens under Cal’s keys to the canary; the new key’s do', async () => {
    const underCal = openedWith(relay.db, calsSecret);
    // Cal's keys still open what was sealed before the key changed, so the check reads real blobs.
    expect(underCal.length).toBeGreaterThan(0);
    expect(underCal.filter((plaintext) => plaintext.includes(canary))).toEqual([]);
    const newSecret = Uint8Array.from((await onlyGroup(ana.page)).secret);
    const underNew = openedWith(relay.db, newSecret);
    expect(underNew.filter((plaintext) => plaintext.includes(canary))).toHaveLength(1);
    // Nor does anything Cal's device keeps hold it.
    const calsLogs = JSON.stringify(await storedLogs(cal.page));
    expect(calsLogs).not.toContain(Buffer.from(canary).toString('hex'));
  });

  await test.step('Cal’s device names the group’s mailboxes no more', async () => {
    // Its weekly mailboxes (#110), whichever week this run fell in.
    const mailboxes = groupMailboxes(calsSecret);
    const names = (url: string) => mailboxes.some((mailbox) => url.includes(mailbox));
    // The control: his device did name one while he was in the group.
    expect(calsRequests.slice(0, mark).some(names)).toBe(true);
    await cal.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await cal.page.waitForTimeout(7_000);
    await cal.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(calsRequests.slice(mark).filter(names)).toEqual([]);
  });

  await test.step('the relay stops, and holds neither secret, any encryption key, nor the response', async () => {
    const newSecret = Uint8Array.from((await onlyGroup(ana.page)).secret);
    for (const { page } of [ana, ben, cal]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const kxKeys = [anaBefore, benBefore, calsGroup].map((held, i) => {
      expect(held.kxKey).toHaveLength(32);
      return keyCanaries(
        `device ${String(i + 1)}’s encryption key`,
        Uint8Array.from(held.kxKey ?? []),
      );
    });
    const canaries: Canary[] = [
      textCanary('the canary title', canary),
      textCanary('Cal’s response', response.split(' ')[0] ?? response),
      ...keyCanaries('Cal’s group secret', calsSecret),
      ...keyCanaries('the new group secret', newSecret),
      ...kxKeys.flat(),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
  });
});
