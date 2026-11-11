/**
 * A personal mission statement on this device (#93), end to end under the
 * deploy CSP.
 *
 * Ana founds a group, so the sync loop talks to the relay all along. Then she
 * writes a canary mission statement in Personal: Write, Preview, a reload, a
 * second Document, a Proposal in her group while both exist, and Delete.
 * Every request from the moment she opens Personal is captured, and none
 * carries a canary in any spelling. Her group's records, which are all that
 * is ever sealed for the relay, hold none either, and once the relay stops,
 * its database, WAL, shared memory and log hold no trace of one. axe runs on
 * each screen, in both themes.
 */
import { randomBytes } from 'node:crypto';

import type { Page, Request } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type Person,
  test,
} from './support/fixtures';
import { describeFinding, findIn, scan, textCanary } from './support/scan';
import { groupMailboxes, onlyGroup } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const CANARY = {
  title: `Canary ${TAG} compass`,
  text: `Canary ${TAG}: I show up for my neighbours every week.`,
  second: `Canary ${TAG} reading list`,
};

const CANARIES = Object.entries(CANARY).map(([field, text]) =>
  textCanary(`personal ${field}`, text),
);

const GROUP = 'Canary Close Allotments';

/** axe on what `person` sees, in the light theme and then the dark one. */
async function inBothThemes(person: Person, screen: string): Promise<void> {
  await expectAccessible(person, `${screen}, light`);
  await person.page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(person, `${screen}, dark`);
  await person.page.emulateMedia({ colorScheme: 'light' });
}

/**
 * Every record the device's groups hold or wait to send, as raw bytes: their
 * logs and outboxes, which are all that is ever sealed for the relay.
 */
function groupRecords(page: Page): Promise<number[][]> {
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
        log: { bytes: Uint8Array }[];
        outbox: Uint8Array[];
      }[];
      return groups.flatMap((group) =>
        [...group.log.map((record) => record.bytes), ...group.outbox].map((bytes) =>
          Array.from(bytes),
        ),
      );
    } finally {
      db.close();
    }
  });
}

/** The titles of the personal Documents in the device's IndexedDB, read with no hook into the app. */
function storedTitles(page: Page): Promise<string[]> {
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
      const documents = (await request(store.getAll())) as { title: string }[];
      return documents.map((document) => document.title).sort();
    } finally {
      db.close();
    }
  });
}

/** A captured request as the scan reads it: its URL, then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

test('a personal mission statement stays on the device: no request or relay record ever carries it', async ({
  openProfile,
  relay,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 390, height: 844 } });
  const { page } = ana;
  const saved = page.getByText('Saved on this device.');

  await test.step('Ana founds a group, so the sync loop talks to the relay all along', async () => {
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

  const requests: Request[] = [];
  page.on('request', (request) => {
    requests.push(request);
  });

  await test.step('Start opens Personal, which offers My mission statement', async () => {
    await page.getByRole('link', { name: /^Personal/ }).click();
    await expect(heading(page, 'Personal')).toBeVisible();
    await expect(
      page.getByText('What do you stand for, and what are you working toward?'),
    ).toBeVisible();
    await inBothThemes(ana, 'Personal, empty');
    await page.getByRole('link', { name: /My mission statement/ }).click();
    await expect(heading(page, 'My mission statement')).toBeVisible();
    expect(await storedTitles(page)).toEqual([]);
  });

  await test.step('she writes it, it saves on this device, and Preview renders it', async () => {
    await page.getByRole('textbox', { name: 'Title' }).fill(CANARY.title);
    await page.getByRole('textbox', { name: 'Text' }).fill(`# ${CANARY.text}\n\nEvery week.`);
    await expect(saved).toBeVisible();
    await inBothThemes(ana, 'Personal Document, writing');
    await page.getByRole('tab', { name: 'Preview' }).click();
    const preview = page.getByRole('tabpanel', { name: 'Preview' });
    await expect(preview.getByRole('heading', { level: 2, name: CANARY.text })).toBeVisible();
    await inBothThemes(ana, 'Personal Document, preview');
    expect(await storedTitles(page)).toEqual([CANARY.title]);
  });

  await test.step('it comes back after a reload, and Personal lists it', async () => {
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(CANARY.title);
    await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue(
      `# ${CANARY.text}\n\nEvery week.`,
    );
    await page.getByRole('link', { name: 'Personal' }).click();
    await expect(page.getByRole('list').getByRole('link', { name: CANARY.title })).toBeVisible();
    await inBothThemes(ana, 'Personal, listed');
  });

  await test.step('New document keeps a second one beside it', async () => {
    await page.getByRole('link', { name: 'New document' }).click();
    await expect(heading(page, 'Untitled')).toBeVisible();
    await page.getByRole('textbox', { name: 'Title' }).fill(CANARY.second);
    await page.getByRole('textbox', { name: 'Text' }).fill('- Braiding Sweetgrass');
    await expect(saved).toBeVisible();
    expect(await storedTitles(page)).toEqual([CANARY.title, CANARY.second].sort());
  });

  await test.step('a Proposal in her group, made while both exist, goes to the relay', async () => {
    await page.getByRole('link', { name: 'Personal' }).click();
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await page.getByRole('link', { name: 'Plot rules' }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Earlier watering');
    await page.getByRole('textbox', { name: 'Why' }).fill('The mornings are hotter now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Water before eight.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
  });

  await test.step('Delete asks first, in an alert dialog, then removes only that one', async () => {
    await page.getByRole('link', { name: GROUP }).click();
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: /^Personal/ }).click();
    await page.getByRole('link', { name: CANARY.title }).click();
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(
      dialog.getByRole('heading', { name: `Delete ‘${CANARY.title}’ from this device?` }),
    ).toBeVisible();
    await expect(dialog.getByText('A backup you saved earlier still has it.')).toBeVisible();
    await inBothThemes(ana, 'Delete dialog');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(heading(page, 'Personal')).toBeVisible();
    await expect(page.getByRole('link', { name: CANARY.title })).toHaveCount(0);
    expect(await storedTitles(page)).toEqual([CANARY.second]);
  });

  await test.step('no request carried any of it, in any spelling', () => {
    const toRelay = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/v1/'),
    );
    // The control: the relay heard from this device all along, polls and the Proposal included.
    expect(toRelay.some((request) => request.method() === 'PUT')).toBe(true);
    expect(toRelay.some((request) => request.method() === 'GET')).toBe(true);
    const findings = requests.flatMap((request) =>
      findIn(bytesOf(request), request.url(), CANARIES),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });

  await test.step('her group’s records, sealed for the relay, hold none of it', async () => {
    const records = await groupRecords(page);
    expect(records.length).toBeGreaterThan(1);
    const findings = records.flatMap((bytes, i) =>
      findIn(Buffer.from(bytes), `record ${String(i)}`, CANARIES),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });

  const { secret } = await onlyGroup(page);
  // Its weekly mailboxes (#110), whichever week this run fell in.
  const mailboxes = groupMailboxes(Uint8Array.from(secret));

  await test.step('the stopped relay’s database, WAL, shared memory and log hold no trace', async () => {
    await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, CANARIES).map(describeFinding)).toEqual([]);
    // The control: the scan reads what the relay stored.
    const ids = mailboxes.map((id) => textCanary('the group’s mailbox id', id));
    expect(scan(files, ids).map(({ encoding }) => encoding)).toContain('bytes');
  });
});
