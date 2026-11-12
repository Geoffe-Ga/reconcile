/**
 * A group's front door (#121), end to end under the deploy CSP and through
 * the real relay. Ana founds a group, Ben (on a phone, in the dark theme) and
 * Cal join, every name a canary. Ana proposes opening a front door from
 * Group rules and everyone votes it through at the entrenched bar, which
 * closes early once all three have scored; nothing moves time. Kim, a
 * stranger in a fresh profile, opens the link Group rules gives, accepts the
 * pilot notice, reads the page (the group's name and an excerpt, never a
 * member's name) and asks to join. Her request reaches Ana's Applications
 * sealed; Ana sends an invite, Ben reads "Invited by", and Kim's Your groups
 * says the group invited her and leads into Join, after which she waits for
 * vouches like any newcomer.
 *
 * Every request the four browsers send is captured: none carries the
 * group's secret, a member's name or key, the door's secrets, Kim's reply
 * seed or key, or her words, in any spelling, while the door's inbox and the
 * reply mailbox are named, as the control. The stopped relay's database,
 * WAL, shared memory and log hold no canary, and do hold the inbox's id, so
 * the scan can't pass by reading nothing. axe runs on every screen.
 */
import { randomBytes } from 'node:crypto';

import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
} from './support/fixtures';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  scan,
  textCanary,
} from './support/scan';
import { derive, onlyGroup, storedGroups, storedLogs } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const GROUP = 'Riverside Tenants';
const NAMES = { ana: `Ana${TAG}`, ben: `Ben${TAG}`, cal: `Cal${TAG}` };
const APPLICANT = `Kim${TAG}`;
const MESSAGE = `I live at number 12 and fix bikes on Sundays, canary ${TAG}.`;
const EXCERPT = 'We keep rents fair and homes safe on Riverside Ave.';
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

/** `person` joins from `invite` as a Co-Creator, under their canary name. */
async function join(person: Person, invite: string): Promise<void> {
  const { page } = person;
  await page.goto(invite);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await pick(page, 'Co-Creator');
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText(
    person.name,
  );
}

/** `person` scores the Proposal at `url` 4 and sends it. */
async function vote(person: Person, url: string): Promise<void> {
  const { page } = person;
  await page.goto(url);
  await pick(page, '4 · Strongly supportive');
  await page.getByRole('button', { name: 'Send your vote' }).click();
  await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
}

/** The front door's card on Group rules. */
function doorCard(page: Page) {
  return page.getByRole('region', { name: 'Front door' });
}

/** An event as a stored record carries it: the bytes after the key and signature, as JSON. */
interface StoredEvent {
  readonly type: string;
  readonly body: { readonly target?: { readonly optIn?: string; readonly value?: unknown } };
}

/** The door a rules Proposal's record opens, or null for any other record. */
function doorIn(hex: string): { sign: string; box: string } | null {
  const event = JSON.parse(Buffer.from(hex, 'hex').subarray(96).toString('utf8')) as StoredEvent;
  const target = event.body.target;
  if (event.type !== 'proposal' || target?.optIn !== 'frontDoor') return null;
  const value = target.value as { sign?: unknown; box?: unknown } | false;
  return value !== false && typeof value.sign === 'string' && typeof value.box === 'string'
    ? { sign: value.sign, box: value.box }
    : null;
}

/** The door's two secrets, read from the rules Proposal in `page`'s stored log. */
async function doorSecrets(page: Page): Promise<{ sign: Buffer; box: Buffer }> {
  const [log] = await storedLogs(page);
  const [door] = (log?.log ?? []).flatMap(([, , hex]) => {
    const found = doorIn(hex);
    return found === null ? [] : [found];
  });
  if (door === undefined) throw new Error('Expected the door’s Proposal.');
  return { sign: Buffer.from(door.sign, 'base64url'), box: Buffer.from(door.box, 'base64url') };
}

/** The application Kim's device keeps: its reply seed and key, and any invite's seed. */
function sentApplication(
  page: Page,
): Promise<{ seed: number[]; replyKey: number[]; invite: number[] | null } | null> {
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
      const all = (await request(db.transaction('sent').objectStore('sent').getAll())) as {
        seed: Uint8Array;
        replyKey: Uint8Array;
        invite?: Uint8Array;
      }[];
      const [sent] = all;
      return sent === undefined
        ? null
        : {
            seed: Array.from(sent.seed),
            replyKey: Array.from(sent.replyKey),
            invite: sent.invite === undefined ? null : Array.from(sent.invite),
          };
    } finally {
      db.close();
    }
  });
}

