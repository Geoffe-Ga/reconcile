/**
 * Group opt-ins (#117), end to end through the real relay and the deploy CSP:
 * Ana founds a group and holds seat 1; Ben, on a phone in the dark theme, and
 * Cal join. Ana opens Group rules from Group home, proposes turning the
 * Discord chat bot on with a webhook, and everyone votes it through at the
 * entrenched bar. Ben reads it on, by the webhook's last 4 characters only,
 * and sees no Turn off now. Then Ana, the steward, turns it off now, and Ben
 * reads who did. axe checks each screen, and the fixture fails the test on
 * any CSP violation. Nothing moves time. Once the bot is on, exactly one of
 * the three devices posts the vote's result to the webhook (#119), under the
 * deploy CSP, and the fixture answers it as a forum channel's webhook would,
 * so nothing reaches Discord. The post opens the vote's thread by its number
 * alone (#123) and carries the fixed line and the app's address, with no
 * cookie or referrer. The device that posted it then reads the webhook's
 * server and channel once, to record the thread its result opened (#245),
 * and after the steward's narrowing nothing more goes.
 */
import type { Page } from '@playwright/test';

import {
  acceptNotice,
  type DiscordRequest,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const PHONE = { width: 390, height: 844 };

/** True when nothing on the page scrolls sideways. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/** The People list. */
function people(page: Page) {
  return page.getByRole('region', { name: 'People', exact: true });
}

/**
 * Checks that `read` is a read of the webhook's server and channel, as a
 * device makes to record a thread (#245): a GET of the webhook itself, with
 * no cookie or referrer.
 */
function expectWebhookRead(read: DiscordRequest | undefined): void {
  expect(read?.method).toBe('GET');
  expect(read?.url).toBe(WEBHOOK);
  expect(read?.headers['referer']).toBeUndefined();
  expect(read?.headers['cookie']).toBeUndefined();
}

/** The chat bot's card on Group rules. */
function chatBot(page: Page) {
  return page.getByRole('region', { name: 'Discord chat bot' });
}

/** `person` joins from `invite` as a Co-Creator. */
async function join(person: Person, invite: string): Promise<void> {
  const { page } = person;
  await page.goto(invite);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await pick(page, 'Co-Creator');
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(people(page)).toContainText(person.name);
}

/** `person` scores the Proposal at `url` 4 and sends it, going there only if they aren't already (`visit`). */
async function vote(person: Person, url: string): Promise<void> {
  const { page } = person;
  await visit(page, url);
  await pick(page, '4 · Strongly supportive');
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

test('the group turns its chat bot on by an entrenched vote, and a steward turns it off now', async ({
  openProfile,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile('Cal');
  let rulesUrl = '';
  let proposalUrl = '';

  await test.step('Ana founds the group, and Ben and Cal join', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill('House rules');
    await page.getByRole('textbox', { name: 'Document text' }).fill('Quiet hours start at 10pm.');
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    await join(ben, invite);
    await join(cal, invite);
  });

  await test.step('Ana opens Group rules and proposes turning the chat bot on', async () => {
    const { page } = ana;
    // Wait until both joins have synced to Ana's Group home: each newcomer adds a
    // row (with #101 a taller one), which moves the Rules link below People. A click
    // aimed while it moves can land elsewhere (seen on WebKit).
    await expect(people(page)).toContainText(cal.name);
    await expect(people(page)).toContainText(ben.name);
    await page.getByRole('link', { name: /Chat bot and front door/ }).click();
    await expect(heading(page, 'What reaches outside your group')).toBeVisible();
    rulesUrl = page.url();
    await expect(chatBot(page)).toContainText('Discord’s servers will hold');
    await expectAccessible(ana, 'Group rules');
    await chatBot(page)
      .getByRole('link', { name: 'Propose turning this on for the Discord chat bot' })
      .click();
    await expect(heading(page, 'Turn on the Discord chat bot')).toBeVisible();
    await page.getByRole('textbox', { name: 'Discord webhook URL' }).fill(WEBHOOK);
    await page.getByRole('textbox', { name: 'Why' }).fill('A nudge in the chat when a vote opens.');
    await expectAccessible(ana, 'Opt-in composer');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('region', { name: 'Turn on the Discord chat bot' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    proposalUrl = page.url();
    await expectAccessible(ana, 'Rules ballot');
  });

  await test.step('everyone votes it through, and Ben reads it on by its last 4', async () => {
    await vote(ana, proposalUrl);
    await vote(cal, proposalUrl);
    await vote(ben, proposalUrl);
    const { page } = ben;
    await expect(page.getByText('This passed. The Discord chat bot is on.')).toBeVisible();
    await page.goto(rulesUrl);
    await expect(chatBot(page).getByText('WXYZ')).toBeVisible();
    await expect(page.getByText(/sEcReT/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Turn off now/ })).toHaveCount(0);
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(ben, 'Group rules on a phone, bot on');
  });

  await test.step('one device posts the result to the webhook, opening its thread, and nothing of the group', async () => {
    await expect.poll(() => openProfile.discord.length, { timeout: 30_000 }).toBe(2);
    const [post, read] = openProfile.discord;
    expect(post?.method).toBe('POST');
    expect(post?.url).toBe(`${WEBHOOK}?wait=true`);
    expect(post?.body).toEqual({
      content: `A vote has finished in Reconcile.\n${origin}/`,
      thread_name: 'Proposal 1 in Reconcile',
      allowed_mentions: { parse: [] },
    });
    expect(post?.headers['origin']).toBe(origin);
    expect(post?.headers['content-type']).toBe('application/json');
    expect(post?.headers['referer']).toBeUndefined();
    expect(post?.headers['cookie']).toBeUndefined();
    // Then it reads where the webhook posts, so it can record the thread its result opened (#245).
    expectWebhookRead(read);
  });

  await test.step('Ana, the steward, turns it off now, and Ben reads who did', async () => {
    const { page } = ana;
    await page.goto(rulesUrl);
    await chatBot(page)
      .getByRole('link', { name: 'Turn off now for the Discord chat bot' })
      .click();
    await expect(
      page.getByText(
        'It’s off until the group decides. This Proposal asks the group to keep it off.',
      ),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Why' }).fill('Someone posted the webhook in public.');
    await page.getByRole('button', { name: 'Turn off now' }).click();
    await expect(page.getByRole('region', { name: 'Turn off the Discord chat bot' })).toBeVisible();
    await expect(page.getByText(/^Steward\s+Ana\s+turned this off at once\./)).toBeVisible();

    await ben.page.goto(rulesUrl);
    await expect(chatBot(ben.page)).toContainText(
      'Off for now. Steward Ana turned it off while your group votes.',
    );
    await expectAccessible(ben, 'Group rules on a phone, narrowed');
    // The off-Proposal opened while the bot was narrowed, so no device posts it.
    expect(openProfile.discord).toHaveLength(2);
  });
});
