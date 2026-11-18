/**
 * A Discord thread per Proposal (#123; ADR-0011, ADR-0039 step 1), end to end
 * through the real relay and the deploy CSP. Ana, on a desktop, founds a
 * group with a chat link, and Ben, on a phone in the dark theme, joins. They
 * turn the chat bot on with a forum channel's webhook, which the `openProfile`
 * fixture answers as Discord would, so nothing reaches Discord. The vote's
 * result opens 'Proposal 1 in Reconcile', and the device that posted it
 * records that thread, though nobody claimed the vote's opening (#245). Then
 * Ana proposes a change: its opening notice opens 'Proposal 2 in Reconcile',
 * the device that posted it records the thread, each device reading the
 * webhook once at most, and Ben's Join discussion
 * opens that thread instead of the group's chat. When they vote
 * it through, the result goes into the thread as the concluded line. No
 * thread name or post carries a title, a name or the group's text. Every
 * notice ends with the vote's link (#472, ADR-0079): Ben opens the opening
 * notice's link from the address bar and lands on that Proposal's ballot,
 * and Cy, in no group, sees once first run is through that the vote isn't
 * on her device. No request from any profile carries a vote link's token,
 * the group's id or a Proposal's id. Nothing moves time: everyone scores, so each vote closes early, and the closing
 * notice, a day before a deadline, is left to the unit tests.
 */
import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  DISCORD_GUILD,
  discordThread,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const CHAT = 'https://chat.example.org/riverside';
const ATOM = 'Quiet hours start at 10pm.';
const PROPOSAL = 'Later quiet hours on weekends';
const NEW_TEXT = 'Quiet hours start at 11pm on Fridays and Saturdays.';
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const PHONE = { width: 390, height: 844 };
/** Proposal 2's thread: the second the fixture's forum opens. */
const THREAD = `https://discord.com/channels/${DISCORD_GUILD}/${discordThread(1)}`;

