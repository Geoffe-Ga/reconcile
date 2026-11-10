/**
 * The relay learns nothing (#71; spec §9 and §10): after a whole loop through
 * the real relay, nothing it stored or printed holds the group's words, its
 * members' names or keys, or the testers' IP address.
 *
 * Two people found a group, join it, propose, vote with a note and see the
 * Update, and the founder, a steward, suspends the other with a reason (#102),
 * every field carrying a canary, and every request carrying a
 * documentation IP address in each forwarding header. The test reads the
 * group secret and each member's keys from IndexedDB, and the invite seed
 * from the link, whose envelope carried the secret and the whole log (#73),
 * then stops the relay,
 * so its database is checkpointed and its log complete, and scans the raw
 * bytes of the database, its `-wal` and `-shm` files and the log.
 *
 * Two controls keep the scan honest, so it can't pass by reading nothing:
 * a 1,024-byte blob the test PUTs with a canary in plain text, and the
 * group's mailbox id, the one thing the relay is meant to keep. The scan must
 * find both. Any build that sends readable blobs fails here, as the stub seal
 * did (recorded in #71's PR).
 */
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';

import { acceptNotice, expect, heading, type Person, pick, test } from './support/fixtures';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  scan,
  textCanary,
} from './support/scan';
import { derive, storedGroups } from './support/stored';

/**
 * TEST-NET-3 (RFC 5737): an address no tester has. Loopback can't be the
 * canary, because Uvicorn prints the address it binds.
 */
const IP = '203.0.113.7';
const FORWARDING = { 'X-Forwarded-For': IP, Forwarded: `for=${IP}`, 'X-Real-IP': IP };

/** A random tag, so no two runs plant the same canaries. */
function tag(): string {
  return randomBytes(8).toString('hex');
}

