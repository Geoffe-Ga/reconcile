/**
 * A reconcile card through a front door (#426; ADR-0077 §5), end to end under
 * the deploy CSP and through the real relay. Ben founds Oak St and opens its
 * front door by his own vote; Ana founds Riverside, opens the door's link,
 * and proposes reconciling with Oak St from it, which queues Riverside's
 * reconcile Proposal and leaves the card at the door. The card reaches Oak
 * St's Applications under Groups asking to reconcile, as plain text; Ben
 * brings it to a vote from there, both groups pass, and both homes list the
 * coalition as formed. Every name and the statement are canaries.
 *
 * Every request either browser sends is captured: none carries the card's
 * seed or key, the coalition's secret or keys, or a canary, in any spelling,
 * while the door's inbox and the card's mailbox are named, as the control.
 * The stopped relay's database, WAL, shared memory and log hold none of them,
 * and do hold the inbox's id, so the scan can't pass by reading nothing.
 */
import type { Page, Request } from '@playwright/test';

import { coalitionKeys } from './support/coalition';
import { expect, expectAccessible, heading, type Person, test } from './support/fixtures';
import { type Canary, describeFinding, findIn, scan, tag, textCanary } from './support/scan';
import { found, vote } from './support/steps';
import { derive, storedGroups } from './support/stored';

/** Each founding group's one Document. */
const DOCUMENT = { title: 'House rules', atoms: ['We share tools and a garden.'] };

/** The pill both groups pass with. */
const FOUR = '4 · Strongly supportive';
const PHONE = { width: 390, height: 844 };

/** Keeps every request `page` sends from now on. */
function capture(page: Page, into: Request[]): void {
  page.on('request', (request) => {
    into.push(request);
  });
}