test('a group opens its front door by vote, and a stranger asks, is invited and joins', async ({
  openProfile,
  relay,
}) => {
  const requests: Request[] = [];
  const ana = await openProfile(NAMES.ana, { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile(NAMES.ben, { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile(NAMES.cal);
  for (const person of [ana, ben, cal]) capture(person.page, requests);
  let rulesUrl = '';
  let link = '';

  await test.step('Ana founds the group, and Ben and Cal join', async () => {
    const { page } = ana;
    await page.goto('/#/create');
    await acceptNotice(ana);
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page.getByRole('textbox', { name: 'Document title' }).fill('House rules');
    await page
      .getByRole('textbox', { name: 'Document text' })
      .fill(`${EXCERPT}\n\nBins out on Sunday.`);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
    await join(ben, invite);
    await join(cal, invite);
  });

  await test.step('Ana proposes opening a front door, and everyone votes it through', async () => {
    const { page } = ana;
    const people = page.getByRole('region', { name: 'People', exact: true });
    await expect(people).toContainText(cal.name);
    await expect(people).toContainText(ben.name);
    await page.getByRole('link', { name: /Chat bot and front door/ }).click();
    rulesUrl = page.url();
    await doorCard(page)
      .getByRole('link', { name: 'Propose turning this on for the front door' })
      .click();
    await expect(heading(page, 'Open a front door')).toBeVisible();
    const count = page.getByRole('checkbox', { name: 'Show how many people are in the group' });
    await expect(count).not.toBeChecked();
    await page.getByRole('textbox', { name: 'Why' }).fill('People keep asking how to join.');
    await expectAccessible(ana, 'Opt-in composer, front door');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('region', { name: 'Open a front door' })).toBeVisible();
    const proposalUrl = page.url();
    await vote(ana, proposalUrl);
    await vote(cal, proposalUrl);
    await vote(ben, proposalUrl);
    await expect(ben.page.getByText('This passed. Your group’s front door is open.')).toBeVisible();
  });

  await test.step('Group rules gives the door’s link, and says the count stays hidden', async () => {
    const { page } = ana;
    await page.goto(rulesUrl);
    const field = doorCard(page).getByRole('textbox', { name: 'Front door link' });
    await expect(field).toHaveValue(/\/#door\/[\w-]{43}$/);
    link = await field.inputValue();
    await expect(
      doorCard(page).getByText('It doesn’t show how many people are in your group.'),
    ).toBeVisible();
    await expectAccessible(ana, 'Group rules, front door open');
  });

  const kim = await openProfile(APPLICANT, { viewport: PHONE });
  capture(kim.page, requests);

  await test.step('Kim opens the link, accepts the notice, and reads the page: no member’s name', async () => {
    const { page } = kim;
    await page.goto(link);
    await acceptNotice(kim);
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(page.getByText(EXCERPT)).toBeVisible();
    await expect(page).toHaveTitle('Front door · Reconcile');
    for (const name of Object.values(NAMES)) await expect(page.getByText(name)).toHaveCount(0);
    await expect(page.getByText(/people are in this group/)).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe(new URL(link).hash);
    await expectAccessible(kim, 'Front door');
  });

  await test.step('she asks to join, with no contact field, and the page says what comes next', async () => {
    const { page } = kim;
    await expect(page.getByRole('textbox')).toHaveCount(2);
    await page.getByRole('textbox', { name: 'Name you’d like to use' }).fill(APPLICANT);
    await page.getByRole('textbox', { name: 'Why you’d like to join' }).fill(MESSAGE);
    await expect(
      page.getByText('Don’t include anything you wouldn’t want this group to read.'),
    ).toBeVisible();
    await expectAccessible(kim, 'Front door form, filled');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('status')).toHaveText(
      `Sent. If someone in ${GROUP} invites you, it shows on Your groups.`,
    );
    await expectAccessible(kim, 'Front door, sent');
  });

  await test.step('her request reaches Ana’s Applications, and Ana sends an invite', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: GROUP }).click();
    const applications = page.getByRole('region', { name: 'Applications' });
    await expect(applications.getByText(MESSAGE)).toBeVisible({ timeout: 15_000 });
    await expect(applications.getByText(APPLICANT, { exact: true })).toBeVisible();
    await expectAccessible(ana, 'Applications');
    await applications.getByRole('button', { name: `Send an invite to ${APPLICANT}` }).click();
    await expect(
      applications.getByText('Invite sent. It waits 2 days for their device.'),
    ).toBeVisible();
  });

  await test.step('Ben, on his phone, reads who invited her', async () => {
    const { page } = ben;
    await page.goto(rulesUrl.replace(/\/rules$/, ''));
    const applications = page.getByRole('region', { name: 'Applications' });
    await expect(applications.locator('.application-invited')).toHaveText(
      `Invited by ${ana.name}`,
      { timeout: 15_000 },
    );
    await expect(
      applications.getByRole('button', { name: `Send an invite to ${APPLICANT}` }),
    ).toHaveCount(0);
    await expectAccessible(ben, 'Applications on a phone, invited');
  });

  let sent: Awaited<ReturnType<typeof sentApplication>> = null;
  await test.step('Kim’s Your groups says the group invited her, and she joins', async () => {
    const { page } = kim;
    await page.goto('/');
    const asked = page.getByRole('region', { name: 'Asked to join' });
    await expect(asked.locator('.request-invited')).toHaveText(`${GROUP} invited you`, {
      timeout: 15_000,
    });
    sent = await sentApplication(page);
    expect(sent?.invite).toHaveLength(32);
    await expectAccessible(kim, 'Your groups, invited');
    await asked.getByRole('button', { name: 'Open your invite' }).click();
    await page.getByRole('textbox', { name: 'Your name' }).fill('Kim');
    await page.getByRole('button', { name: 'Join group' }).click();
    await expect(page).toHaveURL(/#\/g\/[A-Za-z0-9_-]+$/);
    await expect(
      page.getByText(
        /^You can vote on Proposals that open after .+, once 2 people vouch for you\.$/,
      ),
    ).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Asked to join' })).toHaveCount(0);
  });

  const address = Buffer.from(new URL(link).hash.slice('#door/'.length), 'base64url');
  const inbox = derive(address, 'reconcile/v1/door-inbox').toString('base64url');
  const secrets = await doorSecrets(ana.page);
  const group = await onlyGroup(ana.page);
  const groupSecret = Uint8Array.from(group.secret);
  const textCanaries = [
    textCanary('application message', MESSAGE),
    textCanary('applicant name', APPLICANT),
    ...Object.entries(NAMES).map(([who, name]) => textCanary(`${who}'s name`, name)),
  ];

  await test.step('no request carried a group secret, a member’s name or key, a door secret, the reply seed or key, or her words', async () => {
    if (sent === null) throw new Error('Expected Kim’s application.');
    const memberKeys: Canary[] = [];
    for (const person of [ana, ben, cal, kim]) {
      for (const held of await storedGroups(person.page)) {
        memberKeys.push(
          ...keyCanaries(`${person.name}'s signing key`, Uint8Array.from(held.signingKey)),
        );
        if (held.kxKey !== null) {
          memberKeys.push(
            ...keyCanaries(`${person.name}'s encryption key`, Uint8Array.from(held.kxKey)),
          );
        }
      }
    }
    const canaries: Canary[] = [
      ...keyCanaries('group secret', groupSecret),
      ...keyCanaries('group seal key', derive(groupSecret, 'reconcile/v1/seal-key')),
      ...memberKeys,
      ...keyCanaries('door sign secret', secrets.sign),
      ...keyCanaries('door box secret', secrets.box),
      ...keyCanaries('reply seed', Uint8Array.from(sent.seed)),
      ...keyCanaries('reply secret key', Uint8Array.from(sent.replyKey)),
      ...textCanaries,
    ];
    const toRelay = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/v1/'),
    );
    // The controls: Kim's request went to the inbox, sealed and padded, and the invite to her reply mailbox.
    const replyMailbox = derive(Uint8Array.from(sent.seed), 'reconcile/v1/door-reply').toString(
      'base64url',
    );
    const asked = toRelay.filter((r) => r.method() === 'PUT' && r.url().includes(inbox));
    expect(asked).toHaveLength(1);
    expect([1024, 4096, 16384, 65536]).toContain(asked[0]?.postDataBuffer()?.length);
    expect(toRelay.some((r) => r.method() === 'PUT' && r.url().includes(replyMailbox))).toBe(true);
    const findings = requests.flatMap((request) =>
      findIn(bytesOf(request), request.url(), canaries),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });

  await test.step('the stopped relay’s database, WAL, shared memory and log hold no canary', async () => {
    for (const person of [ana, ben, cal, kim]) await person.page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries = [
      ...textCanaries,
      ...keyCanaries('door sign secret', secrets.sign),
      ...keyCanaries('door box secret', secrets.box),
      ...keyCanaries('group secret', groupSecret),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    // The control: the scan reads what the relay stored, the inbox's id among it.
    const stored = scan(files, [textCanary('the door’s inbox id', inbox)]);
    expect(stored.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
