/**
 * A coalition's room (#125), in two browser profiles through the real relay:
 * Ana founds Riverside and Ben Oak St, they reconcile into a coalition by a
 * card, each group passes, and both open the coalition's room from its home.
 * Ana writes, Ben reads her message under her coalition name and answers
 * with a script in it, which Ana reads as text, both in the same order. axe
 * runs on the coalition's home and on the room, empty and with messages.
 *
 * Then the relay stops, and its database, WAL, shared memory and log are
 * scanned for every canary: both messages, both coalition names, the room's
 * `inner`, seal key and entry id, and each coalition key that signs there, in
 * every encoding. A readable control blob and the room's weekly mailbox ids,
 * derived from `inner` by Node's own crypto, must all turn up, so the scan
 * can't pass by reading nothing.
 *
 * Messages leaving a device after 30 days, followers never holding `inner`,
 * and a leaver's device purging the room are the unit tests' (`src/store/
 * sync.rooms.test.ts`, `src/app/roomFlow.test.tsx`): these specs never move
 * the relay's clock, and followers are #124's.
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

/** From `group`'s home, opens the coalition's home, then its room. */
async function openRoom(person: Person, group: string, coalition: string): Promise<void> {
  const { page } = person;
  await page.getByRole('link', { name: group, exact: true }).click();
  const coalitions = page.getByRole('region', { name: 'Coalitions' });
  await expect(coalitions).toContainText('Formed', { timeout: 45_000 });
  await coalitions.getByRole('link', { name: 'Open the coalition' }).click();
  await expect(heading(page, coalition)).toBeVisible();
  const entry = page.getByRole('region', { name: 'Room' });
  await expect(entry).toContainText('Only the member groups can read it.');
  await expectAccessible(person, 'the coalition’s home with its room');
  await entry.getByRole('link', { name: /Open the room/ }).click();
  await expect(heading(page, coalition)).toBeVisible();
  await expect(page).toHaveURL(/#\/c\/[\w-]{43}\/room$/);
}

/**
 * Writes `text` in the room's box and sends it, then waits for the relay to
 * have it and for the room to list the relay's copy: a sent message leaves the
 * outbox a moment before the pull that brings it back is saved.
 */
async function write(person: Person, text: string): Promise<void> {
  const { page } = person;
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  const list = page.getByRole('list', { name: 'Messages' });
  await expect(list.getByText(text, { exact: true })).toBeVisible();
  await expect(list.getByText('Sending…')).toHaveCount(0, { timeout: 45_000 });
  await expect(list.getByText(text, { exact: true })).toBeVisible({ timeout: 45_000 });
}

/** The room's messages on `page`, each as "name: text". */
function listed(person: Person): Promise<string[]> {
  return person.page
    .getByRole('list', { name: 'Messages' })
    .getByRole('listitem')
    .evaluateAll((items) =>
      items.map(
        (item) =>
          `${item.querySelector('.room-author')?.textContent ?? ''}: ${
            item.querySelector('.room-text')?.textContent ?? ''
          }`,
      ),
    );
}

test('two groups’ people talk in their coalition’s room, and the relay keeps none of it readable', async ({
  openProfile,
  relay,
  request,
}) => {
  const run = tag();
  const words = {
    riverside: `Riverside ${run}`,
    oak: `Oak St ${run}`,
    coalition: `Eastside ${run}`,
    anaName: `CANARY-MARA-${run}`,
    benName: `CANARY-JO-${run}`,
    first: `CANARY-ROOM-FIRST-${run} Can we meet Thursday?`,
    reply: `CANARY-ROOM-REPLY-${run} <script>document.title="pwned"</script>\nAfter six.`,
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

  await test.step('Ana founds Riverside and makes a card; Ben founds Oak St and brings it', async () => {
    await found(ana, words.riverside, 'Ana');
    await found(ben, words.oak, 'Ben');
    const { page } = ana;
    await page
      .getByRole('region', { name: 'Coalitions' })
      .getByRole('link', { name: /Reconcile with another group/ })
      .click();
    await page.getByRole('textbox', { name: 'The coalition’s name' }).fill(words.coalition);
    await page
      .getByRole('textbox', { name: 'Its first statement' })
      .fill('Everyone on the east side has a safe home.');
    await page.getByRole('textbox', { name: 'Why' }).fill('We share a landlord.');
    await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.anaName);
    await page.getByRole('button', { name: 'Make the card' }).click();
    const link = page.getByRole('textbox', { name: 'Card link' });
    await expect(link).toHaveValue(/#reconcile\/[A-Za-z0-9_-]{43}$/);
    cardLink = await link.inputValue();

    await visit(ben.page, cardLink);
    await expect(heading(ben.page, words.coalition)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(words.benName);
    await ben.page.getByRole('button', { name: 'Bring to my group' }).click();
    await expect(heading(ben.page, `Reconcile into ${words.coalition}`)).toBeVisible();
  });

  await test.step('each group passes its own reconcile Proposal', async () => {
    await passes(ben);
    await ana.page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
    await expect(heading(ana.page, `Reconcile into ${words.coalition}`)).toBeVisible();
    await passes(ana);
  });

  await test.step('Ana opens the empty room from the coalition’s home, and writes', async () => {
    await openRoom(ana, words.riverside, words.coalition);
    const { page } = ana;
    await expect(page.getByText('No messages yet.')).toBeVisible();
    await expect(page.getByText('Each device deletes a message 30 days after')).toBeVisible();
    await expectAccessible(ana, 'the empty room');
    await write(ana, words.first);
    expect(await listed(ana)).toEqual([`${words.anaName}: ${words.first}`]);
  });

  await test.step('Ben reads it under Ana’s coalition name, and answers with a script in it', async () => {
    await openRoom(ben, words.oak, words.coalition);
    const { page } = ben;
    const list = page.getByRole('list', { name: 'Messages' });
    await expect(list.getByText(words.first)).toBeVisible({ timeout: 45_000 });
    await write(ben, words.reply);
    await expectAccessible(ben, 'the room with messages');
  });

  await test.step('Ana reads the answer as text, and both show the same messages in the same order', async () => {
    const { page } = ana;
    const list = page.getByRole('list', { name: 'Messages' });
    await expect(list.getByText('After six.', { exact: false })).toBeVisible({ timeout: 45_000 });
    const order = [`${words.anaName}: ${words.first}`, `${words.benName}: ${words.reply}`];
    expect(await listed(ana)).toEqual(order);
    expect(await listed(ben)).toEqual(order);
    for (const { page: each } of [ana, ben]) {
      expect(await each.title()).toBe('Room · Reconcile');
      await expect(each.locator('main script')).toHaveCount(0);
    }
    await expectAccessible(ana, 'the room with an answer');
  });

  const held = [...(await storedGroups(ana.page)), ...(await storedGroups(ben.page))];
  const rooms = held.filter((group) => group.kind === 'room');
  const [room] = rooms;
  if (room === undefined || rooms.length !== 2) throw new Error('Expected each device’s room.');
  const inner = Uint8Array.from(room.secret);
  expect(Uint8Array.from(rooms[1]?.secret ?? [])).toEqual(inner);
  const coalitionKeys = held.filter((group) => group.kind === 'coalition');

  await test.step('the relay stops, and nothing it kept holds a word of the room or a key to it', async () => {
    for (const { page } of [ana, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries: Canary[] = [
      textCanary('the first message', words.first),
      textCanary('the answer', words.reply.slice(0, 40)),
      textCanary('Ana’s coalition name', words.anaName),
      textCanary('Ben’s coalition name', words.benName),
      ...keyCanaries('inner', inner),
      ...keyCanaries('the room’s seal key', derive(inner, 'reconcile/v1/seal-key')),
      ...keyCanaries('the room’s entry id', Buffer.from(room.groupId, 'base64url')),
      ...coalitionKeys.flatMap((each, i) =>
        keyCanaries(`coalition key ${String(i + 1)}`, Uint8Array.from(each.signingKey)),
      ),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored, the room's mailboxes included.
    const controls = scan(files, [textCanary('control', control)]);
    expect(controls.map(({ encoding }) => encoding)).toContain('bytes');
    const ids = groupMailboxes(inner).map((id) => textCanary('the room’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
  });
});
