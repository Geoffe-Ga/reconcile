/**
 * Two groups reconcile (#114), in two browser profiles through the real
 * relay: Ana founds Riverside, Ben founds Oak St, Ana makes a reconcile card
 * from Riverside's home, Ben opens its link and brings it to Oak St, and
 * each group votes on its own reconcile Proposal. Once both pass, both group
 * homes list the coalition as formed, with both groups. axe runs on the
 * card's form, its link, Bring and the Coalitions section.
 *
 * Then the relay stops, and its database, WAL, shared memory and log are
 * scanned for every canary: the coalition's name and statement, each
 * person's coalition name, both group names, the coalition secret and seal
 * key, the card's seed and key, and each coalition key. A readable control
 * blob, the coalition's weekly mailbox ids and the card's mailbox id must
 * all turn up, so the scan can't pass by reading nothing.
 *
 * Then Ana proposes a change to the coalition's statement from its home
 * (#120), it opens as a coalition vote in both groups, and once both pass,
 * both see that the coalition passed it, to take effect a week after its
 * deadline. Its title, why and text are canaries too.
 *
 * Admitting a third group, and the coalition's text changing once a pass is
 * final, aren't here: each is final only a week after its deadline (#100),
 * and these specs never move the clock, so `src/app/reconcileFlow.test.tsx`
 * and `src/screens/coalitionLoop.test.tsx` cover them on a fake relay.
 */
import { randomBytes } from 'node:crypto';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';
import { type Canary, describeFinding, keyCanaries, scan, textCanary } from './support/scan';
import { derive, groupMailboxes, storedGroups } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
function tag(): string {
  return randomBytes(8).toString('hex');
}

/** Founds `group` as `founder` from a fresh profile's first run, and waits for its home. */
async function found(person: Person, group: string, founder: string): Promise<void> {
  const { page } = person;
  await page.goto('/#/create');
  await acceptNotice(person);
  await page.getByRole('textbox', { name: 'Group name' }).fill(group);
  await page.getByRole('textbox', { name: 'Your name' }).fill(founder);
  await page.getByRole('textbox', { name: 'Document title' }).fill('House rules');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Quiet hours start at ten.');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, group)).toBeVisible();
}

