/**
 * Mailboxes that rotate weekly (#110), end to end through the real relay and
 * the deploy CSP.
 *
 * The relay runs exactly as `relay.sh` starts it, so its clock is this
 * machine's: no test can move it to next week. A group spans a week boundary
 * here the way a device whose last GET still said last week makes it span
 * one: the test plays that device. Ana founds a group on a desktop and Ben
 * joins on a 390 px phone in the dark theme. The test reads Ana's keys from
 * IndexedDB, as anything on her device holds them, asks the relay its minute,
 * and checks that everything the app wrote went to this week's mailbox, as
 * Node's own HKDF derives it, and never to M2-02's single id. Then, as Ana's
 * device would at Wednesday 23:59 UTC, it posts a Proposal with a canary title
 * to last week's mailbox. Ben's device finds it under Needs your vote, and his
 * ballot goes to this week's. Cal joins from a fresh link, holds the same
 * history, and reads the Proposal among the open ones. Last, the stopped relay holds the group's blobs under exactly two
 * ids, last week's and this week's, each sealed to its own id, and neither the
 * retired id nor the secret anywhere in its files.
 *
 * Making `mailboxAt` (src/store/mailbox.ts) and the sync loop's channel the
 * single id again makes this spec fail at its first check (recorded in #110's PR).
 */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { APIRequestContext } from '@playwright/test';

import { open, seal } from '../src/crypto/seal';
import { signEvent } from '../src/engine/event';
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
import { describeFinding, keyCanaries, scan, textCanary } from './support/scan';
import { derive, onlyGroup, storedLogs, WEEK_MINUTES, weekMailbox, weekOf } from './support/stored';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
/** The run needs the relay's week to hold still for it: a few minutes, with room to spare. */
const ROOM_MINUTES = 15;

/** The relay's minute now: the `now` a GET of a throwaway mailbox returns. */
async function relayMinute(request: APIRequestContext): Promise<number> {
  const response = await request.get(`/v1/mailbox/${randomBytes(32).toString('base64url')}`);
  expect(response.status()).toBe(200);
  const { now } = (await response.json()) as { now: number };
  return now;
}

/** Every blob the relay holds that opens under `secret`'s seal key for its own mailbox, with that mailbox. */
function groupRows(file: string, secret: Uint8Array): { mailbox: string; blob: Uint8Array }[] {
  const key = derive(secret, 'reconcile/v1/seal-key');
  const db = new DatabaseSync(file, { timeout: 10_000 });
  try {
    return db
      .prepare('SELECT mailbox, blob FROM blobs ORDER BY seq')
      .all()
      .map((row) => ({
        mailbox: String(row.mailbox),
        blob: Uint8Array.from(row.blob as Uint8Array),
      }))
      .filter(({ mailbox, blob }) => open(mailbox, key, blob) !== null);
  } finally {
    db.close();
  }
}

/** Opens `link` on `person`'s new profile, through the pilot notice, and joins as them. */
async function joinFrom(person: Person, link: string): Promise<void> {
  const { page } = person;
  await page.goto(link);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page).toHaveURL(/#\/g\/[\w-]+$/);
}

/** The records each device holds for its one group, as seq and bytes. */
async function heldRecords(person: Person): Promise<string[]> {
  const [held] = await storedLogs(person.page);
  return (held?.log ?? []).map(([seq, , bytes]) => `${String(seq)}:${bytes}`);
}

