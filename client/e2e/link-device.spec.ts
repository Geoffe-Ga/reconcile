/**
 * Link a second device (#96), end to end through the real relay and the
 * deploy CSP, by the paste path (no camera).
 *
 * Ana founds a group with a canary in every field from her phone, Ben joins,
 * and Ana proposes. Her phone (dark theme) opens Link a new device; her
 * laptop, a fresh profile past the pilot notice, opens Link to my other
 * device from Start and pastes the code. Both show the same number, which
 * Node's own X25519 and HKDF compute too, from the one-time keys each page
 * made. Only the phone confirms. The laptop then holds Ana's log, shows the
 * same Document, and the two vote, the phone first: Ben's tally counts one
 * voter, with the laptop's later ballot.
 *
 * Every request either device sent is kept, and none holds the seed, K, a
 * one-time key, the pairing seal key, the group secret, Ana's signing key or
 * her encryption key (#98), raw, in hex or in base64url; the pairing mailbox id, which a request must
 * carry, is the scan's control. Then the relay stops, and its database, WAL,
 * shared memory and log hold no canary from the bundle. axe checks each
 * linking screen.
 */
import { statSync } from 'node:fs';

import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  pick,
  type Person,
  test,
} from './support/fixtures';
import { codeParts, findLinkKeys, randomsOf, RANDOM_NAME, recordRandom } from './support/link';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  scan,
  textCanary,
} from './support/scan';
import { onlyGroup, type StoredGroup, storedLogs } from './support/stored';

const CANARY = {
  group: 'Canary Linked Commons',
  founder: 'Canaryana Linker',
  joiner: 'Canarybenedict Joiner',
  atom: 'Canary atom: the bundle never shows the relay this.',
  title: 'Canary title: link the laptop',
};
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };

/** One request a device sent: its URL and body, as the relay received them. */
interface Sent {
  readonly url: string;
  readonly body: Buffer;
}

/** Keeps every request `person`'s profile sends. */
function captureRequests(person: Person, into: Sent[]): void {
  person.page.context().on('request', (request: Request) => {
    into.push({ url: request.url(), body: request.postDataBuffer() ?? Buffer.alloc(0) });
  });
}

/** From Start, `person` scores the Proposal `pill` from the list `region` on Group home, and waits for Sent. */
async function vote(person: Person, pill: string, region: string): Promise<void> {
  const { page } = person;
  await page.goto('/#/');
  await page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
  const listed = page.getByRole('region', { name: region });
  await listed.getByRole('link', { name: new RegExp(CANARY.title) }).click();
  await pick(page, pill);
  await page.getByRole('button', { name: /your vote$/ }).click();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
}

/** The six digits on `page`'s number card. */
async function shownNumber(page: Page): Promise<string> {
  const digits = await page.locator('.link-number').textContent();
  return (digits ?? '').replace(/\s/g, '');
}

