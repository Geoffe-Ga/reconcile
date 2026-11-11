/**
 * Recovery contacts (#109), end to end through the real relay and the deploy
 * CSP, with every request every profile sends captured.
 *
 * Ana, on a desktop, founds a group that Ben (a phone, dark), Cal, Dee and
 * Eve join. From Settings she opens the picker, which starts at 3 of 5 and
 * lists the other four by their names there, never her own, and saves Ben,
 * Cal and Dee at 2 of 3. Her Settings shows "3 recovery contacts · 2 needed"
 * and the relay backup's line. Ben's Settings lists the share he holds for
 * her and his group home shows it once, until OK; Eve, whom she didn't pick,
 * holds nothing.
 *
 * The test then opens each contact's box from their own device's log with
 * their own key, outside the app, and any two of the shares rebuild Ana's
 * backup key, under which the relay's backup opens. No request any profile
 * sent carries the key, a share, its split, or a contact's name or key, in
 * any spelling.
 *
 * Ana chooses again without Cal: the old backup id now holds 64 KiB that
 * open under no key, Cal's old share with Ben's old one rebuilds only that
 * dead key, and the new contacts' shares rebuild the new one. Then the relay
 * stops, and its database, WAL, shared memory and log hold none of those
 * canaries either, while the controls, a backup blob and its id, turn up.
 * axe checks every screen visited.
 */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { Page, Request } from '@playwright/test';

import { backupIdFor, openRelayBackup } from '../src/crypto/relayBackup';
import { combineShares, openShare, type RecoveryShare } from '../src/crypto/shares';
import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
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
import { storedGroups, storedLogs } from './support/stored';

const GROUP = 'Riverside Tenants';
/** Names only these people use, so a scan can find any trace of the contact list. */
const NAMES = {
  ana: 'Anastasia Canary',
  ben: 'Benedetta Canary',
  cal: 'Calloway Canary',
  dee: 'Delphine Canary',
  eve: 'Evangeline Canary',
};
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };
/** Long enough for a few sync passes, each a few seconds apart. */
const SYNCED = { timeout: 20_000 };

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

/** The relay backup key `page`'s device keeps, read straight from its IndexedDB. */
function backupKeyOn(page: Page): Promise<number[]> {
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
      const state = (await request(
        db.transaction('device').objectStore('device').get('relay-backup'),
      )) as { key: Uint8Array } | undefined;
      if (state === undefined) throw new Error('No relay backup key on this device.');
      return Array.from(state.key);
    } finally {
      db.close();
    }
  });
}

/** The recovery-share events in a stored log, as their author and box. */
function postedShares(log: readonly (readonly [number, number, string])[]) {
  return log.flatMap(([, , hex]) => {
    const event = JSON.parse(Buffer.from(hex, 'hex').subarray(96).toString('utf8')) as {
      type: string;
      author: string;
      body: { box?: string };
    };
    return event.type === 'recovery-share' && event.body.box !== undefined
      ? [{ author: event.author, box: event.body.box }]
      : [];
  });
}

/**
 * The latest share sealed to `person` from `author` in their one group,
 * opened outside the app with their own key from their own device.
 */
async function shareOf(person: Person, author: string): Promise<RecoveryShare> {
  const [group] = await storedGroups(person.page);
  const [stored] = await storedLogs(person.page);
  if (group?.kxKey == null || stored === undefined) throw new Error('Expected one group.');
  const kxKey = Uint8Array.from(group.kxKey);
  const opened = postedShares(stored.log)
    .filter((posted) => posted.author === author)
    .map(({ box }) =>
      openShare({ groupId: group.groupId, contact: group.author, author, kxKey, box }),
    )
    .filter((share): share is RecoveryShare => share !== null);
  const latest = opened.at(-1);
  if (latest === undefined) throw new Error(`${person.name} holds no share from ${author}.`);
  return latest;
}

/** Ana picks `names` at `t` of their number in the picker, and saves. */
async function pick(ana: Person, t: number, names: readonly string[]): Promise<void> {
  const { page } = ana;
  const people = page.getByRole('textbox', { name: 'People to pick' });
  await people.fill(String(names.length));
  await people.press('Tab');
  const needed = page.getByRole('textbox', { name: 'Needed to help you back in' });
  await needed.fill(String(t));
  await needed.press('Tab');
  for (const name of [NAMES.ben, NAMES.cal, NAMES.dee, NAMES.eve]) {
    const box = page.getByRole('checkbox', { name });
    // React Aria hides the input under its label, so the label takes the press.
    if (names.includes(name) !== (await box.isChecked())) {
      await page.locator('label', { has: box }).click();
    }
  }
  await expect(page.getByRole('status').filter({ hasText: 'picked' })).toHaveText(
    `${String(names.length)} of ${String(names.length)} picked.`,
  );
  await page.getByRole('button', { name: 'Save recovery contacts' }).click();
  await expect(heading(page, 'Settings')).toBeVisible(SYNCED);
}

