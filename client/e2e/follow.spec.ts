/**
 * Following a coalition (#124), in three browser profiles through the real
 * relay: Ana founds Riverside and Ben founds Oak St, they reconcile by a card
 * and both groups pass, then Ana shares a follow link from the coalition's
 * home. Fay, on a profile that never opened Reconcile and is in neither
 * group, opens it, meets the pilot notice, reads the preview as plain text
 * and follows. Her coalition home reads as a follower's: Dispatches,
 * Documents and Decided, nothing to propose or take part in. axe runs on the
 * share, the preview and Fay's home and Document.
 *
 * Every request Fay's browser sends is captured: none carries the
 * coalition's secret, its seal key, `inner`, a seat secret, or the link's
 * seed or key, while the follow mailbox's id, the one name the relay needs,
 * does turn up. Fay's IndexedDB holds the coalition's secret but no `inner`
 * or seat secret. Then she unfollows, and her IndexedDB holds no coalition
 * entry, secret or name.
 *
 * Then the relay stops, and its database, WAL, shared memory and log are
 * scanned for every canary, in every encoding: the coalition's name and
 * statement, both group names, both coalition names, its secret and seal
 * key, `inner` and both seat secrets, and the link's seed and key. A readable
 * control blob, the coalition's weekly mailbox ids and the follow mailbox's
 * id must all turn up, so the scan can't pass by reading nothing.
 *
 * A Dispatch reaching Fay isn't here: a coalition's goes out only a week
 * after its motion's deadline (#100), and these specs never move the clock,
 * so `src/app/followFlow.test.tsx` covers it on a fake relay.
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
  visit,
} from './support/fixtures';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  scan,
  textCanary,
} from './support/scan';
import { derive, groupMailboxes, storedGroups, storedLogs } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const WORDS = {
  riverside: `CANARY-GROUP-A-${TAG}`,
  oak: `CANARY-GROUP-B-${TAG}`,
  coalition: `CANARY-COALITION-${TAG}`,
  statement: `CANARY-STATEMENT-${TAG}`,
  why: `CANARY-WHY-${TAG}`,
  anaName: `CANARY-ANA-IN-COALITION-${TAG}`,
  benName: `CANARY-BEN-IN-COALITION-${TAG}`,
};

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

/** Riverside and Oak St reconcile into the canary coalition, and both group homes say it formed. */
async function reconcile(ana: Person, ben: Person): Promise<void> {
  await found(ana, WORDS.riverside, 'Ana');
  await found(ben, WORDS.oak, 'Ben');
  const { page } = ana;
  const coalitions = page.getByRole('region', { name: 'Coalitions' });
  await coalitions.getByRole('link', { name: /Reconcile with another group/ }).click();
  await page.getByRole('textbox', { name: 'The coalition’s name' }).fill(WORDS.coalition);
  await page
    .getByRole('textbox', { name: 'Its first statement' })
    .fill(`${WORDS.statement}\n\nWe meet on the first Sunday.`);
  await page.getByRole('textbox', { name: 'Why' }).fill(WORDS.why);
  await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(WORDS.anaName);
  await page.getByRole('button', { name: 'Make the card' }).click();
  const card = await page.getByRole('textbox', { name: 'Card link' }).inputValue();

  await visit(ben.page, card);
  await expect(heading(ben.page, WORDS.coalition)).toBeVisible();
  await ben.page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(WORDS.benName);
  await ben.page.getByRole('button', { name: 'Bring to my group' }).click();
  await expect(heading(ben.page, `Reconcile into ${WORDS.coalition}`)).toBeVisible();
  await passes(ben);
  await page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
  await expect(heading(page, `Reconcile into ${WORDS.coalition}`)).toBeVisible();
  await passes(ana);
  for (const [person, group] of [
    [ana, WORDS.riverside],
    [ben, WORDS.oak],
  ] as const) {
    await person.page.getByRole('link', { name: group }).click();
    const region = person.page.getByRole('region', { name: 'Coalitions' });
    await expect(region).toContainText('Formed', { timeout: 45_000 });
  }
}

/** Keeps every request `page` sends from now on. */
function capture(page: Page, into: Request[]): void {
  page.on('request', (request) => {
    into.push(request);
  });
}

