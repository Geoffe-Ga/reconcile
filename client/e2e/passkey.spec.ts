/**
 * Passkey unlock (#95), end to end through the real relay and the deploy CSP.
 *
 * Chromium stands in for a phone's passkey with a CDP virtual authenticator:
 * CTAP2, internal transport, resident keys and user verification, with PRF
 * on or off. A passkey's relying party must be a domain, never an IP
 * address, so these profiles open the app at `localhost` on the same port.
 *
 * - With PRF, Ana founds a group and restores her own backup file, carrying
 *   a relay backup key (#97), so her device keeps one and backs up to the
 *   relay. She locks her keys from Settings, and Ben locks his from the offer
 *   after the notice, before he joins. Then neither device's IndexedDB holds
 *   a signing key, encryption key (#98), group secret or relay backup key
 *   outside the vault, as raw bytes or base64url, and no group record or
 *   relay backup record carries one.
 *   Ana proposes. A reload shows the unlock screen, and the page sends the
 *   relay nothing while it's locked; PRF output whose flags say the user
 *   wasn't verified leaves it locked, with Try again, Restore a backup file
 *   and Erase; unlocking brings back voting, Settings reads the relay
 *   backup's line again, and Ben's tally counts Ana's vote.
 * - Without PRF, Cal's keys stay plain and the no-PRF line shows, with Save a
 *   backup, and a reload opens the app with no unlock screen.
 *
 * axe checks every new screen. WebKit has no virtual authenticator (Playwright
 * offers CDP's WebAuthn domain in Chromium only), so the passkey steps skip
 * there; the offer itself still meets WebKit in every other spec's
 * `acceptNotice`.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import type { CDPSession, Page } from '@playwright/test';

import { noFileSharing, withBackupKey } from './support/backupFile';

import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  PASSKEY_OFFER,
  pick,
  type Person,
  test,
} from './support/fixtures';
import { describeFinding, findIn, keyCanaries } from './support/scan';
import { onlyGroup } from './support/stored';

const GROUP = 'Canary Lane Allotments';
const TITLE = 'Canary title: water at dusk';
const PASSPHRASE = 'a long walk to the river, then bread';
/** The relay backup's line once an upload landed (#97). */
const BACKED_UP = /^Backed up to the relay /;

/** The record kinds IndexedDB holds once a device's keys are sealed. */
interface RawDatabase {
  /** Every key and value in every object store, as bytes: strings as UTF-8, byte arrays as they are. */
  readonly bytes: Buffer;
  /** Each group record's field names. */
  readonly groupFields: readonly string[][];
  /** Each relay backup record's field names (#97). */
  readonly backupFields: readonly string[][];
  /** The object stores, by name. */
  readonly stores: readonly string[];
}

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'WebKit has no virtual authenticator: Playwright drives WebAuthn only through Chromium’s CDP.',
);

/** The app's origin on `localhost`, since a passkey's relying party can't be an IP address. */
function localhostOf(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? '');
  url.hostname = 'localhost';
  return url.origin;
}

/** Gives `page` a platform authenticator as a phone has: CTAP2, internal, resident keys, UV. */
async function addAuthenticator(
  page: Page,
  hasPrf: boolean,
): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
    },
  });
  return { cdp, id: authenticatorId };
}

