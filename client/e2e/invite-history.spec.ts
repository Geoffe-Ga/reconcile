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
 *
 * Reading before joining (#91): Cal reads the whole Document as it reads now
 * on the Join screen while IndexedDB holds nothing and the invite GET is the
 * only request, taps Not now, and comes back. Ana and Cal meet the first-run
 * guide after their first create and join, and its cards send nothing. A
 * second test opens an invite whose Document holds script, an image and
 * `javascript:` links, which render as inert text with no CSP violation.
 */
import { DatabaseSync } from 'node:sqlite';

import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  type FirstRun,
  type FirstRunOptions,
  GUIDE_KEY,
  heading,
  localKeys,
  PASSKEY_OFFER_KEY,
  type Person,
  pick,
  storedRecords,
  test,
} from './support/fixtures';
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

/** The pilot notice's `localStorage` key (`src/platform/notice.ts`): device-wide, set before Join. */
const NOTICE_KEY = 'reconcile.pilot-notice';

/** Join's question, under the whole Document (#91). */
const QUESTION = 'Do you share enough of this to join?';

/** The first-run guide's cards (#91): a Co-Creator sees all three, a Collaborator the last two. */
const CO_CREATOR_CARDS = ['Propose', 'Vote 0–4', 'Discuss in your chat'];
const COLLABORATOR_CARDS = CO_CREATOR_CARDS.slice(1);

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

/**
 * Opens `link` in a new profile, through the pilot notice (and the passkey
 * offer, #95), and checks Join's preview. Returns what first run showed.
 */
