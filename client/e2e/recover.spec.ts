/**
 * Recovering with contacts (#118), end to end through the real relay and the
 * deploy CSP, with every request every profile sends captured.
 *
 * Ana, on a laptop, founds a group that Ben (a phone, dark), Cal and Dee
 * join, proposes a change, and picks Ben, Cal and Dee at 2 of 3. A fresh
 * phone, five profiles in all, opens Recover with my contacts and shows its
 * code and check. Ben approves from Settings › Help someone recover (a wrong
 * number first, which approves nothing) and so does Cal; Ana's Start and
 * group home show the alert, and she cancels it.
 *
 * The real relay's clock can't be moved and the spec adds no relay route or
 * flag, so the test moves each alert's `received` back 4,320 minutes in the
 * relay's SQLite (`node:sqlite`, as #73's spec edits it) and in Ben's and
 * Cal's IndexedDB. After the cancel, their next passes release nothing, and
 * the request mailbox stays empty. Ben and Cal then approve again, Ana lets
 * it run, and once their alerts are moved back too their devices release;
 * the fresh phone rebuilds the key, restores Ana's group and Document, asks
 * her to choose her contacts again, and votes as Ana on her Proposal.
 *
 * No request any profile sent, and nothing the stopped relay kept, holds a
 * share, the backup key, the new device's seed or key, the code, or a name,
 * in any spelling; the request mailbox's id and a released blob turn up as
 * controls. The 72-hour boundary itself is proved with the fake relay's clock
 * (`src/recovery/holder.test.ts`). axe checks every screen.
 */
import { DatabaseSync } from 'node:sqlite';

import type { Page, Request } from '@playwright/test';

import { recoveryChannel, recoveryCheck } from '../src/crypto/recovery';
import type { RecoveryShare } from '../src/crypto/shares';
import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';
import { backupKeyOn, deviceRecord, shareOf } from './support/recovery';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  scan,
  textCanary,
} from './support/scan';
import { storedGroups } from './support/stored';

const GROUP = 'Riverside Tenants';
const DOCUMENT = 'House rules';
const PROPOSAL = 'Quieter mornings';
/** Names only these people use, so a scan can find any trace of them. */
const NAMES = {
  ana: 'Anastasia Canary',
  ben: 'Benedetta Canary',
  cal: 'Calloway Canary',
  dee: 'Delphine Canary',
};
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };
/** Long enough for a few sync passes, each a few seconds apart. */
const SYNCED = { timeout: 30_000 };
/** The hold: 72 hours, in relay minutes. */
const HOLD = 4320;

/** `person` opens `invite`, takes the pilot notice and joins under their name. */
async function join(person: Person, invite: string): Promise<void> {
  const { page } = person;
  await page.goto(invite);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText(
    person.name,
  );
}

/** Opens Settings from Start's link. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(heading(page, 'Settings')).toBeVisible();
}

/** Ana picks `names` at 2 of 3 in the picker, and saves. */
async function pickContacts(ana: Person, names: readonly string[]): Promise<void> {
  const { page } = ana;
  const people = page.getByRole('textbox', { name: 'People to pick' });
  await people.fill('3');
  await people.press('Tab');
  const needed = page.getByRole('textbox', { name: 'Needed to help you back in' });
  await needed.fill('2');
  await needed.press('Tab');
  for (const name of names) {
    // React Aria hides the input under its label, so the label takes the press.
    await page.locator('label', { has: page.getByRole('checkbox', { name }) }).click();
  }
  await page.getByRole('button', { name: 'Save recovery contacts' }).click();
  await expect(heading(page, 'Settings')).toBeVisible(SYNCED);
}

/** `contact` approves `code` from Help someone recover, with `number` read out. */
async function approve(contact: Person, code: string, number: string): Promise<void> {
  const { page } = contact;
  await openSettings(page);
  await page
    .getByRole('region', { name: 'Recovery contacts' })
    .getByRole('link', { name: 'Help someone recover' })
    .click();
  await expect(heading(page, 'Help someone recover')).toBeVisible();
  await page.getByRole('textbox', { name: 'Their recovery code' }).fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('radio', { name: `${NAMES.ana} (${GROUP})` })).toBeChecked();
  await expect(page.getByText(`Call ${NAMES.ana} or meet them.`, { exact: false })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'The number they read out' });
  await field.fill(number);
  await page.getByRole('button', { name: 'Approve' }).click();
}

