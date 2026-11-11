/**
 * The relay backup (#97), end to end through the real relay and the deploy
 * CSP: a device restored from a backup file that carries the relay backup
 * key keeps the relay backup fresh (ADR-0075 §4), and the relay learns
 * nothing from it.
 *
 * Choosing recovery contacts (#109) starts the relay backup, and
 * `recovery.spec.ts` takes that path. Here the key comes from a file: Ana
 * saves a backup file from Settings, and the test opens it with her
 * passphrase, adds a random backup key, as a file saved on a device that
 * keeps one holds it, and seals it again. A fresh phone restores that file from Start. Its first complete
 * sync pass uploads one blob, and Settings says "Backed up to the relay".
 *
 * The blob the relay serves is one of the five sizes and opens under the
 * key to Ana's group, without the key itself. Then the relay stops, and the
 * `backups` row holds the id, the blob and a whole expiry day, 181 days
 * out. Its database, WAL, shared memory and log hold no group name, name,
 * Document text, signing key, group secret or seal key, and neither the
 * backup key nor its seal key, in any spelling. Two controls keep the scan
 * honest: the scan must find the blob's own bytes and its id, the things the
 * relay is meant to keep.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { Page } from '@playwright/test';

import { openRelayBackup } from '../src/crypto/relayBackup';
import { noFileSharing, withBackupKey } from './support/backupFile';
import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  type Person,
  test,
} from './support/fixtures';
import { type Canary, describeFinding, keyCanaries, scan, textCanary } from './support/scan';
import { derive, onlyGroup } from './support/stored';

const CANARY = {
  group: 'Canary Relay Commons',
  founder: 'Canaryrosa Founder',
  title: 'Canary title: our shared shelf',
  atom: 'Canary atom: the shelf is open to all.',
};
const PASSPHRASE = 'a long walk to the river, then bread';
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 800 };
const SIZES = [65536, 262144, 1048576, 4194304, 16777216];
const DAY_MS = 86_400_000;

/** Opens Settings from Start's link. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(heading(page, 'Settings')).toBeVisible();
}

/** Ana saves a backup from Settings, through the download path, and returns its path. */
async function saveBackup(ana: Person): Promise<string> {
  const { page } = ana;
  await openSettings(page);
  const section = page.getByRole('region', { name: 'Back up your groups' });
  await expect(section.getByText(/relay/)).toHaveCount(0);
  await section.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await section.getByLabel('Passphrase again').fill(PASSPHRASE);
  await section.getByRole('button', { name: 'Make a backup file' }).click();
  const save = section.getByRole('button', { name: 'Save the file' });
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  return download.path();
}

/** A fresh profile restores the file at `path` from Start. */
async function restore(person: Person, path: string): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await acceptNotice(person);
  const section = page.getByRole('region', { name: 'Have a backup file?' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    section.getByRole('button', { name: 'Choose backup file' }).click(),
  ]);
  await chooser.setFiles(path);
  await section.getByLabel('Its passphrase').fill(PASSPHRASE);
  await section.getByRole('button', { name: 'Restore' }).click();
  await expect(section.getByText('1 group is back on this device.')).toBeVisible();
}

test('a restored device keeps the relay backup fresh, and the relay learns nothing from it', async ({
  openProfile,
  relay,
  request,
}, testInfo) => {
  const ana = await openProfile(CANARY.founder, { viewport: LAPTOP });
  await ana.page.context().addInitScript(noFileSharing);
  const phone = await openProfile('Phone', { viewport: PHONE, colorScheme: 'dark' });
  const key = randomBytes(32);
  const id = derive(key, 'reconcile/v1/backup-id').toString('base64url');

  await test.step('Ana founds the group and saves a backup file', async () => {
    await ana.page.goto('/');
    await acceptNotice(ana);
    await foundGroup(ana.page, {
      name: CANARY.group,
      title: CANARY.title,
      atoms: [CANARY.atom, 'Bring back what you borrow.'],
      founder: CANARY.founder,
    });
    const keyed = testInfo.outputPath('backup-with-key.bin');
    writeFileSync(keyed, await withBackupKey(await saveBackup(ana), key, PASSPHRASE));
    await restore(phone, keyed);
  });

  await test.step('the restored phone uploads after its first complete pass, and says so', async () => {
    await openSettings(phone.page);
    const section = phone.page.getByRole('region', { name: 'Back up your groups' });
    await expect(
      section.getByRole('status').filter({ hasText: /^Backed up to the relay / }),
    ).toBeVisible({ timeout: 15_000 });
    await expectAccessible(phone, 'Settings, backed up to the relay');
  });

  const group = await onlyGroup(ana.page);
  expect(group.kxKey).toHaveLength(32);
  let blob: Buffer = Buffer.alloc(0);

  await test.step('the relay serves one padded blob that opens to Ana’s group, without the key', async () => {
    const response = await request.get(`/v1/backup/${id}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/octet-stream');
    blob = await response.body();
    expect(SIZES).toContain(blob.length);
    const plaintext = openRelayBackup(key, blob);
    if (plaintext === null) throw new Error('Expected the backup to open under its key.');
    const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as {
      format: number;
      groups: { groupId: string; epoch: number; kxKey?: string }[];
    };
    expect(Object.keys(snapshot)).toEqual(['format', 'groups', 'personal']);
    expect(snapshot.groups.map(({ groupId }) => groupId)).toEqual([group.groupId]);
    // Format 2 (#98): the group's epoch and Ana's encryption key, so a restore can open new keys.
    expect(snapshot.format).toBe(2);
    expect(snapshot.groups.map(({ epoch, kxKey }) => [epoch, kxKey])).toEqual([
      [group.epoch, Buffer.from(group.kxKey ?? []).toString('base64url')],
    ]);
    const unknown = await request.get(`/v1/backup/${randomBytes(32).toString('base64url')}`);
    expect([unknown.status(), await unknown.json()]).toEqual([404, { error: 'not_found' }]);
  });

  await test.step('the relay stops, and holds only the id, the blob and a whole day', async () => {
    for (const { page } of [ana, phone]) await page.context().setOffline(true);
    const today = Math.floor(Date.now() / DAY_MS);
    await relay.stop();
    const db = new DatabaseSync(relay.db, { timeout: 10_000 });
    try {
      const rows = db
        .prepare('SELECT id, length(blob) AS size, expiry FROM backups WHERE id = ?')
        .all(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.size).toBe(blob.length);
      expect([today + 181, today + 180]).toContain(rows[0]?.expiry);
      const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('backups');
      expect(columns.map(({ name }) => name)).toEqual(['id', 'blob', 'expiry']);
    } finally {
      db.close();
    }

    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const secret = Uint8Array.from(group.secret);
    const canaries: Canary[] = [
      ...Object.entries(CANARY).map(([field, text]) => textCanary(field, text)),
      ...keyCanaries('Ana’s signing key', Uint8Array.from(group.signingKey)),
      ...keyCanaries('Ana’s encryption key', Uint8Array.from(group.kxKey ?? [])),
      ...keyCanaries('the group secret', secret),
      ...keyCanaries('the group’s seal key', derive(secret, 'reconcile/v1/seal-key')),
      ...keyCanaries('the backup key', key),
      ...keyCanaries('the backup’s seal key', derive(key, 'reconcile/v1/backup-seal')),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay keeps, the blob and its id.
    const controls = [
      { label: 'the blob', bytes: Uint8Array.from(blob.subarray(28, 92)) },
      textCanary('the backup id', id),
    ];
    expect(new Set(scan(files, controls).map(({ label }) => label))).toEqual(
      new Set(['the blob', 'the backup id']),
    );
  });
});
