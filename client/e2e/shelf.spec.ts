/**
 * The public shelf, end to end (#434; ADR-0081; docs/spec/listed-doors.md §1
 * steps 1, 2, 3 and 5, §7, §8), under the deploy CSP and through the real
 * relay, which runs with the tests' steward key as its
 * `RECONCILE_RELAY_SHELF_STEWARD_KEY`, a real setting, and an app built with
 * the tests' pins (`scripts/e2e.sh`, #505).
 *
 * Ana founds Oak St Tenants and lists its front door by vote; Bo founds a
 * group under a look-alike name and lists his too, after hers. Ana puts two
 * Dispatches to her group's vote with the shelf line: the first passes both
 * lines, the second passes its Dispatch line and fails its shelf line with a
 * reason for the 0. Bo publishes one of his. Sam, the steward, lists a group
 * of his own and publishes one Dispatch, imports the tests' secret in
 * Settings and releases all three listings from the console.
 * Then every profile reads the relay's clock a day on (`readRelayLater`), and
 * Rae, in no group, reads Ana's entry on Discover under her group's name,
 * never Bo's name or entry, nor the unpublished Dispatch, and opens the
 * group's front door from the entry. Sam then upholds his own group's
 * entry, which the relay deletes, and Tia, a fresh profile, reads its
 * tombstone beside Ana's entry (#489).
 *
 * The stopped relay's files hold the published title, text and name, and
 * hold them only inside the shelf's records; outside those, they hold no
 * canary, and nowhere the unpublished Dispatch, the ballot's reason, a
 * member's name, a group, door or steward secret, a member's key, or the
 * testers' IP address, sent in every forwarding header. axe runs on the
 * listing composer, the two-line ballot, Discover and the tombstone, each in
 * both themes, and any CSP violation fails the run.
 */
import { randomBytes } from 'node:crypto';

import type { APIRequestContext, Page } from '@playwright/test';

import { base64url } from '../src/crypto/base64url';
import { TEST_PINS, TEST_STEWARD, TEST_STEWARD_SECRET } from '../src/test/steward';
import {
  expect,
  expectAccessible,
  heading,
  type NewGroup,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';
import { readRelayLater } from './support/relayNow';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  readFiles,
  scanOutside,
  scanRead,
  shelfRecords,
  textCanary,
  withoutRecords,
} from './support/scan';
import {
  firstRun,
  found,
  importStewardKey,
  listDoor,
  proposeForShelf,
  release,
  SYNC_MS,
  voteTwoLines,
} from './support/steps';
import { derive, onlyGroup, storedLogs } from './support/stored';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

/** TEST-NET-3 (RFC 5737), sent in every forwarding header: an address no tester has. */
const IP = '203.0.113.34';
const FORWARDING = { 'X-Forwarded-For': IP, Forwarded: `for=${IP}`, 'X-Real-IP': IP };

const FOUR = '4 · Strongly supportive';
const ZERO = '0 · Strongly opposed';
const PHONE = { width: 390, height: 844 };

/** The listed group, and a look-alike of its name (a zero for an O, in capitals). */
const LISTED = `Oak St Tenants ${TAG}`;
const LOOKALIKE = `0AK ST TENANTS ${TAG.toUpperCase()}`;
const NAMES = { ana: `Ana${TAG}`, bo: `Bo${TAG}`, sam: `Sam${TAG}` };
const PUBLISHED = { title: `Rent strike vote ${TAG}`, text: `Thursday at seven, canary ${TAG}.` };
const UNPUBLISHED = { title: `Bins rota ${TAG}`, text: `Ours to keep, canary-unpublished ${TAG}.` };
const REASON = `Not under our name, canary-reason ${TAG}`;
const LOOKALIKE_ENTRY = { title: `Free rent ${TAG}`, text: 'Ask us how.' };
/** Sam's own group, whose entry he upholds for the tombstone (#489). */
const UPHELD_GROUP = `Elm Co-op ${TAG}`;
const UPHELD = { title: `Buy followers ${TAG}`, text: 'Cheap.' };

/** A one-person group named `name`, founded by `founder`. */
function groupOf(name: string, founder: string): NewGroup {
  return { name, founder, title: 'House rules', atoms: ['We keep rents fair.'] };
}

/** A relay day and a little more: what an entry waits before it shows (#431). */
const DAY_ON = 1_440 + 5;

