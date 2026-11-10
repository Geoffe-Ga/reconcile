/**
 * Joining with full history (#73; spec §7), end to end through the real relay.
 *
 * Ana founds a group and invites Ben, they pass a Proposal, and then the test
 * deletes the group's oldest relay rows, genesis included, straight from the
 * relay's SQLite file with `node:sqlite`, as a purge of expired rows would:
 * there is no relay route or flag for it. Cal then joins from a fresh link
 * and sees the same Document and people as Ana and Ben, with who invited
 * whom, because the invite's sealed envelope carried the whole log.
 *
 * Every request the three browsers send is captured, and none may carry the
 * group secret, an invite seed or an invite key, raw, in hex or in base64, in
 * its path, query or body.
 */
import { DatabaseSync } from 'node:sqlite';

import type { Page, Request } from '@playwright/test';

import { acceptNotice, expect, heading, type Person, pick, test } from './support/fixtures';
import { type Canary, describeFinding, findIn, keyCanaries } from './support/scan';
import { derive, onlyGroup } from './support/stored';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const FIRST_ATOM = 'Quiet hours start at 10pm.';
const SECOND_ATOM = 'Shared spaces are cleaned every Sunday.';
const PROPOSAL = 'Later quiet hours on weekends';
const NEW_TEXT = 'Quiet hours start at 10pm, and at 11pm on Fridays and Saturdays.';
const PEOPLE = [
  'Ana, Co-Creator, Steward',
  'Ben, invited by Ana, Collaborator',
  'Cal, invited by Ana, Collaborator',
];

/** The form the issue pins for an invite link. */
const LINK = /^https?:\/\/[^#]+\/#join\/[A-Za-z0-9_-]{43}$/;

/** What one request carried where a server could read it: its path and query, and its body. */
interface Sent {
  readonly where: string;
  readonly bytes: Buffer;
}

/** Request `index`'s path and query, then its body: never the fragment, which no browser sends. */
function sent(request: Request, index: number): Sent[] {
  const url = new URL(request.url());
  const body = request.postDataBuffer();
  const name = `request ${String(index)} (${request.method()}`;
  return [
    { where: `${name}, path and query)`, bytes: Buffer.from(url.pathname + url.search) },
    ...(body === null ? [] : [{ where: `${name}, body)`, bytes: body }]),
  ];
}

/** Copies a new invite link on `page`'s Group home and returns it. */
async function copyInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const field = page.getByRole('textbox', { name: 'Invite link' });
  await expect(field).toHaveValue(LINK);
  return field.inputValue();
}

/** The seed in an invite link. */
function seedOf(link: string): Buffer {
  return Buffer.from(new URL(link).hash.slice('#join/'.length), 'base64url');
}