/** The holds `contact`'s Help someone recover lists. */
function holdsOf(contact: Person) {
  return contact.page.getByRole('list', { name: 'Recoveries you’re helping with' });
}

/**
 * Moves the receipt of each `recovery-alert` in `page`'s IndexedDB whose seq
 * isn't in `skip` back by `minutes`, and returns the seqs it moved.
 */
function moveAlertsBack(page: Page, skip: readonly number[], minutes: number): Promise<number[]> {
  return page.evaluate(
    async ({ skip: done, minutes: by }) => {
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
        const store = db.transaction('groups', 'readwrite').objectStore('groups');
        const groups = (await request(store.getAll())) as {
          log: { seq: number; received: number; bytes: Uint8Array }[];
        }[];
        const moved: number[] = [];
        for (const group of groups) {
          for (const record of group.log) {
            const text = new TextDecoder().decode(record.bytes.subarray(96));
            const alert = text.includes('"type":"recovery-alert"');
            if (!alert || done.includes(record.seq)) continue;
            record.received -= by;
            moved.push(record.seq);
          }
          await request(store.put(group));
        }
        return moved;
      } finally {
        db.close();
      }
    },
    { skip, minutes },
  );
}

/** Moves the relay's own receipt of the blobs at `seqs` back by `minutes`, in its SQLite file. */
function moveRelayBack(db: string, seqs: readonly number[], minutes: number): void {
  const sqlite = new DatabaseSync(db, { timeout: 10_000 });
  try {
    const marks = seqs.map(() => '?').join(', ');
    const moved = sqlite
      .prepare(`UPDATE blobs SET received = received - ? WHERE seq IN (${marks})`)
      .run(minutes, ...seqs);
    expect(Number(moved.changes)).toBe(seqs.length);
  } finally {
    sqlite.close();
  }
}

/** The records the relay holds in `mailbox`, through its public GET. */
async function mailboxRecords(page: Page, mailbox: string): Promise<number> {
  const answer = await page.request.get(`/v1/mailbox/${mailbox}?after=0`);
  const body = (await answer.json()) as { records: unknown[] };
  return body.records.length;
}