/** axe on what `person` sees, in the theme they're in and then the other, ending where it began. */
async function inBothThemes(person: Person, screen: string, start: 'light' | 'dark') {
  const other = start === 'light' ? 'dark' : 'light';
  await expectAccessible(person, `${screen}, ${start}`);
  await person.page.emulateMedia({ colorScheme: other });
  await expectAccessible(person, `${screen}, ${other}`);
  await person.page.emulateMedia({ colorScheme: start });
}

/** The door address a front door's `link` names, which its listing and entries go up under. */
function addressOf(link: string): string {
  return new URL(link).hash.slice('#door/'.length);
}

/** One record as `GET /v1/shelf` and `/v1/shelf/held` page it. */
interface ServedRecord {
  readonly address: string;
  readonly data: string;
}

/** The kind of each record at `address` the relay serves from `path`, in seq order. */
async function kindsAt(
  request: APIRequestContext,
  path: '/v1/shelf' | '/v1/shelf/held',
  address: string,
): Promise<string[]> {
  const response = await request.get(`${path}?after=0&limit=100`);
  expect(response.status()).toBe(200);
  const { records } = (await response.json()) as { records: ServedRecord[] };
  return records
    .filter((record) => record.address === address)
    .map((record) => {
      const message = Buffer.from(record.data, 'base64').subarray(64).toString('utf8');
      return (JSON.parse(message) as { kind: string }).kind;
    });
}

/** An event as a stored record carries it: the bytes after the key and signature, as JSON. */
interface StoredEvent {
  readonly type: string;
  readonly body: { readonly target?: { readonly optIn?: string; readonly value?: unknown } };
}

/** The door's two secrets, read from the opening Proposal in `page`'s stored log. */
async function doorSecrets(page: Page): Promise<Buffer[]> {
  const [log] = await storedLogs(page);
  return (log?.log ?? []).flatMap(([, , hex]) => {
    const event = JSON.parse(Buffer.from(hex, 'hex').subarray(96).toString('utf8')) as StoredEvent;
    const target = event.body.target;
    if (event.type !== 'proposal' || target?.optIn !== 'frontDoor') return [];
    const value = target.value as { sign?: unknown; box?: unknown } | false;
    if (value === false || typeof value.sign !== 'string' || typeof value.box !== 'string') {
      return [];
    }
    return [Buffer.from(value.sign, 'base64url'), Buffer.from(value.box, 'base64url')];
  });
}

/** The relay runs with the tests' steward key for this spec alone, as the founder sets it for real. */
const STEWARD_KEY = 'RECONCILE_RELAY_SHELF_STEWARD_KEY';
let before: string | undefined;
test.beforeAll(() => {
  before = process.env[STEWARD_KEY];
  process.env[STEWARD_KEY] = TEST_PINS.sign;
});
test.afterAll(() => {
  if (before === undefined) Reflect.deleteProperty(process.env, STEWARD_KEY);
  else process.env[STEWARD_KEY] = before;
});

test('the scan sets aside every copy of a shelf record, and nothing else', () => {
  const record = Buffer.from(`{"title":"${PUBLISHED.title}"}`);
  const canary = textCanary('title', PUBLISHED.title);
  const haystack = Buffer.concat([record, randomBytes(9), record, Buffer.from(PUBLISHED.title)]);

  expect(findIn(withoutRecords(haystack, [record]), 'x.db', [canary])).toHaveLength(1);
  expect(findIn(withoutRecords(record, [record]), 'x.db', [canary])).toEqual([]);
  expect(findIn(withoutRecords(record, []), 'x.db', [canary])).not.toEqual([]);
});