/** Opens `link`, checks the preview, and joins as `person.name` at Join's preselected level. */
async function joinFrom(person: Person, link: string): Promise<void> {
  const { page } = person;
  await page.goto(link);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await expect(page).toHaveURL(/#\/join$/);
  await expect(page.getByText('From Ana’s invite')).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page).toHaveURL(/#\/g\/[\w-]+$/);
}

/** Scores the open Proposal with `pill` and sends the ballot. */
async function vote(person: Person, pill: string): Promise<void> {
  const { page } = person;
  await pick(page, pill);
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** Group home lists `PEOPLE`; the Document reads the passed text, then the second section. */
async function expectSameGroup(person: Person): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await page.getByRole('link', { name: GROUP }).click();
  const people = page.getByRole('region', { name: 'People', exact: true }).getByRole('listitem');
  // Each row in order; Ana, the steward, also sees Suspend on the others' rows (#102).
  await expect(people).toHaveCount(PEOPLE.length);
  await expect(people).toContainText(PEOPLE);
  await page.getByRole('link', { name: TITLE }).click();
  await expect(page.getByRole('article').getByRole('paragraph')).toHaveText([
    NEW_TEXT,
    SECOND_ATOM,
  ]);
}

test('a newcomer gets the whole history from the invite, even what the relay purged', async ({
  openProfile,
  relay,
}) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const cal = await openProfile('Cal');
  const requests: Request[] = [];
  for (const { page } of [ana, ben, cal]) page.on('request', (request) => requests.push(request));
  const links: string[] = [];

  await test.step('A creates a group and copies an invite link; B joins from it', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page
      .getByRole('textbox', { name: 'Document text' })
      .fill([FIRST_ATOM, SECOND_ATOM].join('\n\n'));
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    links.push(await copyInvite(page));
    await joinFrom(ben, links[0] ?? '');
  });

  await test.step('A proposes a change to the first section, and both vote it through', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekend evenings run later.');
    await page.getByRole('textbox', { name: 'New text' }).fill(NEW_TEXT);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    await vote(ana, '4 · Strongly supportive');

    // Ben hasn't scored it yet, so Group home lists it under Needs your vote (#77).
    const open = ben.page.getByRole('region', { name: 'Needs your vote' });
    await open.getByRole('link', { name: PROPOSAL }).click();
    await vote(ben, '3 · Supportive');
    for (const { page: each } of [ana, ben]) {
      const result = each.getByRole('region', { name: 'Result' });
      await expect(result.locator('.result-outcome').getByRole('paragraph')).toHaveText([
        'This passed. The Document now reads:',
        NEW_TEXT,
        'Thank you, Ana.',
      ]);
    }
  });

  const group = await onlyGroup(ana.page);
  const secret = Uint8Array.from(group.secret);
  const mailbox = derive(secret, 'reconcile/v1/mailbox').toString('base64url');

  await test.step('the test deletes the group’s oldest relay rows, genesis and the Proposal included', () => {
    const db = new DatabaseSync(relay.db, { timeout: 10_000 });
    try {
      const rows = db
        .prepare('SELECT seq FROM blobs WHERE mailbox = ? ORDER BY seq')
        .all(mailbox)
        .map((row) => Number(row.seq));
      // Genesis, Ben's join, the Proposal, then the two ballots.
      expect(rows).toHaveLength(5);
      const proposal = rows[2] ?? 0;
      db.prepare('DELETE FROM blobs WHERE mailbox = ? AND seq <= ?').run(mailbox, proposal);
      const left = db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE mailbox = ?').get(mailbox);
      expect(Number(left?.n)).toBe(2);
    } finally {
      db.close();
    }
  });

  await test.step('C joins from a fresh link and sees what A and B see', async () => {
    await ana.page.goto('/');
    await ana.page.getByRole('link', { name: GROUP }).click();
    links.push(await copyInvite(ana.page));
    await joinFrom(cal, links[1] ?? '');
    for (const person of [cal, ana, ben]) await expectSameGroup(person);
  });

  await test.step('the links carry only their seeds, and no request carried a secret, seed or key', () => {
    const [first = '', second = ''] = links;
    expect(first).not.toBe(second);
    const groupId = Buffer.from(group.groupId, 'base64url');
    for (const link of links) {
      const seed = seedOf(link);
      const inviteMailbox = derive(seed, 'reconcile/v1/invite-mailbox');
      for (const other of [groupId, Buffer.from(mailbox, 'base64url'), inviteMailbox]) {
        expect(seed.equals(other)).toBe(false);
      }
    }
    const canaries: Canary[] = [
      ...keyCanaries('the group secret', secret),
      ...links.flatMap((link, i) => {
        const seed = seedOf(link);
        const name = `invite ${String(i + 1)}’s`;
        return [
          ...keyCanaries(`${name} seed`, seed),
          ...keyCanaries(`${name} key`, derive(seed, 'reconcile/v1/invite-key')),
        ];
      }),
    ];
    const toRelay = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/v1/'),
    );
    expect(toRelay.some((request) => request.method() === 'PUT')).toBe(true);
    const findings = requests.flatMap((request, index) =>
      sent(request, index).flatMap(({ where, bytes }) => findIn(bytes, where, canaries)),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });
});