/** Scores the open Proposal 4 and sends the ballot. */
async function passes(person: Person): Promise<void> {
  const { page } = person;
  await pick(page, '4 · Strongly supportive');
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

test('two groups reconcile by a card, both pass, and the relay keeps none of it readable', async ({
  openProfile,
  relay,
  request,
}) => {
  const run = tag();
  const words = {
    riverside: `CANARY-GROUP-A-${run}`,
    oak: `CANARY-GROUP-B-${run}`,
    coalition: `CANARY-COALITION-${run}`,
    statement: `CANARY-STATEMENT-${run}`,
    why: `CANARY-WHY-${run}`,
    anaName: `CANARY-ANA-IN-COALITION-${run}`,
    benName: `CANARY-BEN-IN-COALITION-${run}`,
    motionTitle: `CANARY-MOTION-${run}`,
    motionWhy: `CANARY-MOTION-WHY-${run}`,
    motionText: `CANARY-MOTION-TEXT-${run}`,
  };
  const control = `CONTROL-${tag()}`;
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  let cardLink = '';

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

  await test.step('Ana founds Riverside, and Ben founds Oak St', async () => {
    await found(ana, words.riverside, 'Ana');
    await found(ben, words.oak, 'Ben');
  });

  await test.step('Ana makes a card from Riverside’s home, and its link shows once the relay has it', async () => {
    const { page } = ana;
    const coalitions = page.getByRole('region', { name: 'Coalitions' });
    await coalitions.getByRole('link', { name: /Reconcile with another group/ }).click();
    await expect(heading(page, 'Reconcile with another group')).toBeVisible();
    await expectAccessible(ana, 'Reconcile with another group');
    await page.getByRole('textbox', { name: 'The coalition’s name' }).fill(words.coalition);
    await page
      .getByRole('textbox', { name: 'Its first statement' })
      .fill(`${words.statement}\n\nWe meet on the first Sunday.`);
    await page.getByRole('textbox', { name: 'Why' }).fill(words.why);
    await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.anaName);
    await page.getByRole('button', { name: 'Make the card' }).click();
    const link = page.getByRole('textbox', { name: 'Card link' });
    await expect(link).toHaveValue(/^https?:\/\/[^#]+\/#reconcile\/[A-Za-z0-9_-]{43}$/);
    await expect(page.getByText('Anyone who opens this link in the next 2 days')).toBeVisible();
    await expectAccessible(ana, 'the card’s link');
    cardLink = await link.inputValue();
  });

  await test.step('Ben opens the card, sees it as plain text, and brings it to Oak St', async () => {
    const { page } = ben;
    await visit(page, cardLink);
    await expect(heading(page, words.coalition)).toBeVisible();
    await expect(page).toHaveURL(/#\/card$/);
    await expect(page.getByText(words.statement)).toBeVisible();
    await expect(page.getByText(`From ${words.riverside}`)).toBeVisible();
    const picker = page.getByRole('radiogroup', { name: 'Your group' });
    await expect(picker.getByRole('radio', { name: words.oak })).toBeChecked();
    await expectAccessible(ben, 'Bring a card');
    await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.benName);
    await page.getByRole('button', { name: 'Bring to my group' }).click();
    await expect(heading(page, `Reconcile into ${words.coalition}`)).toBeVisible();
    const statement = page.getByRole('region', { name: 'The coalition’s statement' });
    await expect(statement).toContainText(`Reconcile with ${words.riverside}`);
  });

  await test.step('each group passes its own reconcile Proposal', async () => {
    await passes(ben);
    const { page } = ana;
    await page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
    await expect(heading(page, `Reconcile into ${words.coalition}`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'The coalition’s statement' })).toContainText(
      `Reconcile with ${words.oak}`,
    );
    await passes(ana);
  });

  await test.step('both group homes list the coalition as formed, with both groups', async () => {
    for (const [person, group] of [
      [ana, words.riverside],
      [ben, words.oak],
    ] as const) {
      const { page } = person;
      await page.getByRole('link', { name: group }).click();
      const coalitions = page.getByRole('region', { name: 'Coalitions' });
      await expect(coalitions).toContainText('Formed', { timeout: 45_000 });
      await expect(coalitions).toContainText(`${words.coalition}${words.riverside}, ${words.oak}`);
      await expectAccessible(person, 'Coalitions');
    }
    await expect(ana.page.getByRole('region', { name: 'Coalitions' })).toContainText(
      `You take part as ${words.anaName}`,
    );
  });

  await test.step('Ana proposes a change from the coalition’s home (#120)', async () => {
    const { page } = ana;
    const coalitions = page.getByRole('region', { name: 'Coalitions' });
    await coalitions.getByRole('link', { name: 'Open the coalition' }).click();
    await expect(heading(page, words.coalition)).toBeVisible();
    await expectAccessible(ana, 'the coalition’s home');
    await page
      .getByRole('region', { name: 'Documents' })
      .getByRole('link', { name: /Mission statement/ })
      .click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(words.motionTitle);
    await page.getByRole('textbox', { name: 'Why' }).fill(words.motionWhy);
    await page.getByRole('textbox', { name: 'New text' }).fill(words.motionText);
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, words.coalition)).toBeVisible();
  });

  await test.step('it opens as a coalition vote in Oak St, which passes it inside the group', async () => {
    // Ben is still on Oak St's home, which updates as his device syncs.
    const { page } = ben;
    const card = page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(words.motionTitle) });
    await expect(card).toContainText(`Coalition vote · ${words.coalition}`, { timeout: 45_000 });
    await card.click();
    await expect(heading(page, words.motionTitle)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Across the coalition' })).toContainText(
      '0 of 2 groups have passed.',
    );
    await expectAccessible(ben, 'a coalition vote');
    await passes(ben);
  });

  await test.step('once Riverside passes it too, the coalition has passed it, to take effect in a week', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: words.riverside, exact: true }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(words.motionTitle) })
      .click();
    await passes(ana);
    const result = page.getByRole('region', { name: 'The coalition’s result' });
    await expect(result).toContainText('The coalition passed this. It takes effect on', {
      timeout: 45_000,
    });
    await expectAccessible(ana, 'a coalition vote’s result');
  });

  const held = [...(await storedGroups(ana.page)), ...(await storedGroups(ben.page))];
  const entries = held.filter((group) => group.kind === 'coalition');
  const [entry] = entries;
  if (entry === undefined || entries.length !== 2) {
    throw new Error('Expected each device to hold the one coalition.');
  }
  const secret = Uint8Array.from(entry.secret);
  const seed = Buffer.from(new URL(cardLink).hash.slice('#reconcile/'.length), 'base64url');

  await test.step('the relay stops, and nothing it kept holds a canary', async () => {
    for (const { page } of [ana, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries: Canary[] = [
      ...Object.entries(words).map(([field, text]) => textCanary(field, text)),
      ...keyCanaries('the coalition secret', secret),
      ...keyCanaries('the coalition’s seal key', derive(secret, 'reconcile/v1/seal-key')),
      ...keyCanaries('the card seed', seed),
      ...keyCanaries('the card key', derive(seed, 'reconcile/v1/card-key')),
      ...entries.flatMap((each, i) => [
        ...keyCanaries(`coalition key ${String(i + 1)}`, Uint8Array.from(each.signingKey)),
        ...keyCanaries(`coalition id ${String(i + 1)}`, Buffer.from(each.groupId, 'base64url')),
      ]),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored.
    const controls = scan(files, [textCanary('control', control)]);
    expect(controls.map(({ encoding }) => encoding)).toContain('bytes');
    const ids = groupMailboxes(secret).map((id) => textCanary('the coalition’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
    const card = derive(seed, 'reconcile/v1/card-mailbox').toString('base64url');
    const cardId = scan(files, [textCanary('the card’s mailbox id', card)]);
    expect(cardId.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