/** The canaries for a share: its bytes and its split, in every spelling. */
function shareCanaries(label: string, share: RecoveryShare): Canary[] {
  return [
    ...keyCanaries(`${label}’s share`, share.share),
    textCanary(`${label}’s split`, share.split),
  ];
}

test('contacts each hold a sealed share of the backup key, and nothing leaves in the clear', async ({
  openProfile,
  relay,
  request,
}) => {
  test.setTimeout(240_000);
  const ana = await openProfile(NAMES.ana, { viewport: LAPTOP });
  const ben = await openProfile(NAMES.ben, { viewport: PHONE, colorScheme: 'dark' });
  const cal = await openProfile(NAMES.cal, { viewport: LAPTOP });
  const dee = await openProfile(NAMES.dee, { viewport: PHONE });
  const eve = await openProfile(NAMES.eve, { viewport: LAPTOP, colorScheme: 'dark' });
  const everyone = [ana, ben, cal, dee, eve];
  const requests: Request[] = [];
  for (const { page } of everyone) page.on('request', (sent) => requests.push(sent));

  await test.step('Ana founds the group and the four others join', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(ana.page, {
      name: GROUP,
      title: 'House rules',
      atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.'],
      founder: NAMES.ana,
    });
    for (const person of [ben, cal, dee, eve]) await join(person, invite);
    await expect(ana.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      NAMES.eve,
      SYNCED,
    );
  });

  await test.step('the picker starts at 3 of 5 and lists the four others, never Ana', async () => {
    await openSettings(ana.page);
    const section = ana.page.getByRole('region', { name: 'Recovery contacts' });
    await expect(section).toContainText('You haven’t chosen anyone yet.');
    await expectAccessible(ana, 'Settings, no recovery contacts');
    await section.getByRole('link', { name: 'Choose recovery contacts' }).click();
    await expect(heading(ana.page, 'Choose recovery contacts')).toBeVisible();
    await expect(ana.page.getByRole('textbox', { name: 'People to pick' })).toHaveValue('5');
    await expect(ana.page.getByRole('textbox', { name: 'Needed to help you back in' })).toHaveValue(
      '3',
    );
    const people = ana.page.getByRole('group', { name: `People in ${GROUP}` });
    await expect(people.getByRole('checkbox')).toHaveCount(4);
    for (const name of [NAMES.ben, NAMES.cal, NAMES.dee, NAMES.eve]) {
      await expect(people.getByRole('checkbox', { name })).not.toBeChecked();
    }
    await expect(ana.page.getByRole('checkbox', { name: NAMES.ana })).toHaveCount(0);
    await expectAccessible(ana, 'the recovery picker');
  });

  await test.step('Ana saves Ben, Cal and Dee at 2 of 3, and Settings says so', async () => {
    await pick(ana, 2, [NAMES.ben, NAMES.cal, NAMES.dee]);
    const section = ana.page.getByRole('region', { name: 'Recovery contacts' });
    await expect(section).toContainText('3 recovery contacts · 2 needed');
    await expect(section.getByRole('listitem')).toHaveText([
      `${NAMES.ben} in ${GROUP}`,
      `${NAMES.cal} in ${GROUP}`,
      `${NAMES.dee} in ${GROUP}`,
    ]);
    const backup = ana.page.getByRole('region', { name: 'Back up your groups' });
    await expect(backup.getByText(/^Backed up to the relay /)).toBeVisible(SYNCED);
    await expectAccessible(ana, 'Settings, recovery contacts chosen');
  });

  await test.step('Ben sees the share he holds in Settings, and once on group home; Eve holds none', async () => {
    const line = `You’re holding a recovery share for ${NAMES.ana} (${GROUP})`;
    await ben.page.goto('/#/');
    await ben.page.getByRole('link', { name: new RegExp(GROUP) }).click();
    const card = ben.page.locator('.recovery-card');
    await expect(card.getByRole('listitem')).toHaveText(line, SYNCED);
    await expectAccessible(ben, 'group home, holding a share');
    await card.getByRole('button', { name: 'OK' }).click();
    await expect(card).toHaveCount(0);
    await ben.page.reload();
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await expect(ben.page.getByText(/You’re holding a recovery share/)).toHaveCount(0);
    await openSettings(ben.page);
    const held = ben.page.getByRole('region', { name: 'Recovery contacts' });
    await expect(held.getByRole('heading', { level: 3, name: 'Shares you hold' })).toBeVisible();
    await expect(held.getByRole('listitem')).toHaveText(line);
    await expectAccessible(ben, 'Settings, holding a share');
    await openSettings(eve.page);
    await expect(eve.page.getByRole('region', { name: 'Recovery contacts' })).not.toContainText(
      'holding',
    );
  });

  const [anaGroup] = await storedGroups(ana.page);
  if (anaGroup === undefined) throw new Error('Expected Ana’s group.');
  const author = anaGroup.author;
  const oldKey = Uint8Array.from(await backupKeyOn(ana.page));
  const oldId = backupIdFor(oldKey);
  const shares = { ben: await shareOf(ben, author), cal: await shareOf(cal, author) };
  const deesOld = await shareOf(dee, author);
  /** The shares of the second choice, once made. */
  const later: RecoveryShare[] = [];
  const contactKeys = await Promise.all(
    [ben, cal, dee].map(async ({ page }) => (await storedGroups(page))[0]?.author ?? ''),
  );

  await test.step('any two shares rebuild the backup key, under which the relay’s backup opens', async () => {
    for (const pair of [
      [shares.ben, shares.cal],
      [shares.cal, deesOld],
      [deesOld, shares.ben],
    ]) {
      const rebuilt = await combineShares(pair.map(({ share }) => share));
      expect(Buffer.from(rebuilt ?? [])).toEqual(Buffer.from(oldKey));
    }
    const response = await request.get(`/v1/backup/${oldId}`);
    expect(response.status()).toBe(200);
    expect(openRelayBackup(oldKey, await response.body())).not.toBeNull();
  });

  await test.step('Ana chooses again without Cal: the old id opens nothing, nor do Cal’s old shares', async () => {
    await ana.page.getByRole('link', { name: 'Choose again' }).click();
    await expect(heading(ana.page, 'Choose again')).toBeVisible();
    await expectAccessible(ana, 'the recovery picker, choosing again');
    await pick(ana, 2, [NAMES.ben, NAMES.dee, NAMES.eve]);
    const newKey = Uint8Array.from(await backupKeyOn(ana.page));
    expect(Buffer.from(newKey)).not.toEqual(Buffer.from(oldKey));
    await expect
      .poll(async () => (await (await request.get(`/v1/backup/${oldId}`)).body()).length, SYNCED)
      .toBe(65536);
    const scrubbed = await (await request.get(`/v1/backup/${oldId}`)).body();
    expect(openRelayBackup(oldKey, scrubbed)).toBeNull();

    await expect
      .poll(async () => (await shareOf(ben, author)).split, SYNCED)
      .not.toBe(shares.ben.split);
    await expect
      .poll(async () => (await shareOf(eve, author)).split, SYNCED)
      .toBe((await shareOf(ben, author)).split);
    const bensNew = await shareOf(ben, author);
    const evesNew = await shareOf(eve, author);
    const oldPair = await combineShares([shares.cal.share, shares.ben.share]);
    expect(Buffer.from(oldPair ?? [])).toEqual(Buffer.from(oldKey));
    const mixed = await combineShares([shares.cal.share, bensNew.share]);
    expect(Buffer.from(mixed ?? [])).not.toEqual(Buffer.from(newKey));
    const rebuilt = await combineShares([bensNew.share, evesNew.share]);
    expect(Buffer.from(rebuilt ?? [])).toEqual(Buffer.from(newKey));
    const fresh = await request.get(`/v1/backup/${backupIdFor(newKey)}`);
    expect(openRelayBackup(newKey, await fresh.body())).not.toBeNull();
    later.push(bensNew, evesNew);
  });

  const newKey = Uint8Array.from(await backupKeyOn(ana.page));
  const canaries: Canary[] = [
    ...keyCanaries('the old backup key', oldKey),
    ...keyCanaries('the new backup key', newKey),
    ...shareCanaries('Ben', shares.ben),
    ...shareCanaries('Cal', shares.cal),
    ...shareCanaries('Dee', deesOld),
    ...later.flatMap((share, i) => shareCanaries(`a new contact (${String(i + 1)})`, share)),
    ...Object.entries(NAMES).map(([who, name]) => textCanary(`${who}’s name`, name)),
    ...contactKeys.map((key, i) => textCanary(`contact ${String(i + 1)}’s key`, key)),
  ];

  await test.step('no request any profile sent carries a key, a share, a split or the contact list', () => {
    const findings = requests.flatMap((sent, index) =>
      findIn(
        Buffer.concat([Buffer.from(sent.url()), sent.postDataBuffer() ?? Buffer.alloc(0)]),
        `request ${String(index)} ${sent.method()} ${new URL(sent.url()).pathname}`,
        canaries,
      ),
    );
    expect(findings.map(describeFinding)).toEqual([]);
    // The control: the same scan finds the new backup's id in the PUT that uploaded it.
    const control = [textCanary('the new backup id', backupIdFor(newKey))];
    const seen = requests.flatMap((sent) => findIn(Buffer.from(sent.url()), 'url', control));
    expect(seen.length).toBeGreaterThan(0);
  });

  await test.step('the stopped relay holds none of them, though it holds the backups', async () => {
    for (const { page } of everyone) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);
    const db = new DatabaseSync(relay.db, { timeout: 10_000 });
    let blob: Uint8Array;
    try {
      const row = db.prepare('SELECT blob FROM backups WHERE id = ?').get(backupIdFor(newKey)) as
        { blob: Uint8Array } | undefined;
      blob = row?.blob ?? randomBytes(64);
    } finally {
      db.close();
    }
    const controls = [
      { label: 'the new backup', bytes: Uint8Array.from(blob.subarray(28, 92)) },
      textCanary('the new backup id', backupIdFor(newKey)),
    ];
    expect(new Set(scan(files, controls).map(({ label }) => label))).toEqual(
      new Set(['the new backup', 'the new backup id']),
    );
  });
});