async function openInvite(
  person: Person,
  link: string,
  options?: FirstRunOptions,
): Promise<FirstRun> {
  const { page } = person;
  await page.goto(link);
  const firstRun = await acceptNotice(person, options);
  await expect(heading(page, GROUP)).toBeVisible();
  await expect(page).toHaveURL(/#\/join$/);
  await expect(page.getByText('From Ana’s invite')).toBeVisible();
  return firstRun;
}

/** Joins from the Join screen as `person.name` at Join's preselected level. */
async function joinHere(person: Person): Promise<void> {
  const { page } = person;
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page).toHaveURL(/#\/g\/[\w-]+$/);
}

/** Opens `link`, checks the preview, and joins as `person.name` at Join's preselected level. */
async function joinFrom(person: Person, link: string): Promise<void> {
  await openInvite(person, link);
  await joinHere(person);
}

/** The relay requests `page` sends while `act` runs, as "METHOD /path". */
async function relayRequestsDuring(page: Page, act: () => Promise<void>): Promise<string[]> {
  const seen: Request[] = [];
  const record = (request: Request) => {
    if (new URL(request.url()).pathname.startsWith('/v1/')) seen.push(request);
  };
  page.on('request', record);
  try {
    await act();
  } finally {
    page.off('request', record);
  }
  return seen.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
}

/**
 * Walks the first-run guide on Group home (#91): each card in `titles` in
 * turn, its heading focused and axe checked, then Done. The guide sends
 * nothing: the only relay requests meanwhile are the sync loop's reads of the
 * group's own mailbox. Done leaves the guide's flag set on the device.
 */
async function walkGuide(person: Person, titles: readonly string[]): Promise<void> {
  const { page } = person;
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const { secret } = await onlyGroup(page);
  const mailbox = derive(Uint8Array.from(secret), 'reconcile/v1/mailbox').toString('base64url');
  const sent = await relayRequestsDuring(page, async () => {
    for (const [i, title] of titles.entries()) {
      await expect(dialog.getByRole('heading', { name: title })).toBeFocused();
      await expect(dialog.getByText(`${String(i + 1)} of ${String(titles.length)}`)).toBeVisible();
      await expectAccessible(person, `first-run guide, card ${String(i + 1)}`);
      const last = i === titles.length - 1;
      await dialog.getByRole('button', { name: last ? 'Done' : 'Next' }).click();
    }
    await expect(dialog).toHaveCount(0);
  });
  expect(sent.filter((line) => line !== `GET /v1/mailbox/${mailbox}`)).toEqual([]);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), GUIDE_KEY)).toBe('1');
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

  await test.step('A creates a group, walks the first-run guide, and copies an invite link; B joins from it', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana, { guide: true });
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page
      .getByRole('textbox', { name: 'Document text' })
      .fill([FIRST_ATOM, SECOND_ATOM].join('\n\n'));
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await walkGuide(ana, CO_CREATOR_CARDS);
    await page.reload();
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
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

  const firstRunKeys: string[] = [];
  await test.step('C reads the whole current Document before any key exists, and taps Not now', async () => {
    await ana.page.goto('/');
    await ana.page.getByRole('link', { name: GROUP }).click();
    links.push(await copyInvite(ana.page));
    const link = links[1] ?? '';
    const { page } = cal;
    const inviteMailbox = derive(seedOf(link), 'reconcile/v1/invite-mailbox').toString('base64url');
    const inviteGet = [`GET /v1/mailbox/${inviteMailbox}`];

    const reading = await relayRequestsDuring(page, async () => {
      const { passkeyOffered } = await openInvite(cal, link, { guide: true });
      // First run's own device flags: the notice's, and the passkey offer's answer where it showed (#95).
      firstRunKeys.push(...(passkeyOffered ? [PASSKEY_OFFER_KEY, NOTICE_KEY] : [NOTICE_KEY]));
      const document = page.getByRole('article');
      await expect(document.getByRole('paragraph')).toHaveText([NEW_TEXT, SECOND_ATOM]);
      await expect(page.getByRole('heading', { level: 2, name: TITLE })).toBeFocused();
      await expect(page.getByRole('heading', { level: 2, name: QUESTION })).toBeVisible();
      expect(await storedRecords(page)).toBe(0);
      expect(await localKeys(page)).toEqual(firstRunKeys);
      await expectAccessible(cal, 'Join, with the whole Document');
      await page.getByRole('button', { name: 'Not now' }).click();
      await expect(heading(page, 'Your groups')).toBeVisible();
    });
    // Reading the Document and Not now sent nothing beyond the invite GET, and wrote nothing.
    expect(reading).toEqual(inviteGet);
    expect(await storedRecords(page)).toBe(0);
    expect(await localKeys(page)).toEqual(firstRunKeys);
  });

  await test.step('C opens the link again, joins, walks the guide, and sees what A and B see', async () => {
    const { page } = cal;
    await page.goto(links[1] ?? '');
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(page.getByRole('article').getByRole('paragraph')).toHaveText([
      NEW_TEXT,
      SECOND_ATOM,
    ]);
    expect(await storedRecords(page)).toBe(0);
    await joinHere(cal);
    await walkGuide(cal, COLLABORATOR_CARDS);
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

test('an invite’s Document renders script, an image and javascript: links as inert text', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const atoms = [
    '<script>window.xssRan = true</script>',
    '<img src="/xss.png" onerror="window.xssRan = true">',
    '[Open](javascript:window.xssRan=true) and <a href="javascript:window.xssRan=true">this</a>',
  ];
  const { page } = ana;
  await page.goto('/#/create');
  await acceptNotice(ana);
  await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
  await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
  await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Document text' }).fill(atoms.join('\n\n'));
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, GROUP)).toBeVisible();
  const link = await copyInvite(page);

  const fetched: string[] = [];
  ben.page.on('request', (request) => fetched.push(new URL(request.url()).pathname));
  await openInvite(ben, link);
  const document = ben.page.getByRole('article');
  for (const atom of atoms) await expect(document).toContainText(atom);
  await expect(ben.page.locator('main :is(script, img, iframe, [onerror])')).toHaveCount(0);
  await expect(document.locator('[style]')).toHaveCount(0);
  await expect(ben.page.locator('a[href^="javascript" i]')).toHaveCount(0);
  await expect(document.getByRole('link')).toHaveCount(0);
  expect(await ben.page.evaluate(() => 'xssRan' in window)).toBe(false);
  expect(fetched.filter((path) => path.endsWith('/xss.png'))).toEqual([]);
  await expectAccessible(ben, 'Join, with markup in the Document');
  // The fixture fails the test on any CSP violation in either profile.
});
