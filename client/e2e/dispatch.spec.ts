/**
 * Followers and Dispatches (#112), end to end through the real relay and the
 * deploy CSP.
 *
 * Ana, a Co-Creator on a desktop, founds a group; Kim joins on a 390 px phone
 * in the dark theme as a Member, who follows rather than votes. Ana sends a
 * Dispatch with canary words from Send a Dispatch, pointing to the group's
 * Document. Kim's Group home leads with it, See all lists it, and Open takes
 * her to the Document. Then Ana proposes a change that carries a Dispatch,
 * her ballot passes it, and Kim reads "Updated: House rules" from the
 * Proposal.
 *
 * Every request either profile sends is captured: the Dispatch's PUT asks
 * the relay for its content-free wake (`wake=1`), and no request carries the
 * canary words in any spelling. Once the relay stops, its database, WAL,
 * shared memory and log hold none either. axe checks each new screen in both
 * themes, and the fixture fails on any CSP violation.
 */
import { randomBytes } from 'node:crypto';

import type { Request } from '@playwright/test';

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
import { describeFinding, findIn, scan, textCanary } from './support/scan';
import { groupMailboxes, onlyGroup } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const CANARY = {
  title: `Canary ${TAG} garden day`,
  text: `Canary ${TAG}: bring gloves.`,
  carried: `Canary ${TAG}: quiet hours now start at eleven.`,
};

const CANARIES = Object.entries(CANARY).map(([field, text]) =>
  textCanary(`Dispatch ${field}`, text),
);

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PHONE = { width: 390, height: 844 };
const PROPOSAL = 'Later quiet hours';

/** axe on what `person` sees, in the light theme and then the dark one, ending where it began. */
async function inBothThemes(person: Person, screen: string, start: 'light' | 'dark') {
  const other = start === 'light' ? 'dark' : 'light';
  await expectAccessible(person, `${screen}, ${start}`);
  await person.page.emulateMedia({ colorScheme: other });
  await expectAccessible(person, `${screen}, ${other}`);
  await person.page.emulateMedia({ colorScheme: start });
}