/** Scores the open Proposal with `pill`, writes `note` when there is one, and sends the ballot. */
async function vote(person: Person, pill: string, note?: string): Promise<void> {
  const { page } = person;
  await pick(page, pill);
  if (note !== undefined) await page.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

test('the scan finds a canary in every spelling, at every byte alignment', () => {
  const canary = textCanary('sample', `SAMPLE-${tag()}`);
  const encoders: Record<string, (bytes: Buffer) => string | Buffer> = {
    bytes: (bytes) => bytes,
    hex: (bytes) => bytes.toString('hex'),
    HEX: (bytes) => bytes.toString('hex').toUpperCase(),
    base64: (bytes) => bytes.toString('base64'),
    base64url: (bytes) => bytes.toString('base64url'),
  };
  for (const [name, encode] of Object.entries(encoders)) {
    for (const before of [0, 1, 2, 3, 4, 5]) {
      const run = Buffer.concat([randomBytes(before), Buffer.from(canary.bytes), randomBytes(7)]);
      const haystack = Buffer.concat([randomBytes(64), Buffer.from(encode(run)), randomBytes(64)]);
      expect(
        findIn(haystack, 'sample.db', [canary]),
        `${name} after ${String(before)}`,
      ).not.toEqual([]);
    }
  }
  expect(findIn(randomBytes(65_536), 'noise.db', [canary])).toEqual([]);
});

test('the relay keeps none of the group’s words, names or keys, nor the testers’ IP', async ({
  openProfile,
  relay,
  request,
}) => {
  const run = tag();
  const words = {
    group: `CANARY-GROUP-${run}`,
    title: `CANARY-DOC-TITLE-${run}`,
    atom: `CANARY-ATOM-${run}`,
    ana: `CANARY-NAME-ANA-${run}`,
    ben: `CANARY-NAME-BEN-${run}`,
    proposal: `CANARY-PROPOSAL-${run}`,
    why: `CANARY-WHY-${run}`,
    newText: `CANARY-NEW-TEXT-${run}`,
    note: `CANARY-NOTE-${run}`,
    reason: `CANARY-SUSPEND-REASON-${run}`,
  };
  const control = `CONTROL-${tag()}`;
  const ana = await openProfile(words.ana, { extraHTTPHeaders: FORWARDING });
  const ben = await openProfile(words.ben, { extraHTTPHeaders: FORWARDING });
  let inviteLink = '';

  await test.step('the control: one readable 1,024-byte blob, PUT straight to a throwaway mailbox', async () => {
    const blob = Buffer.alloc(1024);
    blob.write(control, 100, 'utf8');
    const throwaway = randomBytes(32).toString('base64url');
    const response = await request.put(`/v1/mailbox/${throwaway}?ttl_days=1`, {
      data: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(response.status()).toBe(201);
  });

  await test.step('A creates the group, sending the IP canary in every forwarding header', async () => {
    const { page } = ana;
    const toRelay = page.waitForRequest((sent) => sent.url().includes('/v1/mailbox/'));
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(words.group);
    await page.getByRole('textbox', { name: 'Your name' }).fill(words.ana);
    await page.getByRole('textbox', { name: 'Document title' }).fill(words.title);
    await page
      .getByRole('textbox', { name: 'Document text' })
      .fill(`${words.atom}\n\nShared spaces are cleaned every Sunday.`);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, words.group)).toBeVisible();
    const headers = await (await toRelay).allHeaders();
    expect([headers['x-forwarded-for'], headers.forwarded, headers['x-real-ip']]).toEqual([
      IP,
      `for=${IP}`,
      IP,
    ]);
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    inviteLink = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    expect(inviteLink).toMatch(/^https?:\/\/[^#]+\/#join\/[A-Za-z0-9_-]{43}$/);
  });

  await test.step('B joins from the link', async () => {
    const { page } = ben;
    await page.goto(inviteLink);
    await acceptNotice(ben);
    await expect(heading(page, words.group)).toBeVisible();
    await page.getByRole('textbox', { name: 'Your name' }).fill(words.ben);
    await page.getByRole('button', { name: 'Join group' }).click();
    const people = page.getByRole('region', { name: 'People' }).getByRole('listitem');
    await expect(people).toHaveText([
      `${words.ana}, Co-Creator, Steward`,
      `${words.ben}, invited by ${words.ana}, Collaborator`,
    ]);
  });

  await test.step('A proposes, and both vote, B with a note', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: words.title }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(words.proposal);
    await page.getByRole('textbox', { name: 'Why' }).fill(words.why);
    await page.getByRole('textbox', { name: 'New text' }).fill(words.newText);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    await vote(ana, '4 · Strongly supportive');

    // Ben hasn't scored it yet, so Group home lists it under Needs your vote (#77).
    const open = ben.page.getByRole('region', { name: 'Needs your vote' });
    await open.getByRole('link', { name: words.proposal }).click();
    await expect(heading(ben.page, words.proposal)).toBeVisible();
    await vote(ben, '3 · Supportive', words.note);
  });

  await test.step('the vote closes early, and both see the Update', async () => {
    for (const { page } of [ana, ben]) {
      const result = page.getByRole('region', { name: 'Result' });
      await expect(result.locator('.result-outcome').getByRole('paragraph')).toHaveText([
        'This passed. The Document now reads:',
        words.newText,
        `Thank you, ${words.ana}.`,
      ]);
    }
  });

  await test.step('A, the steward, suspends B with a reason, and B reads it (#102)', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: words.group }).click();
    await page.getByRole('button', { name: `Suspend ${words.ben}` }).click();
    const dialog = page.getByRole('dialog', { name: `Suspend ${words.ben}?` });
    await dialog.getByRole('textbox', { name: 'Reason (optional)' }).fill(words.reason);
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await ben.page.getByRole('link', { name: words.group }).click();
    await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      `Reason: ${words.reason}`,
    );
  });

  const [anaGroups, benGroups] = [await storedGroups(ana.page), await storedGroups(ben.page)];
  const [mine, theirs] = [anaGroups[0], benGroups[0]];
  if (mine === undefined || theirs === undefined || anaGroups.length + benGroups.length !== 2) {
    throw new Error('Expected each device to hold exactly the one group.');
  }
  expect([theirs.groupId, theirs.secret]).toEqual([mine.groupId, mine.secret]);
  const secret = Uint8Array.from(mine.secret);
  const mailbox = derive(secret, 'reconcile/v1/mailbox').toString('base64url');
  const seed = Buffer.from(new URL(inviteLink).hash.slice('#join/'.length), 'base64url');

  await test.step('the relay stops, and its database, WAL, shared memory and log hold no canary', async () => {
    // Both devices go offline first, so no poll is in flight while the relay stops.
    for (const { page } of [ana, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(statSync(relay.db).size).toBeGreaterThan(0);
    expect(statSync(relay.log).isFile()).toBe(true);

    const canaries: Canary[] = [
      ...Object.entries(words).map(([field, text]) => textCanary(field, text)),
      textCanary('the testers’ IP', IP),
      ...keyCanaries('the group id', Buffer.from(mine.groupId, 'base64url')),
      ...keyCanaries('the group secret', secret),
      ...keyCanaries('the seal key', derive(secret, 'reconcile/v1/seal-key')),
      ...keyCanaries('the invite seed', seed),
      ...keyCanaries('the invite key', derive(seed, 'reconcile/v1/invite-key')),
      ...[mine, theirs].flatMap((member, i) => [
        ...keyCanaries(
          `member ${String(i + 1)}’s public key`,
          Buffer.from(member.author, 'base64url'),
        ),
        ...keyCanaries(`member ${String(i + 1)}’s signing key`, Uint8Array.from(member.signingKey)),
      ]),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored.
    const controls = scan(files, [textCanary('control', control)]);
    expect(controls.map(({ encoding }) => encoding)).toContain('bytes');
    const mailboxes = scan(files, [textCanary('the group’s mailbox id', mailbox)]);
    expect(mailboxes.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