/** Everything the app's IndexedDB holds on `page`, read with no hook into the app. */
async function rawDatabase(page: Page): Promise<RawDatabase> {
  const read = await page.evaluate(async () => {
    const request = <T>(asking: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        asking.onsuccess = () => {
          resolve(asking.result);
        };
        asking.onerror = () => {
          reject(asking.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const parts: number[][] = [];
    const walk = (value: unknown): void => {
      if (ArrayBuffer.isView(value)) {
        parts.push(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
      } else if (value instanceof Map) {
        for (const entry of value.entries()) walk(entry);
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          walk(key);
          walk(inner);
        }
      } else {
        parts.push(Array.from(new TextEncoder().encode(String(value))));
      }
    };
    const db = await request(indexedDB.open('reconcile'));
    try {
      const stores = Array.from(db.objectStoreNames);
      for (const name of stores) {
        const store = db.transaction(name).objectStore(name);
        walk(await request(store.getAllKeys()));
        walk(await request(store.getAll()));
      }
      const fieldsOf = async (name: string) =>
        ((await request(db.transaction(name).objectStore(name).getAll())) as object[]).map(
          (record) => Object.keys(record).sort(),
        );
      return {
        parts,
        stores,
        groupFields: await fieldsOf('groups'),
        backupFields: await fieldsOf('device'),
      };
    } finally {
      db.close();
    }
  });
  const bytes = Buffer.concat(read.parts.flatMap((part) => [Buffer.from(part), Buffer.of(0)]));
  const { stores, groupFields, backupFields } = read;
  return { bytes, stores, groupFields, backupFields };
}

/** Locks `person`'s keys with a passkey in two taps, from the offer or Settings, and checks the line. */
async function lockKeys(person: Person, screen: string): Promise<void> {
  const { page } = person;
  await page.getByRole('button', { name: 'Make a passkey' }).click();
  await page.getByRole('button', { name: 'Confirm your passkey' }).click();
  await expect(
    page.getByText(
      'Your keys on this device are locked with your passkey. Reconcile asks for it each time it opens.',
    ),
  ).toBeVisible();
  await expectAccessible(person, `${screen}, keys locked`);
}

/** Opens Settings from Start. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(heading(page, 'Settings')).toBeVisible();
}

/**
 * `person` saves a backup from Settings through the download path, and
 * restores that file with `key` added as its relay backup key (#97), so the
 * device keeps the key and backs up to the relay at its next sync.
 */
async function keepRelayBackupKey(person: Person, key: Uint8Array, path: string): Promise<void> {
  const { page } = person;
  await openSettings(page);
  const save = page.getByRole('region', { name: 'Back up your groups' });
  await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await save.getByLabel('Passphrase again').fill(PASSPHRASE);
  await save.getByRole('button', { name: 'Make a backup file' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    save.getByRole('button', { name: 'Save the file' }).click(),
  ]);
  writeFileSync(path, await withBackupKey(await download.path(), key, PASSPHRASE));
  const restore = page.getByRole('region', { name: 'Restore a backup' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    restore.getByRole('button', { name: 'Choose backup file' }).click(),
  ]);
  await chooser.setFiles(path);
  await restore.getByLabel('Its passphrase').fill(PASSPHRASE);
  await restore.getByRole('button', { name: 'Restore' }).click();
  await expect(restore.getByText('1 group is back on this device.')).toBeVisible();
  await expect(save.getByRole('status').filter({ hasText: BACKED_UP })).toBeVisible({
    timeout: 15_000,
  });
}

test('with PRF, the keys live only in the vault, and the passkey unlocks voting after a reload', async ({
  openProfile,
  baseURL,
}, testInfo) => {
  const origin = localhostOf(baseURL);
  const ana = await openProfile('Ana', { baseURL: origin });
  await ana.page.context().addInitScript(noFileSharing);
  const backupKey = randomBytes(32);
  const ben = await openProfile('Ben', { baseURL: origin, viewport: { width: 390, height: 844 } });
  const anaKey = await addAuthenticator(ana.page, true);
  await addAuthenticator(ben.page, true);

  const invite = await test.step('Ana says Not now to the offer, then founds a group', async () => {
    await ana.page.goto('/');
    expect((await acceptNotice(ana)).passkeyOffered).toBe(true);
    return foundGroup(ana.page, {
      name: GROUP,
      title: 'Plot rules',
      atoms: ['Water at dawn.', 'Share the tools.'],
      founder: 'Ana',
    });
  });
  const plain = await onlyGroup(ana.page);

  await test.step('Ana keeps a relay backup key (#97), from her own backup file', async () => {
    await keepRelayBackupKey(ana, backupKey, testInfo.outputPath('backup-with-key.bin'));
  });

  await test.step('Ana locks her keys from Settings', async () => {
    await openSettings(ana.page);
    const section = ana.page.getByRole('region', { name: 'Lock with a passkey' });
    await expect(
      section.getByText('The first time, your phone asks twice', { exact: false }),
    ).toBeVisible();
    await expectAccessible(ana, 'Settings, passkey offered');
    await lockKeys(ana, 'Settings');
  });

  await test.step('Ben locks his keys from the offer after the notice, then joins', async () => {
    await ben.page.goto(invite);
    await acceptNotice(ben, { passkey: true });
    await expect(heading(ben.page, PASSKEY_OFFER)).toBeVisible();
    await expectAccessible(ben, 'Passkey offer');
    await lockKeys(ben, 'Passkey offer');
    await ben.page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(ben.page, GROUP)).toBeVisible();
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill('Ben');
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText(
      'Ana',
    );
  });

  await test.step('neither IndexedDB holds a key or secret outside the vault', async () => {
    const canaries = [
      ...keyCanaries('Ana’s signing key', Uint8Array.from(plain.signingKey)),
      ...keyCanaries('group secret', Uint8Array.from(plain.secret)),
      ...keyCanaries('Ana’s relay backup key', Uint8Array.from(backupKey)),
      ...(plain.kxKey === null
        ? []
        : keyCanaries('Ana’s encryption key', Uint8Array.from(plain.kxKey))),
    ];
    expect(plain.kxKey).toHaveLength(32);
    for (const person of [ana, ben]) {
      const raw = await rawDatabase(person.page);
      expect(raw.stores).toEqual(['device', 'groups', 'personal', 'vault']);
      expect(
        findIn(raw.bytes, `${person.name}’s IndexedDB`, canaries).map(describeFinding),
      ).toEqual([]);
      for (const fields of raw.groupFields) {
        expect(fields).not.toContain('secret');
        expect(fields).not.toContain('signingKey');
        expect(fields).not.toContain('kxKey');
      }
    }
    // Ana's relay backup record keeps its state, and the vault its key.
    expect((await rawDatabase(ana.page)).backupFields).toEqual([
      ['checkedDay', 'digest', 'tooLarge', 'uploadedAt'],
    ]);
  });

  await test.step('Ana proposes, so there is something to vote on after the reload', async () => {
    const { page } = ana;
    await page.goto('/#/');
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await page.getByRole('link', { name: 'Plot rules' }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Why' }).fill('Cooler in the evening.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Water at dusk.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Score for version 1' })).toBeVisible();
  });

  await test.step('a reload shows the unlock screen, and a passkey that didn’t verify the user leaves it locked', async () => {
    const { page } = ana;
    // The authenticator still gives PRF output, but its flags say the user wasn't verified.
    await anaKey.cdp.send('WebAuthn.setResponseOverrideBits', {
      authenticatorId: anaKey.id,
      isBadUV: true,
    });
    const whileLocked: string[] = [];
    const record = (request: { url: () => string }) => {
      if (new URL(request.url()).pathname.startsWith('/v1/')) whileLocked.push(request.url());
    };
    page.on('request', record);
    await page.goto('/');
    await expect(heading(page, 'Unlock Reconcile')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(GROUP) })).toHaveCount(0);
    await expectAccessible(ana, 'Unlock');
    await page.getByRole('button', { name: 'Unlock with your passkey' }).click();
    await expect(page.getByRole('alert')).toHaveText('Your passkey didn’t unlock Reconcile.');
    await expect(page.getByRole('region', { name: 'Restore a backup' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Erase this device' })).toBeVisible();
    await expectAccessible(ana, 'Unlock, failed');
    // Nothing syncs while locked, so neither a group nor the relay backup (#97) reaches the relay.
    page.off('request', record);
    expect(whileLocked).toEqual([]);
  });

  await test.step('the passkey unlocks the keys, and Ana votes', async () => {
    const { page } = ana;
    await anaKey.cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId: anaKey.id });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    const needs = page.getByRole('region', { name: 'Needs your vote' });
    await needs.getByRole('link', { name: new RegExp(TITLE) }).click();
    await pick(page, '4 · Strongly supportive');
    await page.getByRole('button', { name: /your vote$/ }).click();
    await expect(page.getByText('Sent', { exact: true })).toBeVisible();
    await openSettings(page);
    await expect(
      page.getByRole('region', { name: 'Lock with a passkey' }).getByRole('button'),
    ).toHaveCount(0);
    // The relay backup's state reads again, its key from the vault (#97).
    await expect(
      page
        .getByRole('region', { name: 'Back up your groups' })
        .getByRole('status')
        .filter({ hasText: BACKED_UP }),
    ).toBeVisible();
  });

  await test.step('Ben’s tally counts Ana’s vote', async () => {
    const { page } = ben;
    await page.goto('/#/');
    await page.getByRole('link', { name: new RegExp(GROUP) }).click();
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(TITLE) })
      .click();
    const meter = page.getByRole('group', { name: 'How version 1 stands so far' });
    await expect(meter).toContainText('Scored by 1', { timeout: 30_000 });
  });
});

