/**
 * Two groups reconcile (#114), in two browser profiles through the real
 * relay: Ana founds Riverside, Ben founds Oak St, Ana makes a reconcile card
 * from Riverside's home, Ben pastes its link into the link bar on Oak St's
 * home (#444) and brings it to Oak St, and each group votes on its own
 * reconcile Proposal. Once both pass, both group homes list the coalition as
 * formed, with both groups. axe runs on the card's form, its link, Bring and
 * the Coalitions section.
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
 * both see that the coalition passed it, to take effect a day after its
 * deadline. Its title, why and text are canaries too.
 *
 * Admitting a third group isn't here: it is final only a day after its
 * deadline (#100), so `src/app/reconcileFlow.test.tsx` covers it on a fake
 * relay. `coalition.spec.ts` (#127) sees a coalition's text change once a
 * pass is final, and a change fail in one group.
 */
import { type Bringing, coalitionKeys, makeCard, type NewCoalition } from './support/coalition';
import { expect, expectAccessible, heading, type Person, test } from './support/fixtures';
import { type Canary, describeFinding, putControl, scan, tag, textCanary } from './support/scan';
import { found, vote } from './support/steps';
import { storedGroups } from './support/stored';

/** Each founding group's one Document. */
const DOCUMENT = { title: 'House rules', atoms: ['Quiet hours start at ten.'] };

/** The pill both groups pass with. */
const FOUR = '4 · Strongly supportive';

/**
 * `person` pastes the card `link` into the link bar on their group's home
 * (#444), opens it with Enter, sees it as plain text, and brings it to the
 * group `bringing` names, landing on that group's reconcile Proposal. The
 * steps after opening are `bringCard`'s (support/coalition.ts), which opens
 * the link itself instead.
 */
async function bringCardFromBar(person: Person, link: string, bringing: Bringing): Promise<void> {
  const { page } = person;
  const { coalition } = bringing;
  await expect(heading(page, bringing.to)).toBeVisible();
  const bar = page.getByRole('searchbox', { name: 'Search or paste a link' });
  await bar.fill(link);
  await expect(page.getByRole('option')).toHaveText(/^A reconcile card/u);
  await bar.press('Enter');
  await expect(heading(page, coalition.name)).toBeVisible();
  // The card's seed never reached the address bar.
  await expect(page).toHaveURL(/#\/card$/u);
  await expect(bar).toHaveValue('');
  for (const section of coalition.statement) await expect(page.getByText(section)).toBeVisible();
  await expect(page.getByText(`From ${bringing.from}`)).toBeVisible();
  const picker = page.getByRole('radiogroup', { name: 'Your group' });
  await expect(picker.getByRole('radio')).toHaveCount(1);
  await expect(picker.getByRole('radio', { name: bringing.to })).toBeChecked();
  await expectAccessible(person, 'Bring a card');
  await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(bringing.yourName);
  await page.getByRole('button', { name: 'Bring to my group' }).click();
  await expect(heading(page, `Reconcile into ${coalition.name}`)).toBeVisible();
  const statement = page.getByRole('region', { name: 'The coalition’s statement' });
  await expect(statement).toContainText(`Reconcile with ${bringing.from}`);
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
  const coalition: NewCoalition = {
    name: words.coalition,
    statement: [words.statement, 'We meet on the first Sunday.'],
    why: words.why,
    yourName: words.anaName,
  };
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  let cardLink = '';

  await test.step('the control: one readable 1,024-byte blob, PUT straight to a throwaway mailbox', async () => {
    await putControl(request, control);
  });

  await test.step('Ana founds Riverside, and Ben founds Oak St', async () => {
    await found(ana, { ...DOCUMENT, name: words.riverside, founder: 'Ana' });
    await found(ben, { ...DOCUMENT, name: words.oak, founder: 'Ben' });
  });

  await test.step('Ana makes a card from Riverside’s home, and its link shows once the relay has it', async () => {
    cardLink = await makeCard(ana, coalition);
  });

  await test.step('Ben pastes the card into the link bar, sees it as plain text, and brings it to Oak St', async () => {
    await bringCardFromBar(ben, cardLink, {
      coalition,
      from: words.riverside,
      to: words.oak,
      yourName: words.benName,
    });
  });

  await test.step('each group passes its own reconcile Proposal', async () => {
    await vote(ben, FOUR);
    const { page } = ana;
    await page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
    await expect(heading(page, `Reconcile into ${words.coalition}`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'The coalition’s statement' })).toContainText(
      `Reconcile with ${words.oak}`,
    );
    await vote(ana, FOUR);
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
    await vote(ben, FOUR);
  });

  await test.step('once Riverside passes it too, the coalition has passed it, to take effect a day after its deadline', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: words.riverside, exact: true }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(words.motionTitle) })
      .click();
    await vote(ana, FOUR);
    const result = page.getByRole('region', { name: 'The coalition’s result' });
    await expect(result).toContainText('The coalition passed this. It takes effect on', {
      timeout: 45_000,
    });
    await expectAccessible(ana, 'a coalition vote’s result');
  });

  const held = [...(await storedGroups(ana.page)), ...(await storedGroups(ben.page))];
  const entries = held.filter((group) => group.kind === 'coalition');
  expect(entries, 'each device holds the one coalition').toHaveLength(2);
  const keys = coalitionKeys(entries, cardLink);

  await test.step('the relay stops, and nothing it kept holds a canary', async () => {
    for (const { page } of [ana, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries: Canary[] = [
      ...Object.entries(words).map(([field, text]) => textCanary(field, text)),
      ...keys.canaries,
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored.
    const controls = scan(files, [textCanary('control', control)]);
    expect(controls.map(({ encoding }) => encoding)).toContain('bytes');
    const ids = keys.mailboxes.map((id) => textCanary('the coalition’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
    const cardId = scan(files, [textCanary('the card’s mailbox id', keys.cardMailbox)]);
    expect(cardId.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