test('a listed group publishes one Dispatch by vote, the steward releases it, and a stranger reads it', async ({
  openProfile,
  relay,
  request,
}) => {
  const sam = await openProfile(NAMES.sam, { extraHTTPHeaders: FORWARDING });
  const ana = await openProfile(NAMES.ana, {
    extraHTTPHeaders: FORWARDING,
    viewport: { width: 1280, height: 800 },
  });
  const bo = await openProfile(NAMES.bo, { extraHTTPHeaders: FORWARDING });
  let listedHome = '';
  let listedAt = '';
  let lookalikeAt = '';
  let upheldAt = '';

  await test.step('Ana founds her group and lists its door by vote, with axe on the listing composer', async () => {
    listedHome = await found(ana, groupOf(LISTED, NAMES.ana));
    const link = await listDoor(ana, listedHome, () =>
      inBothThemes(ana, 'Listing composer', 'light'),
    );
    listedAt = addressOf(link);
    // Held until the steward releases it (#488): readers see nothing of it yet.
    await expect
      .poll(() => kindsAt(request, '/v1/shelf/held', listedAt), { timeout: SYNC_MS })
      .toEqual(['listing']);
  });

  await test.step('Bo lists a group under a look-alike name, after hers', async () => {
    const home = await found(bo, groupOf(LOOKALIKE, NAMES.bo));
    lookalikeAt = addressOf(await listDoor(bo, home));
    await expect
      .poll(() => kindsAt(request, '/v1/shelf/held', lookalikeAt), { timeout: SYNC_MS })
      .toEqual(['listing']);
    await proposeForShelf(bo, home, LOOKALIKE_ENTRY);
    await voteTwoLines(bo, FOUR, FOUR);
  });

  await test.step('Sam lists a group of his own and publishes one Dispatch', async () => {
    const home = await found(sam, groupOf(UPHELD_GROUP, NAMES.sam));
    upheldAt = addressOf(await listDoor(sam, home));
    await proposeForShelf(sam, home, UPHELD);
    await voteTwoLines(sam, FOUR, FOUR);
  });

  await test.step('Ana’s first Dispatch passes both lines, with axe on the two-line ballot', async () => {
    await proposeForShelf(ana, listedHome, PUBLISHED);
    await inBothThemes(ana, 'Two-line ballot', 'light');
    await voteTwoLines(ana, FOUR, FOUR);
    await expect(
      ana.page.getByText('Your group put its name to this on the public shelf.'),
    ).toBeVisible({ timeout: SYNC_MS });
  });

  await test.step('her second passes its Dispatch line and fails the shelf line, with a reason', async () => {
    await proposeForShelf(ana, listedHome, UNPUBLISHED);
    await voteTwoLines(ana, FOUR, ZERO, REASON);
    await expect(
      ana.page.getByText('The public shelf line didn’t pass, so this stays in your group.'),
    ).toBeVisible({ timeout: SYNC_MS });
  });

  await test.step('each group’s devices post one entry, held with its listing', async () => {
    for (const address of [listedAt, lookalikeAt, upheldAt]) {
      await expect
        .poll(() => kindsAt(request, '/v1/shelf/held', address), { timeout: SYNC_MS })
        .toEqual(['listing', 'entry']);
    }
    expect(await kindsAt(request, '/v1/shelf', listedAt)).toEqual([]);
  });

  await test.step('Sam imports the tests’ secret in Settings and releases all three listings', async () => {
    await importStewardKey(sam, base64url(TEST_STEWARD_SECRET));
    for (const name of [LISTED, LOOKALIKE, UPHELD_GROUP]) await release(sam, name);
    for (const address of [listedAt, lookalikeAt, upheldAt]) {
      await expect
        .poll(() => kindsAt(request, '/v1/shelf', address), { timeout: SYNC_MS })
        .toEqual(['listing', 'entry']);
    }
    expect(await kindsAt(request, '/v1/shelf/held', listedAt)).toEqual([]);
  });

  // Nothing more crosses between the profiles that hold a group, so every profile,
  // and each new one, reads the relay's clock a day on (#127).
  const rae = await openProfile('Rae', {
    extraHTTPHeaders: FORWARDING,
    viewport: PHONE,
    colorScheme: 'dark',
  });
  const tia = await openProfile('Tia', { extraHTTPHeaders: FORWARDING });
  const later = await Promise.all(
    [ana, bo, sam, rae, tia].map((person) => readRelayLater(person, DAY_ON)),
  );

  await test.step('Rae, in no group, reads Ana’s entry on Discover a relay day later, and nothing of Bo’s', async () => {
    const { page } = rae;
    await firstRun(rae);
    await visit(page, '/#/discover');
    const shelf = page.getByRole('region', { name: 'On the public shelf' });
    await expect(shelf.getByRole('heading', { level: 3 })).toContainText([PUBLISHED.title]);
    await expect(shelf).toContainText(PUBLISHED.text);
    await expect(shelf.locator('.dispatch-from > bdi')).toContainText([LISTED]);
    for (const hidden of [LOOKALIKE, LOOKALIKE_ENTRY.title, UNPUBLISHED.title, NAMES.ana]) {
      await expect(page.getByText(hidden)).toHaveCount(0);
    }
    expect(later[3]?.rewritten()).toBeGreaterThan(0);
    await inBothThemes(rae, 'Discover, the public shelf', 'dark');
  });

  await test.step('she opens its door from the entry', async () => {
    const { page } = rae;
    await page
      .getByRole('article')
      .filter({ hasText: PUBLISHED.title })
      .getByRole('link', { name: 'Share or copy its link' })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: PUBLISHED.title })).toBeVisible();
    await page.getByRole('link', { name: 'Ask to join' }).click();
    await expect(heading(page, LISTED)).toBeVisible({ timeout: SYNC_MS });
    await expect(page).toHaveTitle('Front door · Reconcile');
    await expect(page.getByText(NAMES.ana)).toHaveCount(0);
  });

  await test.step('Sam upholds his group’s entry, and Tia reads its tombstone beside Ana’s (#489)', async () => {
    const { page } = sam;
    // Leaving and coming back reads the console afresh, now that both listings stand.
    await visit(page, '/#/settings');
    await visit(page, '/#/steward');
    await expect(heading(page, 'Steward’s console')).toBeVisible();
    const entry = page
      .getByRole('region', { name: 'On the shelf' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: UPHELD.title }) })
      // The entry's own item, inside its listing's.
      .filter({ hasNot: page.getByRole('listitem') });
    await pick(page, 'C2: spam', entry);
    await entry.getByRole('button', { name: 'Uphold' }).click();
    await expect(
      entry.getByText('Sent. Devices act on it at their next read of the shelf.'),
    ).toBeVisible();

    await firstRun(tia);
    await visit(tia.page, '/#/discover');
    const shelf = tia.page.getByRole('region', { name: 'On the public shelf' });
    const headings = shelf.getByRole('heading', { level: 3 });
    await expect(headings.filter({ hasText: 'Removed: spam' })).toHaveCount(1);
    await expect(headings.filter({ hasText: PUBLISHED.title })).toHaveCount(1);
    await expect(tia.page.getByText(UPHELD.title)).toHaveCount(0);
    await inBothThemes(tia, 'Discover, a tombstone', 'light');
  });

  const founders = [ana, bo, sam];
  const groups = await Promise.all(founders.map((person) => onlyGroup(person.page)));
  const doors = (await Promise.all(founders.map((person) => doorSecrets(person.page)))).flat();
  expect(doors).toHaveLength(6);

  await test.step('the stopped relay holds the published words only in shelf records, and no other canary', async () => {
    for (const moved of later) await moved.stop();
    for (const person of [ana, bo, sam, rae, tia]) await person.page.context().setOffline(true);
    await relay.stop();
    const read = readFiles([relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log]);
    const records = shelfRecords(relay.db);

    const published: Canary[] = [
      textCanary('the published title', PUBLISHED.title),
      textCanary('the published text', PUBLISHED.text),
      textCanary('the listed name', LISTED),
    ];
    // The controls: each published word is in the relay's files, inside a shelf record.
    for (const canary of published) {
      expect(scanRead(read, [canary]).map(({ encoding }) => encoding)).toContain('bytes');
      expect(records.some((record) => findIn(record, 'record', [canary]).length > 0)).toBe(true);
    }
    const never: Canary[] = [
      textCanary('the unpublished title', UNPUBLISHED.title),
      textCanary('the unpublished text', UNPUBLISHED.text),
      textCanary('the ballot’s reason', REASON),
      ...Object.entries(NAMES).map(([who, name]) => textCanary(`${who}'s name`, name)),
      textCanary('the testers’ IP', IP),
      ...groups.flatMap((group, i) => {
        const secret = Uint8Array.from(group.secret);
        return [
          ...keyCanaries(`group ${String(i)}'s secret`, secret),
          ...keyCanaries(`group ${String(i)}'s seal key`, derive(secret, 'reconcile/v1/seal-key')),
          ...keyCanaries(`group ${String(i)}'s signing key`, Uint8Array.from(group.signingKey)),
        ];
      }),
      ...doors.flatMap((secret, i) => keyCanaries(`door secret ${String(i)}`, secret)),
      ...keyCanaries('the steward’s secret', TEST_STEWARD_SECRET),
      ...keyCanaries('the steward’s signing secret', TEST_STEWARD.signing.secretKey),
      ...keyCanaries('the steward’s box secret', TEST_STEWARD.box.secretKey),
    ];
    expect(scanRead(read, never).map(describeFinding)).toEqual([]);
    // Outside the shelf's records, not even the published words.
    expect(scanOutside(read, published, records).map(describeFinding)).toEqual([]);
  });
});