/** `person` scores the Proposal at `url` 4 and sends it, going there only if they aren't already (`visit`). */
async function vote(person: Person, url: string): Promise<void> {
  const { page } = person;
  await visit(page, url);
  await pick(page, '4 · Strongly supportive');
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** A vote link at `origin` (#472): `#vote/` and a 22-character token. */
function voteLinkAt(origin: string): RegExp {
  return new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#vote/[A-Za-z0-9_-]{22}$`);
}

/** The vote link a post's notice ends with, from its JSON body. */
function linkIn(post: { readonly body: unknown } | undefined): string {
  const body = post?.body;
  const content =
    typeof body === 'object' && body !== null && 'content' in body ? body.content : null;
  return typeof content === 'string' ? (content.split('\n').at(-1) ?? '') : '';
}

/** Join discussion on the screen `page` shows. */
function joinDiscussion(page: Page) {
  return page.getByRole('link', { name: /^Join discussion/ });
}

test('a Proposal’s first notice opens its Discord thread, Join discussion opens it, and its result concludes it', async ({
  openProfile,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const requests: Request[] = [];
  for (const { page } of [ana, ben]) page.on('request', (request) => requests.push(request));
  const posts = () => openProfile.discord.filter((request) => request.method === 'POST');
  /** Each read of the webhook's server and channel, which a device makes to record a thread. */
  const reads = () =>
    openProfile.discord.filter((request) => request.method === 'GET' && request.url === WEBHOOK);
  let proposalUrl = '';

  await test.step('Ana founds the group with a chat link, and Ben joins', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Chat link (optional)' }).fill(CHAT);
    await page.getByRole('textbox', { name: 'Document title' }).fill('House rules');
    await page.getByRole('textbox', { name: 'Document text' }).fill(ATOM);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    await ben.page.goto(invite);
    await acceptNotice(ben);
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await pick(ben.page, 'Co-Creator');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
  });

  await test.step('they turn the bot on with a forum channel’s webhook, and its result opens Proposal 1’s thread', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: /Chat bot and front door/ }).click();
    await page
      .getByRole('region', { name: 'Discord chat bot' })
      .getByRole('link', { name: 'Propose turning this on for the Discord chat bot' })
      .click();
    await expect(
      page.getByText(
        'Use a text channel, or a forum channel to give each Proposal its own thread.',
        { exact: false },
      ),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Discord webhook URL' }).fill(WEBHOOK);
    await page.getByRole('textbox', { name: 'Why' }).fill('A thread for each vote.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    const on = page.url();
    await vote(ana, on);
    await vote(ben, on);
    await expect(ben.page.getByText('This passed. The Discord chat bot is on.')).toBeVisible();
    await expect.poll(() => posts().length, { timeout: 30_000 }).toBe(1);
    expect(posts()[0]).toMatchObject({
      url: `${WEBHOOK}?wait=true`,
      body: {
        content: expect.stringMatching(/^A vote has finished in Reconcile\.\n/),
        thread_name: 'Proposal 1 in Reconcile',
        allowed_mentions: { parse: [] },
      },
    });
    // It ends with the vote's link (#472).
    expect(linkIn(posts()[0])).toMatch(voteLinkAt(origin));
    // The device that posted it reads where the webhook posts, to record the thread (#245).
    await expect.poll(() => reads().map((request) => request.url)).toEqual([WEBHOOK]);
  });

  await test.step('Ana proposes a change, and its opening notice opens Proposal 2’s thread', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: GROUP }).click();
    await page.getByRole('link', { name: 'House rules', exact: true }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekends run later for most of us.');
    await page.getByRole('textbox', { name: 'New text' }).fill(NEW_TEXT);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    proposalUrl = page.url();
    await expect(page.getByText('Proposal 2 · Open', { exact: true })).toBeVisible();

    await expect.poll(() => posts().length, { timeout: 30_000 }).toBe(2);
    expect(posts()[1]).toMatchObject({
      url: `${WEBHOOK}?wait=true`,
      body: {
        content: expect.stringMatching(/^A new Proposal is open in Reconcile\. Voting ends /),
        thread_name: 'Proposal 2 in Reconcile',
        allowed_mentions: { parse: [] },
      },
    });
    expect(linkIn(posts()[1])).toMatch(voteLinkAt(origin));
    // Each device reads the webhook's server and channel once at most: Proposal 1's poster has.
    expect(reads().length).toBeLessThanOrEqual(2);
  });

  await test.step('Ben opens the opening notice’s vote link from the address bar, and lands on its ballot', async () => {
    const { page } = ben;
    await page.goto(linkIn(posts()[1]));
    await expect(heading(page, PROPOSAL)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
    // The link replaced itself with the Proposal's page.
    await expect.poll(() => page.url()).toBe(proposalUrl);
  });

  await test.step('on Ben’s phone, the Proposal shows its number, and Join discussion opens its thread', async () => {
    const { page } = ben;
    await page.goto(proposalUrl);
    await expect(heading(page, PROPOSAL)).toBeVisible();
    await expect(page.getByText('Proposal 2 · Open', { exact: true })).toBeVisible();
    await expect(joinDiscussion(page)).toHaveAttribute('href', THREAD, { timeout: 30_000 });
    // Nothing scrolls sideways: the document, nor the region it scrolls in under the link bar (#444).
    expect(
      await page.evaluate(() =>
        [document.documentElement, document.querySelector('.app-page')].every(
          (box) => box === null || box.scrollWidth <= box.clientWidth,
        ),
      ),
    ).toBe(true);
    await expectAccessible(ben, 'Proposal view on a phone, with its thread');

    const [thread] = await Promise.all([
      page.context().waitForEvent('page'),
      joinDiscussion(page).click(),
    ]);
    await expect.poll(() => thread.url()).toBe(THREAD);
    const opened = openProfile.discord.find((request) => request.url === THREAD);
    expect(opened?.headers['referer']).toBeUndefined();
    await thread.close();
  });

  await test.step('they vote it through, and the result goes into the thread as the concluded line', async () => {
    await vote(ana, proposalUrl);
    await vote(ben, proposalUrl);
    await expect.poll(() => posts().length, { timeout: 30_000 }).toBe(3);
    expect(posts()[2]).toMatchObject({
      url: `${WEBHOOK}?thread_id=${discordThread(1)}`,
      body: {
        content: expect.stringMatching(
          /^The argument has concluded\. A vote has finished in Reconcile\.\n/,
        ),
        allowed_mentions: { parse: [] },
      },
    });
    // The result in the thread carries the same link as the opening notice.
    expect(linkIn(posts()[2])).toBe(linkIn(posts()[1]));
    expect(posts()[2]?.body).not.toHaveProperty('thread_name');
    await expect(joinDiscussion(ana.page)).toHaveAttribute('href', THREAD);
    await expectAccessible(ana, 'closed Proposal view, with its thread');
  });

  await test.step('Cy, in no group, sees that the vote isn’t on her device once first run is through', async () => {
    const cy = await openProfile('Cy', { viewport: PHONE });
    cy.page.on('request', (request) => requests.push(request));
    const { page } = cy;
    await page.goto(linkIn(posts()[1]));
    await acceptNotice(cy);
    await expect(
      page.getByText(
        'This vote isn’t on this device. It opens only on a device that’s in the vote’s group.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expectAccessible(cy, 'vote link not on this device, on a phone');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(cy, 'vote link not on this device, on a dark phone');
  });

  await test.step('no request carries a vote link’s token, the group’s id or a Proposal’s id (#472)', () => {
    const groupId = /#\/g\/([^/]+)\//.exec(proposalUrl)?.[1] ?? '';
    const proposalId = /\/p\/([^/]+)$/.exec(proposalUrl)?.[1] ?? '';
    expect(groupId).not.toBe('');
    expect(proposalId).not.toBe('');
    const tokens = posts().map((post) => linkIn(post).split('#vote/')[1] ?? '');
    const needles = [...new Set([...tokens, groupId, proposalId])];
    // Discord's own posts carry the link by design; every request to the app's origin is checked.
    const ours = requests.filter((request) => new URL(request.url()).origin === origin);
    expect(ours.length).toBeGreaterThan(0);
    for (const request of ours) {
      const { pathname, search } = new URL(request.url());
      const body = request.postDataBuffer()?.toString('latin1') ?? '';
      const sent = `${pathname}${search} ${body}`;
      for (const needle of needles) expect(sent).not.toContain(needle);
    }
  });

  await test.step('nothing of the group went to Discord: no title, name or text', () => {
    // Two devices, each of which read the webhook's server and channel once at most.
    expect(reads().length).toBeLessThanOrEqual(2);
    const everything = JSON.stringify(openProfile.discord.map(({ url, body }) => ({ url, body })));
    for (const word of [GROUP, PROPOSAL, NEW_TEXT, ATOM, 'House rules', 'Ana', 'Ben', CHAT]) {
      expect(everything).not.toContain(word);
    }
    for (const request of openProfile.discord) {
      expect(request.headers['cookie']).toBeUndefined();
      expect(request.headers['referer']).toBeUndefined();
    }
  });
});
