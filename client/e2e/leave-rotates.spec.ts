/**
 * A new group key when someone leaves (#98), end to end through the real
 * relay and the deploy CSP.
 *
 * Ana founds a group on a desktop, and Ben, on a 390 px phone in the dark
 * theme, and Cal join it. Cal copies an invite link of his own, and the test
 * reads his group secret from IndexedDB, as anything left on his device or in
 * a backup would hold it. Then Cal leaves. The first remaining device to see
 * the leave writes a new key, wrapped to Ana and Ben, and both move to the new
 * mailbox. Ana proposes, with a canary title, and Ben finds it under Needs
 * your vote. The test then opens every blob the relay holds, in any mailbox,
 * with keys derived from Cal's secret: none holds the canary, while the
 * Proposal does open under the group's new secret, so the check can't pass by
 * opening nothing. Cal's earlier link still opens, but whoever joins from it
 * reads that the key changed and gets nothing new; axe checks that screen.
 * Last, the relay stops and its database, WAL, shared memory and log are
 * scanned for either secret and every device's encryption key, in every
 * encoding (`support/scan.ts`).
 *
 * Turning off the duty (sync.ts's `rotateIfDue`) makes this spec fail: no
 * device writes the new key, so Ana and Ben stay on Cal's (recorded in #98's PR).
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
  test,
} from './support/fixtures';
import { type Canary, describeFinding, keyCanaries, scan, textCanary } from './support/scan';
import { derive, groupMailboxes, onlyGroup } from './support/stored';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** What a device reads once the group's key changed and it didn't get the new one. */
const MISSED =
  'This group’s key changed and this device didn’t get the new one. Ask someone in the group for a new invite link.';

/** Opens `link` on `person`'s profile, accepting the notice first when `fresh`, and joins as them. */
async function joinFrom(person: Person, link: string, fresh = true): Promise<void> {
  const { page } = person;
  await page.goto(link);
  if (fresh) await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
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

test('when Cal leaves, the group gets a new key: nothing after it opens with his, and his old link says why', async ({
  openProfile,
  relay,
}) => {
  const canary = `CANARY-AFTER-LEAVE-${String(Date.now())}`;
  const ana = await openProfile('Ana', { viewport: DESKTOP });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile('Cal', { viewport: DESKTOP });
  let calsLink = '';

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
    const people = ana.page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText('Ben');
    await expect(people).toContainText('Cal');
    await expect(cal.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ben',
    );
  });

  await test.step('Cal copies an invite link of his own', async () => {
    await cal.page.getByRole('button', { name: 'Copy invite link' }).click();
    calsLink = await cal.page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    expect(calsLink).toMatch(/#join\/[A-Za-z0-9_-]{43}$/);
  });

  // What Cal's device holds, as a copy kept anywhere else would: a backup, or another device.
  const calsGroup = await onlyGroup(cal.page);
  const calsSecret = Uint8Array.from(calsGroup.secret);
  expect(calsGroup.epoch).toBe(0);
  const [anaBefore, benBefore] = [await onlyGroup(ana.page), await onlyGroup(ben.page)];
  expect(anaBefore.secret).toEqual(calsGroup.secret);

  await test.step('Cal leaves, and the group goes from his device', async () => {
    const { page } = cal;
    await page.getByRole('button', { name: 'Leave this group' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Leave this group?' });
    await expect(dialog).toContainText(
      'When you leave, the group gets a new key, so this device and any backup can’t read what comes next.',
    );
    await expectAccessible(cal, 'Leave dialog');
    await dialog.getByRole('button', { name: 'Leave this group' }).click();
    await expect(page.getByText('You aren’t in any groups on this device yet.')).toBeVisible();
  });

  await test.step('Ana’s and Ben’s devices take up one new key, which Cal’s secret isn’t', async () => {
    await expect.poll(() => epochOn(ana)).toBe(1);
    await expect.poll(() => epochOn(ben)).toBe(1);
    const [anaAfter, benAfter] = [await onlyGroup(ana.page), await onlyGroup(ben.page)];
    expect(anaAfter.secret).toEqual(benAfter.secret);
    expect(anaAfter.secret).not.toEqual(calsGroup.secret);
    await expect(
      ana.page.getByRole('region', { name: 'People', exact: true }).getByRole('listitem'),
    ).toHaveCount(2);
  });

  await test.step('Ana proposes with a canary title, and Ben finds it under Needs your vote', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(canary);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    const needs = ben.page.getByRole('region', { name: 'Needs your vote' });
    await expect(needs.getByRole('link', { name: new RegExp(canary) })).toBeVisible();
    await expectAccessible(ben, 'Group home after the new key');
  });

  await test.step('no blob the relay holds opens under Cal’s keys to the canary; the new key’s do', () => {
    const underCal = openedWith(relay.db, calsSecret);
    // Cal's keys still open what was sealed before he left, so the check reads real blobs.
    expect(underCal.length).toBeGreaterThan(0);
    expect(underCal.filter((plaintext) => plaintext.includes(canary))).toEqual([]);
  });

  const anaNow = await onlyGroup(ana.page);
  const newSecret = Uint8Array.from(anaNow.secret);

  await test.step('the Proposal opens under the new key, in the new mailbox', () => {
    const underNew = openedWith(relay.db, newSecret);
    expect(underNew.filter((plaintext) => plaintext.includes(canary))).toHaveLength(1);
    // The new secret's mailbox for this week (#110).
    const mailboxes = groupMailboxes(newSecret);
    expect(relayBlobs(relay.db).some((row) => mailboxes.includes(row.mailbox))).toBe(true);
  });

  await test.step('Cal’s earlier link opens, but joining from it leaves him outside, and says why', async () => {
    await joinFrom(cal, calsLink, false);
    await expect(cal.page.getByText(MISSED)).toBeVisible();
    await expect(cal.page.getByRole('button', { name: 'Copy invite link' })).toBeHidden();
    await expectAccessible(cal, 'Group home, key missed');
    // His join went to the old mailbox, so nobody else sees it.
    await ana.page.getByRole('link', { name: GROUP }).click();
    await expect(heading(ana.page, GROUP)).toBeVisible();
    await expect(
      ana.page.getByRole('region', { name: 'People', exact: true }).getByRole('listitem'),
    ).toHaveCount(2);
  });

  await test.step('the relay stops, and holds neither secret nor any device’s encryption key', async () => {
    for (const { page } of [ana, ben, cal]) await page.context().setOffline(true);
    const calNow = await onlyGroup(cal.page);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const kxKeys = [anaBefore, benBefore, calsGroup, calNow].map((held, i) => {
      expect(held.kxKey).toHaveLength(32);
      return keyCanaries(
        `device ${String(i + 1)}’s encryption key`,
        Uint8Array.from(held.kxKey ?? []),
      );
    });
    const canaries: Canary[] = [
      textCanary('the canary title', canary),
      ...keyCanaries('Cal’s group secret', calsSecret),
      ...keyCanaries('the new group secret', newSecret),
      ...keyCanaries('the new seal key', derive(newSecret, 'reconcile/v1/seal-key')),
      ...kxKeys.flat(),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    const mailboxes = groupMailboxes(newSecret).map((id) => textCanary('the new mailbox id', id));
    expect(scan(files, mailboxes)).not.toEqual([]);
  });
});