/** A captured request as the scan reads it: its URL, then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

/** The seed of the one card `page`'s device holds at its group's door, once it has read one. */
function heldCardSeed(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const request = <T>(asking: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        asking.onsuccess = () => {
          resolve(asking.result);
        };
        asking.onerror = () => {
          reject(asking.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const db = await request(indexedDB.open('reconcile'));
    try {
      const groups = (await request(db.transaction('groups').objectStore('groups').getAll())) as {
        door?: { cards?: { seed?: string }[] };
      }[];
      const seeds = groups.flatMap((group) => (group.door?.cards ?? []).map((card) => card.seed));
      return seeds.find((seed) => seed !== undefined) ?? null;
    } finally {
      db.close();
    }
  });
}

/** Ben opens his group's front door from Group rules by his own vote, and returns its link. */
async function openTheDoor(person: Person): Promise<string> {
  const { page } = person;
  await page.getByRole('link', { name: /Chat bot and front door/ }).click();
  const rules = page.url();
  const card = page.getByRole('region', { name: 'Front door' });
  await card.getByRole('link', { name: 'Propose turning this on for the front door' }).click();
  await page.getByRole('textbox', { name: 'Why' }).fill('Other groups keep asking.');
  await page.getByRole('button', { name: 'Propose this change' }).click();
  await expect(page.getByRole('region', { name: 'Open a front door' })).toBeVisible();
  await vote(person, FOUR);
  await expect(page.getByText('This passed. Your group’s front door is open.')).toBeVisible();
  await page.goto(rules);
  const field = page.getByRole('region', { name: 'Front door' }).getByRole('textbox', {
    name: 'Front door link',
  });
  await expect(field).toHaveValue(/\/#door\/[\w-]{43}$/);
  return field.inputValue();
}

test('a group proposes reconciling at another’s front door, both pass, and nothing readable leaves', async ({
  openProfile,
  relay,
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
  };
  const requests: Request[] = [];
  const ben = await openProfile('Ben', { viewport: { width: 1280, height: 800 } });
  const ana = await openProfile('Ana', { viewport: PHONE, colorScheme: 'dark' });
  for (const person of [ana, ben]) capture(person.page, requests);
  let link = '';
  let seed = '';

  await test.step('Ben founds Oak St and opens its front door by his vote', async () => {
    await found(ben, { ...DOCUMENT, name: words.oak, founder: 'Ben' });
    link = await openTheDoor(ben);
  });

  await test.step('Ana founds Riverside, opens the door, and proposes reconciling from it', async () => {
    await found(ana, { ...DOCUMENT, name: words.riverside, founder: 'Ana' });
    const { page } = ana;
    await page.goto(link);
    await expect(heading(page, words.oak)).toBeVisible({ timeout: 15_000 });
    const propose = page.getByRole('button', { name: 'Propose reconciling with this group' });
    await expect(propose).toBeVisible();
    await expectAccessible(ana, 'Front door, with Propose reconciling');
    await propose.click();
    await expect(heading(page, 'Propose reconciling')).toBeVisible();
    await expect(page).toHaveTitle('Front door · Reconcile');
    await expect(
      page
        .getByRole('radiogroup', { name: 'Your group' })
        .getByRole('radio', { name: words.riverside }),
    ).toBeChecked();
    await page.getByRole('textbox', { name: 'The coalition’s name' }).fill(words.coalition);
    await page
      .getByRole('textbox', { name: 'Its first statement' })
      .fill(`${words.statement}\n\nWe meet on the first Sunday.`);
    await page.getByRole('textbox', { name: 'Why' }).fill(words.why);
    await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.anaName);
    await expectAccessible(ana, 'Propose reconciling, filled');
    await page.getByRole('button', { name: 'Send the card' }).click();
    await expect(page.getByRole('status')).toHaveText(
      `Your card is at ${words.oak}’s front door. Their members can bring it to a vote for the next 24 to 48 hours.`,
    );
    await expectAccessible(ana, 'Propose reconciling, sent');
  });

  await test.step('the card reaches Oak St’s Applications as plain text, and Ben brings it to a vote', async () => {
    const { page } = ben;
    await page.getByRole('link', { name: words.oak }).click();
    const cards = page.getByRole('list', { name: 'Groups asking to reconcile' });
    await expect(cards.getByText(words.coalition, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(cards.getByText(`From ${words.riverside}`)).toBeVisible();
    await expect(cards.getByText(words.statement)).toBeVisible();
    await expectAccessible(ben, 'Applications, a group asking to reconcile');
    const held = await heldCardSeed(page);
    if (held === null) throw new Error('Expected Ben’s device to hold the card’s seed.');
    seed = held;
    await cards.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.benName);
    await cards.getByRole('button', { name: `Bring it to a vote for ${words.coalition}` }).click();
    await expect(heading(page, `Reconcile into ${words.coalition}`)).toBeVisible();
    await vote(ben, FOUR);
  });

  await test.step('Ana’s group passes its own reconcile Proposal', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
    await expect(heading(page, `Reconcile into ${words.coalition}`)).toBeVisible();
    await vote(ana, FOUR);
  });

  await test.step('both group homes list the coalition as formed, and Oak St lists the card no more', async () => {
    for (const [person, group] of [
      [ana, words.riverside],
      [ben, words.oak],
    ] as const) {
      const { page } = person;
      await page.getByRole('link', { name: group }).click();
      const coalitions = page.getByRole('region', { name: 'Coalitions' });
      await expect(coalitions).toContainText('Formed', { timeout: 45_000 });
      await expect(coalitions).toContainText(`${words.coalition}${words.riverside}, ${words.oak}`);
    }
    await expect(ben.page.getByRole('list', { name: 'Groups asking to reconcile' })).toHaveCount(0);
    expect(await heldCardSeed(ben.page)).toBeNull();
  });

  const address = Buffer.from(new URL(link).hash.slice('#door/'.length), 'base64url');
  const inbox = derive(address, 'reconcile/v1/door-inbox').toString('base64url');
  const held = [...(await storedGroups(ana.page)), ...(await storedGroups(ben.page))];
  const keys = coalitionKeys(
    held.filter((group) => group.kind === 'coalition'),
    `https://reconcile.test/#reconcile/${seed}`,
  );
  const canaries: Canary[] = [
    ...Object.entries(words).map(([field, text]) => textCanary(field, text)),
    ...keys.canaries,
  ];

  await test.step('no request carried the card’s seed or key, a coalition key or a canary', () => {
    const toRelay = requests.filter((r) => new URL(r.url()).pathname.startsWith('/v1/'));
    // The controls: the card went to the door's inbox, sealed and padded, beside its own mailbox.
    const atDoor = toRelay.filter((r) => r.method() === 'PUT' && r.url().includes(inbox));
    expect(atDoor.map((r) => [new URL(r.url()).search, r.postDataBuffer()?.length])).toEqual([
      ['?ttl_days=1', 1024],
    ]);
    expect(toRelay.some((r) => r.method() === 'PUT' && r.url().includes(keys.cardMailbox))).toBe(
      true,
    );
    const findings = requests.flatMap((request) =>
      findIn(bytesOf(request), request.url(), canaries),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });

  await test.step('the stopped relay’s database, WAL, shared memory and log hold no canary', async () => {
    for (const { page } of [ana, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    // The control: the scan reads what the relay stored, the inbox's id among it.
    const stored = scan(files, [textCanary('the door’s inbox id', inbox)]);
    expect(stored.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