test('a second device links by a pasted code, the relay learns nothing, and both vote as one person', async ({
  openProfile,
  relay,
}) => {
  const phone = await openProfile('Ana’s phone', { viewport: PHONE, colorScheme: 'dark' });
  const laptop = await openProfile('Ana’s laptop', { viewport: LAPTOP });
  const ben = await openProfile(CANARY.joiner, { viewport: LAPTOP });
  const sent: Sent[] = [];
  for (const device of [phone, laptop]) {
    await device.page.context().addInitScript(recordRandom, RANDOM_NAME);
    captureRequests(device, sent);
  }

  await test.step('Ana founds the group from her phone, Ben joins, and Ana proposes', async () => {
    await phone.page.goto('/');
    await acceptNotice(phone);
    const invite = await foundGroup(phone.page, {
      name: CANARY.group,
      title: 'Our garden',
      atoms: [CANARY.atom, 'Bins go out on Tuesday.'],
      founder: CANARY.founder,
    });
    await ben.page.goto(invite);
    await acceptNotice(ben);
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(CANARY.joiner);
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(heading(ben.page, CANARY.group)).toBeVisible();
    const people = phone.page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText(CANARY.joiner);
    await phone.page.getByRole('link', { name: 'Our garden' }).click();
    await phone.page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await phone.page.getByRole('textbox', { name: 'Title' }).fill(CANARY.title);
    await phone.page.getByRole('textbox', { name: 'Why' }).fill('Mornings are cooler.');
    await phone.page.getByRole('textbox', { name: 'New text' }).fill('The garden opens at six.');
    await phone.page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(phone.page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
  });

  const code = await test.step('the phone opens Link a new device from Settings', async () => {
    const { page } = phone;
    await page.goto('/#/');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page
      .getByRole('region', { name: 'Link a new device' })
      .getByRole('link', { name: 'Link a new device' })
      .click();
    await expect(heading(page, 'Link a new device')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Linking code' })).toBeVisible();
    await expect(page.getByText('Waiting for your new device…')).toBeVisible();
    await expectAccessible(phone, 'Link a new device, its code');
    const text = (await page.locator('.qr-text').textContent()) ?? '';
    expect(text).toMatch(/^RL1\.[A-Za-z0-9_-]{86}$/);
    return text;
  });

  await test.step('a fresh laptop, past the pilot notice, pastes the code from Start', async () => {
    const { page } = laptop;
    await page.goto('/');
    await acceptNotice(laptop);
    await page.getByRole('link', { name: 'Link to my other device' }).click();
    await expect(heading(page, 'Link to your other device')).toBeVisible();
    await expectAccessible(laptop, 'Link to your other device');
    await page.getByRole('textbox', { name: 'Code from your other device' }).fill(code);
    await page.getByRole('button', { name: 'Link this device' }).click();
    await expect(
      page.getByText('Check that your other device shows the same number, then confirm there.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Match' })).toHaveCount(0);
    await expectAccessible(laptop, 'Link to your other device, its number');
  });

  const keys =
    await test.step('both show the number Node computes, and only the phone confirms', async () => {
      await expect(
        phone.page.getByText('Does your new device show the same number?'),
      ).toBeVisible();
      await expectAccessible(phone, 'Link a new device, its number');
      const onPhone = await shownNumber(phone.page);
      expect(onPhone).toMatch(/^[0-9]{6}$/);
      expect(await shownNumber(laptop.page)).toBe(onPhone);
      const found = findLinkKeys(
        code,
        onPhone,
        await randomsOf(phone.page),
        await randomsOf(laptop.page),
      );
      expect(found.secrets.number).toBe(onPhone);

      await phone.page.getByRole('button', { name: 'Match', exact: true }).click();
      await expect(
        phone.page.getByText('Sent. Your new device is adding your groups.'),
      ).toBeVisible();
      await expect(laptop.page.getByText('Linked. This device now has 1 group.')).toBeVisible();
      await expectAccessible(laptop, 'Link to your other device, linked');
      return found;
    });

  await test.step('the laptop holds Ana’s log and shows the same Document', async () => {
    await expect
      .poll(async () => JSON.stringify(await storedLogs(laptop.page)))
      .toBe(JSON.stringify(await storedLogs(phone.page)));
    // The same member (#98): the same keys and epoch, so the laptop opens what the phone opens.
    // Each keeps the relay minute its own last pass read, which can differ by one (#361).
    const member = (group: StoredGroup) => ({ ...group, relayNow: null });
    expect(member(await onlyGroup(laptop.page))).toEqual(member(await onlyGroup(phone.page)));
    const { page } = laptop;
    await page.getByRole('link', { name: 'Your groups' }).first().click();
    await page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
    await page.getByRole('link', { name: 'Our garden' }).click();
    await expect(page.getByText(CANARY.atom)).toBeVisible();
  });

  await test.step('both vote, and the tally counts one voter with the later ballot', async () => {
    await vote(phone, '1 · Opposed', 'Needs your vote');
    // The laptop is the same person, so once it syncs the phone's ballot, nothing needs its vote.
    await vote(laptop, '4 · Strongly supportive', 'Open Proposals');
    const { page } = ben;
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: new RegExp(CANARY.group) }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(CANARY.title) })
      .click();
    const meter = page.getByRole('group', { name: 'How version 1 stands so far' });
    // One voter, Ana, whose later ballot (4, from the laptop) replaced the phone's 1.
    await expect(meter).toContainText('Scored by 1 · needs 2');
    await expect(meter).toContainText('4.0 · Passes');
  });

  const held = await onlyGroup(phone.page);
  expect(held.kxKey).toHaveLength(32);
  const { seed } = codeParts(code);
  const secrets: Canary[] = [
    ...keyCanaries('the link seed', seed),
    ...keyCanaries('K', keys.secrets.key),
    ...keyCanaries('e_A', keys.secretA),
    ...keyCanaries('e_B', keys.secretB),
    ...keyCanaries('the pairing seal key', keys.secrets.pairingKey),
    ...keyCanaries('the group secret', Uint8Array.from(held.secret)),
    ...keyCanaries('Ana’s signing key', Uint8Array.from(held.signingKey)),
    ...keyCanaries('Ana’s encryption key', Uint8Array.from(held.kxKey ?? [])),
  ];

  await test.step('no request either device sent holds the seed, K or a key', () => {
    const findings = sent.flatMap(({ url, body }, i) => [
      ...findIn(Buffer.from(url), `request ${String(i)} URL`, secrets),
      ...findIn(body, `request ${String(i)} body`, secrets),
    ]);
    expect(findings.map(describeFinding)).toEqual([]);
    // The control: the handshake's requests name the pairing mailbox, and the bundle's its own.
    const urls = sent.map(({ url }) => url).join('\n');
    expect(urls).toContain(`/v1/mailbox/${keys.secrets.pairingMailbox}`);
    expect(urls).toContain(`/v1/mailbox/${keys.secrets.bundleMailbox}`);
  });

  await test.step('the relay stops, and nothing it kept holds a canary from the bundle', async () => {
    for (const { page } of [phone, laptop, ben]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(statSync(relay.db).size).toBeGreaterThan(0);
    const canaries: Canary[] = [
      ...Object.entries(CANARY).map(([field, text]) => textCanary(field, text)),
      ...secrets,
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    // The control: the relay kept the bundle's mailbox id, so the scan read what it stored.
    const control = scan(files, [textCanary('the bundle mailbox id', keys.secrets.bundleMailbox)]);
    expect(control.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