test('without PRF, the keys stay as they were, and the app says so plainly', async ({
  openProfile,
  baseURL,
}) => {
  const cal = await openProfile('Cal', { baseURL: localhostOf(baseURL), colorScheme: 'dark' });
  await addAuthenticator(cal.page, false);
  const { page } = cal;

  await test.step('the offer makes a passkey, and the second tap finds no PRF', async () => {
    await page.goto('/');
    await acceptNotice(cal, { passkey: true });
    await page.getByRole('button', { name: 'Make a passkey' }).click();
    await page.getByRole('button', { name: 'Confirm your passkey' }).click();
    await expect(
      page.getByText(
        'This device’s passkey can’t protect your keys, so they stay on this device as before.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Save a backup' })).toHaveAttribute(
      'href',
      '#/settings',
    );
    await expectAccessible(cal, 'Passkey offer, no PRF');
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  await test.step('a group founded after keeps its keys plain, with no vault', async () => {
    await foundGroup(page, {
      name: GROUP,
      title: 'Plot rules',
      atoms: ['Water at dawn.'],
      founder: 'Cal',
    });
    const held = await onlyGroup(page);
    expect(held.signingKey).toHaveLength(32);
    expect(held.secret).toHaveLength(32);
    const raw = await rawDatabase(page);
    const vault = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open('reconcile');
          open.onsuccess = () => {
            const count = open.result.transaction('vault').objectStore('vault').count();
            count.onsuccess = () => {
              open.result.close();
              resolve(count.result);
            };
          };
        }),
    );
    expect(raw.stores).toEqual(['device', 'groups', 'personal', 'vault']);
    expect(vault).toBe(0);
  });

  await test.step('a reload opens the app, with no unlock screen', async () => {
    await page.goto('/');
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(GROUP) })).toBeVisible();
  });
});