/** A captured request as the scan reads it: its URL, then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

test('a Co-Creator’s Dispatch reaches a Member who follows, and no request carries its words', async ({
  openProfile,
  relay,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const kim = await openProfile('Kim', { viewport: PHONE, colorScheme: 'dark' });
  const requests: Request[] = [];
  for (const { page } of [ana, kim]) {
    page.on('request', (request) => {
      requests.push(request);
    });
  }

  await test.step('Ana founds the group, and Kim joins as a Member', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: TITLE,
      atoms: ['Quiet hours start at 10pm.', 'Bins go out on Tuesday.'],
      founder: 'Ana',
    });
    await kim.page.goto(invite);
    await acceptNotice(kim);
    await expect(heading(kim.page, GROUP)).toBeVisible();
    await kim.page.getByRole('textbox', { name: 'Your name' }).fill('Kim');
    await pick(kim.page, 'Member');
    await kim.page.getByRole('button', { name: 'Join group' }).click();
    await expect(kim.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Kim',
    );
  });

  await test.step('Kim’s Group home leads with Dispatches, with none yet', async () => {
    const first = kim.page.getByRole('region').first();
    await expect(first.getByRole('heading', { level: 2 })).toHaveText('Dispatches');
    await expect(first).toContainText('No Dispatches yet.');
    await expect(first.getByRole('link', { name: 'Send a Dispatch' })).toHaveCount(0);
    await inBothThemes(kim, 'Group home, a Member’s', 'dark');
  });

  await test.step('Ana sends a Dispatch pointing to the Document, and it asks for a wake', async () => {
    const { page } = ana;
    const dispatches = page.getByRole('region', { name: 'Dispatches', exact: true });
    await dispatches.getByRole('link', { name: 'Send a Dispatch' }).click();
    await expect(heading(page, 'Send a Dispatch')).toBeVisible();
    await inBothThemes(ana, 'Send a Dispatch', 'light');
    await page.getByRole('textbox', { name: 'Title' }).fill(CANARY.title);
    await page.getByRole('textbox', { name: 'Text (optional)' }).fill(CANARY.text);
    await pick(page, TITLE);
    const put = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith('&wake=1'),
    );
    await page.getByRole('button', { name: 'Send Dispatch' }).click();
    await put;
    await expect(heading(page, 'Dispatches')).toBeVisible();
    const card = page.getByRole('article').filter({ hasText: CANARY.title });
    await expect(card).toContainText('From Ana');
    await inBothThemes(ana, 'Dispatches', 'light');
  });

  await test.step('Kim reads it first on Group home, then in Dispatches, and opens the Document', async () => {
    const { page } = kim;
    const first = page.getByRole('region').first();
    await expect(first.getByRole('article')).toContainText(CANARY.title);
    await expect(first.getByRole('article')).toContainText(CANARY.text);
    await inBothThemes(kim, 'Group home, with a Dispatch', 'dark');
    await first.getByRole('link', { name: 'See all Dispatches' }).click();
    await expect(heading(page, 'Dispatches')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Send a Dispatch' })).toHaveCount(0);
    await inBothThemes(kim, 'Dispatches', 'dark');
    await page.getByRole('link', { name: `Open ${TITLE}` }).click();
    await expect(heading(page, TITLE)).toBeVisible();
  });

  await test.step('Ana’s Proposal carries a Dispatch, and her ballot passes it', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: GROUP }).click();
    // Exact: the latest Dispatch's Open House rules is a link too.
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekend evenings run late.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByText('Send a Dispatch if this passes').click();
    await expect(page.getByRole('textbox', { name: 'Dispatch title' })).toHaveValue(
      `Updated: ${TITLE}`,
    );
    await page.getByRole('textbox', { name: 'Dispatch text (optional)' }).fill(CANARY.carried);
    await inBothThemes(ana, 'Composer, with a Dispatch', 'light');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    const carried = page.getByRole('region', { name: 'If this passes' });
    await expect(carried).toContainText(CANARY.carried);
    await inBothThemes(ana, 'Proposal, carrying a Dispatch', 'light');
    await pick(page, '4 · Strongly supportive');
    await page.getByRole('button', { name: 'Send your vote' }).click();
    await expect(page.getByRole('region', { name: 'Result' })).toBeVisible();
  });

  await test.step('Kim reads it from the Proposal', async () => {
    const { page } = kim;
    await page.getByRole('link', { name: GROUP }).click();
    // Wait for the sync that brings the pass to show it as the latest Dispatch first: a card
    // that grows under the pointer can move See all Dispatches between Playwright's aim and its
    // click, which then lands on the card and leaves Kim on Group home.
    const first = page.getByRole('region').first();
    await expect(first.getByRole('article')).toContainText(`Updated: ${TITLE}`);
    await first.getByRole('link', { name: 'See all Dispatches' }).click();
    await expect(heading(page, 'Dispatches')).toBeVisible();
    const card = page.getByRole('article').filter({ hasText: `Updated: ${TITLE}` });
    await expect(card).toContainText(`From the Proposal ‘${PROPOSAL}’`);
    await expect(card).toContainText(CANARY.carried);
    await expect(page.getByRole('article')).toHaveCount(2);
  });

  await test.step('no request carried a Dispatch’s words, in any spelling', () => {
    const toRelay = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/v1/'),
    );
    // The control: both devices talked to the relay all along.
    expect(toRelay.filter((request) => request.method() === 'PUT').length).toBeGreaterThan(4);
    expect(toRelay.some((request) => request.method() === 'GET')).toBe(true);
    const findings = requests.flatMap((request) =>
      findIn(bytesOf(request), request.url(), CANARIES),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });

  const { secret } = await onlyGroup(kim.page);
  // Its weekly mailboxes (#110), whichever week this run fell in.
  const mailboxes = groupMailboxes(Uint8Array.from(secret));

  await test.step('the stopped relay’s database, WAL, shared memory and log hold no trace', async () => {
    for (const { page } of [ana, kim]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, CANARIES).map(describeFinding)).toEqual([]);
    // The control: the scan reads what the relay stored.
    const ids = mailboxes.map((id) => textCanary('the group’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
  });
});