/** A captured request as a scan reads it: its URL, then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

/** Everything the app's IndexedDB on `page` holds, every byte array and string, end to end. */
async function rawStore(page: Page): Promise<Buffer> {
  const parts = await page.evaluate(async () => {
    const request = <T>(asking: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        asking.onsuccess = () => {
          resolve(asking.result);
        };
        asking.onerror = () => {
          reject(asking.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const found: number[][] = [];
    const walk = (value: unknown): void => {
      if (value instanceof Uint8Array) found.push(Array.from(value));
      else if (typeof value === 'string') found.push(Array.from(new TextEncoder().encode(value)));
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          walk(key);
          walk(item);
        }
      }
    };
    const db = await request(indexedDB.open('reconcile'));
    try {
      for (const name of Array.from(db.objectStoreNames)) {
        walk(await request(db.transaction(name).objectStore(name).getAll()));
        walk(await request(db.transaction(name).objectStore(name).getAllKeys()));
      }
    } finally {
      db.close();
    }
    return found;
  });
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

/** A reconcile Proposal's secrets, read from a group's stored log: its `inner` and seat secret. */
interface ReconcileSecrets {
  readonly inner: Buffer;
  readonly seat: Buffer;
}

/** The reconcile Proposal's secrets in the one group log on `page` that holds one. */
async function reconcileSecrets(page: Page): Promise<ReconcileSecrets> {
  for (const { log } of await storedLogs(page)) {
    for (const [, , hex] of log) {
      const event = JSON.parse(Buffer.from(hex, 'hex').subarray(96).toString('utf8')) as {
        type: string;
        body: { target?: { kind?: string; inner?: string; seat?: string } };
      };
      const target = event.body.target;
      if (event.type === 'proposal' && target?.kind === 'reconcile') {
        return {
          inner: Buffer.from(target.inner ?? '', 'base64url'),
          seat: Buffer.from(target.seat ?? '', 'base64url'),
        };
      }
    }
  }
  throw new Error('Expected a reconcile Proposal in a group’s log.');
}

test('a participant shares a follow link, a stranger follows and unfollows, and nothing leaks', async ({
  openProfile,
  relay,
  request,
}) => {
  const control = `CONTROL-${randomBytes(6).toString('hex')}`;
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const fay = await openProfile('Fay');
  const sent: Request[] = [];
  let followLink = '';

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

  await test.step('Riverside and Oak St reconcile, and the coalition forms', async () => {
    await reconcile(ana, ben);
  });

  await test.step('Ana shares a follow link from the coalition’s home, its warning beside it', async () => {
    // Ana is still on Riverside's home, where the coalition has formed.
    const { page } = ana;
    const coalitions = page.getByRole('region', { name: 'Coalitions' });
    await coalitions.getByRole('link', { name: 'Open the coalition' }).click();
    await expect(heading(page, WORDS.coalition)).toBeVisible();
    const followers = page.getByRole('region', { name: 'Followers' });
    await expect(followers).toContainText(
      'Anyone who opens this link in the next 2 days can read this coalition from then on',
    );
    await followers.getByRole('button', { name: 'Copy a follow link' }).click();
    const link = followers.getByRole('textbox', { name: 'Follow link' });
    await expect(link).toHaveValue(/^https?:\/\/[^#]+\/#follow\/[A-Za-z0-9_-]{43}$/);
    await expectAccessible(ana, 'Copy a follow link');
    followLink = await link.inputValue();
  });

  await test.step('Fay, in no group, opens it, reads the preview as plain text, and follows', async () => {
    const { page } = fay;
    capture(page, sent);
    await page.goto(followLink);
    await acceptNotice(fay);
    await expect(heading(page, WORDS.coalition)).toBeVisible();
    await expect(page).toHaveURL(/#\/follow$/);
    await expect(page.getByText(WORDS.riverside)).toBeVisible();
    await expect(page.getByText(WORDS.oak)).toBeVisible();
    await expect(page.getByText(WORDS.statement)).toBeVisible();
    await expect(page.getByText('no one sees that you follow')).toBeVisible();
    await expectAccessible(fay, 'the follow preview');
    await page.getByRole('button', { name: 'Follow', exact: true }).click();

    await expect(heading(page, WORDS.coalition)).toBeVisible();
    await expect(page).toHaveURL(/#\/c\/[A-Za-z0-9_-]+$/);
    await expect(page.locator('.page-head .eyebrow')).toHaveText('Following');
    await expect(page.getByRole('region', { name: 'Dispatches' })).toContainText(
      'No Dispatches yet.',
    );
    await expect(page.getByRole('region', { name: 'Open Proposals' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Take part|Share/ })).toHaveCount(0);
    await expectAccessible(fay, 'a follower’s coalition home');
    await page
      .getByRole('region', { name: 'Documents' })
      .getByRole('link', { name: /Mission statement/ })
      .click();
    await expect(page.getByText(WORDS.statement)).toBeVisible();
    await expect(page.getByRole('button', { name: /Propose/ })).toHaveCount(0);
    await expectAccessible(fay, 'a follower’s coalition Document');
  });

  const entries = (await storedGroups(ana.page)).filter((group) => group.kind === 'coalition');
  const [entry] = entries;
  if (entry === undefined) throw new Error('Expected Ana to hold the coalition.');
  const secret = Uint8Array.from(entry.secret);
  const seed = Buffer.from(new URL(followLink).hash.slice('#follow/'.length), 'base64url');
  const followMailbox = derive(seed, 'reconcile/v1/follow-mailbox').toString('base64url');
  const riverside = await reconcileSecrets(ana.page);
  const oak = await reconcileSecrets(ben.page);
  const secrets: Canary[] = [
    ...keyCanaries('the coalition secret', secret),
    ...keyCanaries('the coalition’s seal key', derive(secret, 'reconcile/v1/seal-key')),
    ...keyCanaries('Riverside’s inner', riverside.inner),
    ...keyCanaries('Oak St’s inner', oak.inner),
    ...keyCanaries('Riverside’s seat secret', riverside.seat),
    ...keyCanaries('Oak St’s seat secret', oak.seat),
    ...keyCanaries('the follow seed', seed),
    ...keyCanaries('the follow key', derive(seed, 'reconcile/v1/follow-key')),
  ];

  await test.step('no request of Fay’s carries a secret or the seed; the follow mailbox id does turn up', async () => {
    // A round trip lets any request already sent reach the capture.
    await fay.page.evaluate(() => undefined);
    expect(sent.length).toBeGreaterThan(3);
    const leaks = sent.flatMap((each) => findIn(bytesOf(each), each.url(), secrets));
    expect(leaks.map(describeFinding)).toEqual([]);
    expect(sent.some((each) => each.url().includes(`/v1/mailbox/${followMailbox}`))).toBe(true);
  });

  await test.step('Fay’s device holds the coalition’s secret, and no inner or seat secret', async () => {
    const stored = await rawStore(fay.page);
    const kept = (await storedGroups(fay.page)).map((group) => group.kind);
    expect(kept).toEqual(['coalition']);
    const notHeld = secrets.filter(({ label }) => /inner|seat secret|follow/.test(label));
    expect(findIn(stored, 'Fay’s IndexedDB', notHeld).map(describeFinding)).toEqual([]);
    const held = findIn(stored, 'Fay’s IndexedDB', keyCanaries('the coalition secret', secret));
    expect(held.map(({ encoding }) => encoding)).toContain('bytes');
  });

  await test.step('Fay unfollows, and her device keeps nothing of the coalition', async () => {
    const { page } = fay;
    // From the Document, back to the coalition's home, then to Start's Following.
    await page.getByRole('link', { name: new RegExp(WORDS.coalition) }).click();
    await page.getByRole('link', { name: /Your groups/ }).click();
    const following = page.getByRole('region', { name: 'Following' });
    await following.getByRole('link', { name: new RegExp(WORDS.coalition) }).click();
    await page.getByRole('button', { name: 'Unfollow' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Unfollow this coalition?' });
    await expectAccessible(fay, 'Unfollow');
    await dialog.getByRole('button', { name: 'Unfollow' }).click();
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Following' })).toHaveCount(0);
    expect(await storedGroups(page)).toEqual([]);
    const stored = await rawStore(page);
    const gone = [
      ...keyCanaries('the coalition secret', secret),
      textCanary('the coalition’s name', WORDS.coalition),
      textCanary('the coalition’s statement', WORDS.statement),
    ];
    expect(findIn(stored, 'Fay’s IndexedDB', gone).map(describeFinding)).toEqual([]);
  });

  await test.step('the relay stops, and nothing it kept holds a canary', async () => {
    for (const { page } of [ana, ben, fay]) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries = [
      ...Object.entries(WORDS).map(([field, text]) => textCanary(field, text)),
      ...secrets,
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored.
    const controls = scan(files, [textCanary('control', control)]);
    expect(controls.map(({ encoding }) => encoding)).toContain('bytes');
    const ids = groupMailboxes(secret).map((id) => textCanary('the coalition’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
    const follow = scan(files, [textCanary('the follow mailbox id', followMailbox)]);
    expect(follow.map(({ encoding }) => encoding)).toContain('bytes');
  });
});