test('a new device recovers Ana through two contacts after the wait, and her cancel stops the first try', async ({
  openProfile,
  relay,
}) => {
  test.setTimeout(420_000);
  const ana = await openProfile(NAMES.ana, { viewport: LAPTOP });
  const ben = await openProfile(NAMES.ben, { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile(NAMES.cal, { viewport: LAPTOP });
  const dee = await openProfile(NAMES.dee, { viewport: PHONE });
  const fresh = await openProfile('A fresh phone', { viewport: PHONE });
  const everyone = [ana, ben, cal, dee, fresh];
  const requests: Request[] = [];
  for (const { page } of everyone) page.on('request', (sent) => requests.push(sent));

  await test.step('Ana founds the group, the others join, and Ana proposes', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: DOCUMENT,
      atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.'],
      founder: NAMES.ana,
    });
    for (const person of [ben, cal, dee]) await join(person, invite);
    await expect(ana.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      NAMES.dee,
      SYNCED,
    );
    await ana.page.getByRole('link', { name: DOCUMENT }).click();
    await ana.page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await ana.page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await ana.page.getByRole('textbox', { name: 'Why' }).fill('Mornings are when we sleep.');
    await ana.page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours run until nine.');
    await ana.page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(ana.page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible(
      SYNCED,
    );
  });

  await test.step('Ana picks Ben, Cal and Dee at 2 of 3, and Ben and Cal hold her share', async () => {
    await openSettings(ana.page);
    await ana.page.getByRole('link', { name: 'Choose recovery contacts' }).click();
    await expect(heading(ana.page, 'Choose recovery contacts')).toBeVisible();
    await pickContacts(ana, [NAMES.ben, NAMES.cal, NAMES.dee]);
    for (const contact of [ben, cal]) {
      await openSettings(contact.page);
      await expect(contact.page.getByRole('region', { name: 'Recovery contacts' })).toContainText(
        `You’re holding a recovery share for ${NAMES.ana} (${GROUP})`,
        SYNCED,
      );
    }
  });

  let code = '';
  let check = '';
  await test.step('the fresh phone shows its code and check from Recover with my contacts', async () => {
    const { page } = fresh;
    await page.goto('/');
    await acceptNotice(fresh);
    await expectAccessible(fresh, 'Start, a new device');
    await page.getByRole('link', { name: 'Recover with my contacts' }).click();
    await expect(heading(page, 'Recover with your contacts')).toBeVisible();
    code = await page.getByRole('textbox', { name: 'Your recovery code' }).inputValue();
    expect(code).toMatch(/^RR1\.[A-Za-z0-9_-]{64}$/);
    check = recoveryCheck(code);
    await expect(page.getByText(`${check.slice(0, 3)} ${check.slice(3)}`)).toBeVisible();
    await expect(
      page.getByText(
        'Send this code to your recovery contacts, then call them and read them this number.',
      ),
    ).toBeVisible();
    await expect(page.getByText('Waiting for your contacts.')).toBeVisible();
    await expectAccessible(fresh, 'Recover with your contacts');
  });

  const request = await deviceRecord(fresh.page, 'recover-request');
  const seed = Uint8Array.from((request?.seed as number[] | undefined) ?? []);
  const secretKey = Uint8Array.from((request?.secretKey as number[] | undefined) ?? []);
  expect(seed).toHaveLength(16);
  expect(secretKey).toHaveLength(32);
  const { mailbox } = recoveryChannel(seed);

  await test.step('a wrong number approves nothing; Ben and Cal approve with the right one', async () => {
    const wrong = String((Number(check) + 1) % 1_000_000).padStart(6, '0');
    await approve(ben, code, wrong);
    await expect(ben.page.getByText(/That number doesn’t match this code/)).toBeVisible();
    await expectAccessible(ben, 'Help someone recover, a wrong number');
    await expect(holdsOf(ben)).toHaveCount(0);
    await ben.page.getByRole('textbox', { name: 'The number they read out' }).fill(check);
    await ben.page.getByRole('button', { name: 'Approve' }).click();
    await expect(holdsOf(ben)).toContainText(
      new RegExp(`^Holding ${NAMES.ana}’s share until .+\\. Open Reconcile after then`),
      SYNCED,
    );
    await expectAccessible(ben, 'Help someone recover, holding');
    await approve(cal, code, check);
    await expect(holdsOf(cal)).toContainText(`Holding ${NAMES.ana}’s share until`, SYNCED);
  });

  await test.step('Ana’s Start and group home show the alert, and she cancels it', async () => {
    const { page } = ana;
    await visit(page, '/#/');
    const alert = page.locator('.recovery-alert');
    await expect(alert).toContainText(
      /^Someone asked your recovery contacts to restore your Reconcile on a new device\. If this wasn’t you, cancel now\. It completes /,
      SYNCED,
    );
    await expectAccessible(ana, 'Start, with the recovery alert');
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(alert).toBeVisible();
    await expectAccessible(ana, 'group home, with the recovery alert');
    await alert.getByRole('button', { name: 'Cancel this recovery' }).click();
    await expect(alert).toHaveText(
      'You cancelled this recovery. Your contacts keep their shares.',
      SYNCED,
    );
    await expectAccessible(ana, 'group home, recovery cancelled');
  });

  const moved: number[] = [];
  await test.step('after the cancel, moving the alerts back 72 hours releases nothing', async () => {
    // Each contact has synced Ana's cancel before its alerts move.
    for (const contact of [ben, cal]) {
      await expect(holdsOf(contact)).toContainText('this recovery was cancelled', SYNCED);
    }
    const seqs = await moveAlertsBack(ben.page, moved, HOLD);
    expect(seqs).toHaveLength(2);
    expect(await moveAlertsBack(cal.page, moved, HOLD)).toEqual(seqs);
    moveRelayBack(relay.db, seqs, HOLD);
    moved.push(...seqs);
    // Several passes later, still nothing in the request mailbox, and nothing restored.
    await fresh.page.waitForTimeout(10_000);
    expect(await mailboxRecords(fresh.page, mailbox)).toBe(0);
    await expect(fresh.page.getByText('Waiting for your contacts.')).toBeVisible();
  });

  await test.step('they approve again; once the wait has passed, the fresh phone restores Ana', async () => {
    await approve(ben, code, check);
    await expect(holdsOf(ben)).toContainText(`Holding ${NAMES.ana}’s share until`, SYNCED);
    await approve(cal, code, check);
    await expect(holdsOf(cal)).toContainText(`Holding ${NAMES.ana}’s share until`, SYNCED);
    // Both new alerts are on both contacts' devices before they move.
    await expect.poll(() => moveAlertsBack(ben.page, moved, 0), SYNCED).toHaveLength(2);
    const seqs = await moveAlertsBack(ben.page, moved, HOLD);
    expect(await moveAlertsBack(cal.page, moved, HOLD)).toEqual(seqs);
    moveRelayBack(relay.db, seqs, HOLD);
    moved.push(...seqs);
    for (const contact of [ben, cal]) {
      await expect(holdsOf(contact)).toContainText(
        `${NAMES.ana}’s share went to their new device.`,
        SYNCED,
      );
    }
    expect(await mailboxRecords(fresh.page, mailbox)).toBe(2);
    const { page } = fresh;
    await expect(heading(page, 'Choose recovery contacts')).toBeVisible(SYNCED);
    await expect(
      page.getByText(/^You’re back in\. Choose your recovery contacts again/),
    ).toBeVisible();
    await expectAccessible(fresh, 'the picker, after a recovery');
  });

  await test.step('the fresh phone holds Ana’s group and Document, and votes as her', async () => {
    const { page } = fresh;
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Your groups' }).click();
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await expect(heading(page, GROUP)).toBeVisible();
    await page.getByRole('link', { name: DOCUMENT }).click();
    await expect(page.getByText('Bins go out on Tuesday.')).toBeVisible();
    const [restored] = await storedGroups(page);
    const [original] = await storedGroups(ana.page);
    expect(restored?.author).toBe(original?.author);
    await page.getByRole('link', { name: GROUP }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(PROPOSAL) })
      .click();
    await pick(page, '4 · Strongly supportive');
    await page.getByRole('button', { name: /your vote$/ }).click();
    await expect(page.getByText('Sent', { exact: true })).toBeVisible(SYNCED);
    // Ana's laptop is the same person: once it syncs that ballot, nothing needs her vote.
    await visit(ana.page, '/#/');
    await ana.page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await expect(ana.page.getByRole('region', { name: 'Needs your vote' })).toHaveCount(0, SYNCED);
  });

  const backupKey = Uint8Array.from(await backupKeyOn(ana.page));
  const author = (await storedGroups(ana.page))[0]?.author ?? '';
  const shares: RecoveryShare[] = [await shareOf(ben, author), await shareOf(cal, author)];
  const canaries: Canary[] = [
    ...keyCanaries('the backup key', backupKey),
    ...keyCanaries('the new device’s seed', seed),
    ...keyCanaries('the new device’s secret key', secretKey),
    ...shares.flatMap((share, i) => keyCanaries(`share ${String(i + 1)}`, share.share)),
    textCanary('the code', code.slice(4)),
    ...Object.entries(NAMES).map(([who, name]) => textCanary(`${who}’s name`, name)),
  ];

  await test.step('no request any profile sent carries a share, a key, the seed, the code or a name', () => {
    const findings = requests.flatMap((sent, index) =>
      findIn(
        Buffer.concat([Buffer.from(sent.url()), sent.postDataBuffer() ?? Buffer.alloc(0)]),
        `request ${String(index)} ${sent.method()} ${new URL(sent.url()).pathname}`,
        canaries,
      ),
    );
    expect(findings.map(describeFinding)).toEqual([]);
    // The control: the same scan finds the request mailbox in the fresh phone's GETs.
    const control = [textCanary('the request mailbox', mailbox)];
    const seen = requests.flatMap((sent) => findIn(Buffer.from(sent.url()), 'url', control));
    expect(seen.length).toBeGreaterThan(0);
  });

  await test.step('the stopped relay holds none of them, though it holds the released blobs', async () => {
    for (const { page } of everyone) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    const db = new DatabaseSync(relay.db, { timeout: 10_000 });
    let blob: Uint8Array;
    try {
      const row = db.prepare('SELECT blob FROM blobs WHERE mailbox = ?').get(mailbox) as
        { blob: Uint8Array } | undefined;
      blob = row?.blob ?? new Uint8Array(0);
    } finally {
      db.close();
    }
    expect(blob).toHaveLength(1024);
    const controls = [
      { label: 'a released blob', bytes: Uint8Array.from(blob.subarray(24, 88)) },
      textCanary('the request mailbox', mailbox),
    ];
    expect(new Set(scan(files, controls).map(({ label }) => label))).toEqual(
      new Set(['a released blob', 'the request mailbox']),
    );
  });
});
