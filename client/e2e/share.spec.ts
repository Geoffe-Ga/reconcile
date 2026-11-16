/**
 * Sharing a personal mission statement by a read-only link (#105), end to
 * end under the deploy CSP and through the real relay.
 *
 * Ana founds a group, so her sync loop talks to the relay all along, writes
 * a canary mission statement and shares it. A second profile that has never
 * opened Reconcile opens the link: the shared page sits outside first run, so
 * it reads the Document with no pilot notice, and keeps no database, web
 * storage, cache or service worker. Ana edits, and the reader sees the edit
 * after a reload; she stops sharing, and the reader sees the not-shared line.
 * Every request either browser sends is captured, and none carries the share's
 * seed, seal key or keys, or any group id, secret or key, in any spelling.
 * The stopped relay's database, WAL, shared memory and log hold no canary, and
 * do hold the share's mailbox id, so the scan can't pass by reading nothing.
 * The reader then leaves the link for the app's own address, and first run
 * starts there, notice first, as on any visit. axe runs on every screen
 * either sees, in both themes.
 */
import { randomBytes } from 'node:crypto';

import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  localKeys,
  type Person,
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
import { derive, groupMailboxes, onlyGroup } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const CANARY = {
  title: `Canary ${TAG} compass`,
  text: `Canary ${TAG}: I show up for my neighbours every week.`,
  edit: `Canary ${TAG}: and I keep my word.`,
};

const TEXT_CANARIES = Object.entries(CANARY).map(([field, text]) =>
  textCanary(`shared ${field}`, text),
);

const GROUP = 'Canary Close Allotments';

const NOT_SHARED = 'This page isn’t shared any more, or the link is damaged.';
const STOPPED =
  'Sharing stopped. People who opened the link may have kept a copy, and earlier copies stay on the relay, still sealed, until they expire within a month.';

/** axe on what `person` sees, in the light theme and then the dark one. */
async function inBothThemes(person: Person, screen: string): Promise<void> {
  await expectAccessible(person, `${screen}, light`);
  await person.page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(person, `${screen}, dark`);
  await person.page.emulateMedia({ colorScheme: 'light' });
}

/** A captured request as the scan reads it: its URL, then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

/** Keeps every request `page` sends from now on. */
function capture(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    requests.push(request);
  });
  return requests;
}

/** The share on the personal Document in `page`'s IndexedDB, read with no hook into the app. */
function storedShare(
  page: Page,
): Promise<{ seed: number[]; secretKey: number[]; publicKey: number[] } | null> {
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
      const store = db.transaction('personal').objectStore('personal');
      const documents = (await request(store.getAll())) as {
        share?: { seed: Uint8Array; secretKey: Uint8Array; publicKey: Uint8Array };
      }[];
      const share = documents.find((document) => document.share !== undefined)?.share;
      return share === undefined
        ? null
        : {
            seed: Array.from(share.seed),
            secretKey: Array.from(share.secretKey),
            publicKey: Array.from(share.publicKey),
          };
    } finally {
      db.close();
    }
  });
}

/** What a browser that only read the link keeps of Reconcile: databases, storage, caches and workers. */
function keptByReader(page: Page) {
  return page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map(({ name }) => name),
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
}