test('a group writes to a new mailbox each week, still reads last week’s, and a newcomer gets it all', async ({
  openProfile,
  relay,
  request,
}) => {
  const start = await relayMinute(request);
  test.skip(
    WEEK_MINUTES - (start % WEEK_MINUTES) < ROOM_MINUTES,
    'Thursday 00:00 UTC is minutes away, so the relay’s week would turn mid-run.',
  );
  const week = weekOf(start);
  const canary = `CANARY-LAST-WEEK-${String(Date.now())}`;
  const ana = await openProfile('Ana', { viewport: DESKTOP });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile('Cal', { viewport: DESKTOP });

  await test.step('Ana founds the group, and Ben joins it', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const link = await foundGroup(ana.page, {
      name: GROUP,
      title: TITLE,
      atoms: ['Quiet hours start at 10pm.', 'Bins go out on Tuesday.'],
      founder: ana.name,
    });
    await joinFrom(ben, link);
    const people = ana.page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText('Ben');
  });

  const held = await onlyGroup(ana.page);
  const secret = Uint8Array.from(held.secret);
  const [lastWeek, thisWeek] = [weekMailbox(secret, week - 1), weekMailbox(secret, week)];
  const retired = derive(secret, 'reconcile/v1/mailbox').toString('base64url');

  await test.step('everything the app wrote went to this week’s mailbox, which Node’s HKDF derives', () => {
    const rows = groupRows(relay.db, secret);
    // Genesis and Ben's join, at least.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(rows.map((row) => row.mailbox))]).toEqual([thisWeek]);
    expect([lastWeek, retired]).not.toContain(thisWeek);
  });

  await test.step('a Proposal that reached last week’s mailbox, as the week turned, shows on Ben’s phone', async () => {
    const atom = `${held.groupId}.0`;
    const body = { atom, title: canary, why: 'Weekday evenings run later now.', text: '11pm.' };
    const draft = { type: 'proposal' as const, group: held.groupId, ts: Date.now(), body };
    const { record } = signEvent(Uint8Array.from(held.signingKey), draft);
    const blob = seal(lastWeek, derive(secret, 'reconcile/v1/seal-key'), record);
    // Posted as Ana's device posts, by a pass whose GET still said last week.
    const response = await request.put(`/v1/mailbox/${lastWeek}?ttl_days=30`, {
      data: Buffer.from(blob),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(response.status()).toBe(201);

    const needs = ben.page.getByRole('region', { name: 'Needs your vote' });
    await expect(needs.getByRole('link', { name: new RegExp(canary) })).toBeVisible();
    await expectAccessible(ben, 'Group home, last week’s Proposal');
  });

  await test.step('Ben votes on it, and his ballot goes to this week’s mailbox', async () => {
    const { page } = ben;
    const needs = page.getByRole('region', { name: 'Needs your vote' });
    await needs.getByRole('link', { name: new RegExp(canary) }).click();
    await pick(page, '3 · Supportive');
    await page.getByRole('button', { name: 'Send your vote' }).click();
    await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
    await expectAccessible(ben, 'the Proposal, voted');
    await expect.poll(() => heldRecords(ana)).toEqual(await heldRecords(ben));
    expect(await heldRecords(ana)).toHaveLength(4);
  });

  await test.step('Cal joins from a fresh link, holds the whole history, and finds the Proposal', async () => {
    await ana.page.goto('/');
    await ana.page.getByRole('link', { name: GROUP }).click();
    await ana.page.getByRole('button', { name: 'Copy invite link' }).click();
    const field = ana.page.getByRole('textbox', { name: 'Invite link' });
    await expect(field).toHaveValue(/#join\/[\w-]{43}$/);
    const link = await field.inputValue();
    await joinFrom(cal, link);
    // It opened before Cal joined, so he reads it among the open Proposals, with no ballot.
    const open = cal.page.getByRole('region', { name: 'Open Proposals' });
    await expect(open.getByRole('link', { name: new RegExp(canary) })).toBeVisible();
    await expectAccessible(cal, 'Group home, a newcomer');
    const everyone = await heldRecords(ana);
    await expect
      .poll(async () => (await heldRecords(cal)).slice(0, everyone.length))
      .toEqual(everyone);
  });

  await test.step('the stopped relay holds the group under last week’s id and this week’s, and nothing else', async () => {
    for (const { page } of [ana, ben, cal]) await page.context().setOffline(true);
    await relay.stop();
    const rows = groupRows(relay.db, secret);
    const ids = [...new Set(rows.map((row) => row.mailbox))].sort();
    expect(ids).toEqual([lastWeek, thisWeek].sort());
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Each blob is sealed to its own week's id: moved to the other week, it won't open.
    const key = derive(secret, 'reconcile/v1/seal-key');
    for (const { mailbox, blob } of rows) {
      const other = mailbox === lastWeek ? thisWeek : lastWeek;
      expect(open(other, key, blob)).toBeNull();
    }
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries = [
      textCanary('the retired single mailbox id', retired),
      ...keyCanaries('the group secret', secret),
      ...keyCanaries('the seal key', key),
      textCanary('the canary title', canary),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    // The control: the scan reads both weeks' ids where the relay keeps them.
    const weeks = [textCanary('last week’s id', lastWeek), textCanary('this week’s id', thisWeek)];
    const found = new Set(scan(files, weeks).map((finding) => finding.label));
    expect([...found].sort()).toEqual(['last week’s id', 'this week’s id']);
  });
});