test('a mission statement shared by link reads in a browser that never opened Reconcile, and stops', async ({
  openProfile,
  relay,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 390, height: 844 } });
  const { page } = ana;
  const share = page.getByRole('region', { name: 'Share by link' });

  await test.step('Ana founds a group, so her sync loop talks to the relay all along', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    await foundGroup(page, {
      name: GROUP,
      title: 'Plot rules',
      atoms: ['Water before nine.'],
      founder: 'Ana',
    });
    await page.getByRole('link', { name: 'Your groups' }).click();
  });

  const requests = capture(page);

  await test.step('she writes her statement, and Share by link says what it shows before anything is sent', async () => {
    await page.getByRole('link', { name: /^Personal/ }).click();
    await page.getByRole('link', { name: /My mission statement/ }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(CANARY.title);
    await page.getByRole('textbox', { name: 'Text' }).fill(`# ${CANARY.title}\n\n${CANARY.text}`);
    await expect(page.getByText('Saved on this device.')).toBeVisible();
    await expect(share.getByText(/anyone can open in any browser/)).toBeVisible();
    await expect(share.getByText(/this device’s internet address/)).toBeVisible();
    expect(await storedShare(page)).toBe(null);
    await inBothThemes(ana, 'Share by link, off');
  });

  let link = '';
  await test.step('Share link posts the first copy, then shows the link beside its warning', async () => {
    await share.getByRole('button', { name: 'Share link' }).click();
    const field = share.getByRole('textbox', { name: 'Link' });
    await expect(field).toHaveValue(/\/#share\/[\w-]{43}\.[\w-]{43}$/);
    link = await field.inputValue();
    await expect(
      share.getByText(
        'Anyone with this link can read this Document. It stops working if you don’t open Reconcile for 30 days.',
      ),
    ).toBeVisible();
    await expect(
      share.getByText(/^(Copied\. Send it|Copying is blocked here|Shared\.)/),
    ).toBeVisible();
    await expect(share.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    await inBothThemes(ana, 'Share by link, on');
  });

  const shared = await storedShare(page);
  if (shared === null) throw new Error('Expected Ana’s device to hold the share.');
  const seed = Uint8Array.from(shared.seed);
  const shareMailbox = derive(seed, 'reconcile/v1/share-mailbox').toString('base64url');
  expect(new URL(link).hash).toBe(
    `#share/${Buffer.from(seed).toString('base64url')}.${Buffer.from(shared.publicKey).toString('base64url')}`,
  );

  const reader = await openProfile('Reader');
  const readerRequests = capture(reader.page);

  await test.step('a browser that never opened Reconcile reads it, with no notice, and keeps nothing', async () => {
    await reader.page.goto(link);
    await expect(heading(reader.page, CANARY.title)).toBeVisible();
    await expect(reader.page.getByText('Shared with Reconcile. Read-only.')).toBeVisible();
    await expect(reader.page.getByText(CANARY.text)).toBeVisible();
    await expect(reader.page.getByRole('textbox')).toHaveCount(0);
    await expect(reader.page.getByRole('button')).toHaveCount(0);
    await expect(heading(reader.page, 'Before you start')).toHaveCount(0);
    await expect(reader.page).toHaveTitle('Shared page · Reconcile');
    await inBothThemes(reader, 'Shared page');
    await reader.page.reload();
    await expect(reader.page.getByText(CANARY.text)).toBeVisible();
    expect(new URL(reader.page.url()).hash).toBe(new URL(link).hash);
    expect(await keptByReader(reader.page)).toEqual({
      databases: [],
      local: [],
      session: [],
      caches: [],
      workers: 0,
    });
  });

  await test.step('Ana edits it, and the reader sees the edit after a reload', async () => {
    await page.getByRole('textbox', { name: 'Text' }).fill(`# ${CANARY.title}\n\n${CANARY.edit}`);
    await expect(page.getByText('Saved on this device.')).toBeVisible();
    // Leaving the editor posts the edit.
    await page.getByRole('link', { name: 'Personal' }).click();
    await expect(page.getByText('Shared by link')).toBeVisible();
    await expect(async () => {
      await reader.page.reload();
      await expect(reader.page.getByText(CANARY.edit)).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(reader.page.getByText(CANARY.text)).toHaveCount(0);
  });

  await test.step('Ana stops sharing, says what it can’t call back, and the reader sees the not-shared line', async () => {
    await page.getByRole('link', { name: CANARY.title }).click();
    await share.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(share.getByText(STOPPED)).toBeVisible();
    await expect(share.getByRole('button', { name: 'Share link' })).toBeVisible();
    expect(await storedShare(page)).toBe(null);
    await inBothThemes(ana, 'Share by link, stopped');
    await reader.page.reload();
    await expect(reader.page.getByText(NOT_SHARED)).toBeVisible();
    await expect(reader.page.getByText(CANARY.edit)).toHaveCount(0);
    await inBothThemes(reader, 'Shared page, stopped');
  });

  const group = await onlyGroup(page);
  const groupSecret = Uint8Array.from(group.secret);
  const groupMailboxIds = groupMailboxes(groupSecret);

  await test.step('no request carried a share key, a group’s id or secret, or the text', () => {
    const keys: Canary[] = [
      ...keyCanaries('share seed', seed),
      ...keyCanaries('share seal key', derive(seed, 'reconcile/v1/share-key')),
      ...keyCanaries('share secret key', Uint8Array.from(shared.secretKey)),
      ...keyCanaries('share public key', Uint8Array.from(shared.publicKey)),
      textCanary('group id', group.groupId),
      ...keyCanaries('group secret', groupSecret),
      ...keyCanaries('group seal key', derive(groupSecret, 'reconcile/v1/seal-key')),
      ...keyCanaries('group signing key', Uint8Array.from(group.signingKey)),
      ...(group.kxKey === null
        ? []
        : keyCanaries('group encryption key', Uint8Array.from(group.kxKey))),
    ];
    const all = [...requests, ...readerRequests];
    const toRelay = all.filter((request) => new URL(request.url()).pathname.startsWith('/v1/'));
    // The control: the share's mailbox was both posted to and read.
    const shareCalls = toRelay.filter((request) => request.url().includes(shareMailbox));
    expect(shareCalls.some((request) => request.method() === 'PUT')).toBe(true);
    expect(shareCalls.some((request) => request.method() === 'GET')).toBe(true);
    const findings = all.flatMap((request) =>
      findIn(bytesOf(request), request.url(), [...keys, ...TEXT_CANARIES]),
    );
    expect(findings.map(describeFinding)).toEqual([]);
    // The reader reads the share's mailbox and nothing else of the relay's.
    const readerRelay = readerRequests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/v1/'),
    );
    expect(readerRelay.length).toBeGreaterThan(0);
    for (const request of readerRelay) {
      expect(`${request.method()} ${new URL(request.url()).pathname}`).toBe(
        `GET /v1/mailbox/${shareMailbox}`,
      );
    }
    // No share request names the group's mailbox, and no group request the share's.
    const namesGroup = (url: string) => groupMailboxIds.some((id) => url.includes(id));
    expect(shareCalls.filter((request) => namesGroup(request.url()))).toEqual([]);
  });

  await test.step('the stopped relay’s database, WAL, shared memory and log hold no trace of the text', async () => {
    await page.context().setOffline(true);
    await reader.page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, TEXT_CANARIES).map(describeFinding)).toEqual([]);
    // The control: the scan reads what the relay stored.
    const stored = scan(files, [textCanary('the share’s mailbox id', shareMailbox)]);
    expect(stored.map(({ encoding }) => encoding)).toContain('bytes');
  });

  await test.step('leaving the link for the app’s own address starts first run, notice first', async () => {
    await reader.page.context().setOffline(false);
    await reader.page.goto('/');
    await acceptNotice(reader);
    await expect(heading(reader.page, 'Your groups')).toBeVisible();
    expect(await localKeys(reader.page)).not.toEqual([]);
  });
});
