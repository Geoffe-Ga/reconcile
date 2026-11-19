/**
 * Moderation by exception, end to end (#494; ADR-0081;
 * docs/spec/listed-doors.md §1 step 4, §6, §7), under the deploy CSP and
 * through the real relay, run with the tests' steward key as its
 * `RECONCILE_RELAY_SHELF_STEWARD_KEY` against an app built with the tests'
 * pins (`scripts/e2e.sh`, #505).
 *
 * Ana founds Oak St Tenants, lists its front door by vote and publishes one
 * Dispatch by the shelf line; Sam, the steward, lists a group of his own,
 * imports the tests' secret and releases both listings. Ben joins Ana's
 * group, reads its entry on Discover (a group's own entries show at once,
 * #431) and reports it with a note. Cy, in no group, asks to join through
 * the door with her name and a message. Sam reads the report beside the
 * entry and holds it, and Ben's Discover shows it no more while his Group
 * home says it is held; Sam upholds it, and Ben reads "Removed: spam" in its
 * place; Sam suspends the listing, and Cy's Start and Discover tell her the
 * group she asked to join was removed. Last, Sam holds his own listing and
 * leaves the hold alone, and once every profile reads the relay's clock 7
 * days on (`readRelayLater`), his console lists no hold.
 *
 * Two clocks can't move here. A device reads the shelf at most once an hour
 * by its own clock (`shelf/read.ts`, §5.2), so a reader that must see what
 * changed since its last read moves its kept copy's `readAt` back an hour in
 * its own IndexedDB and reloads, as recover.spec.ts moves an alert's
 * `received`: nothing the relay keeps or the app runs changes. And the
 * relay's hold lapses on the relay's own clock, which nothing moves: the
 * lapse this spec proves is the device's (its fold, which the console
 * shows), while the relay still withholds the listing, as the spec checks.
 * The relay's side is `tests/` (#489).
 *
 * Every request any profile sends is captured, and none carries the
 * report's note, the applicant's name or message, or the steward's secret in
 * any encoding, in its path, query or body; the uphold notice's PUT is the
 * control that is found. The stopped relay's files hold none of them either,
 * and do hold the uphold and suspend notices, the tombstones' records. axe
 * runs on the console and on each tombstone in both themes, and any CSP
 * violation fails the run.
 */
import { randomBytes } from 'node:crypto';

import type { Page, Request } from '@playwright/test';

import { base64url } from '../src/crypto/base64url';
import { SHELF_READ_MS } from '../src/shelf/read';
import { TEST_PINS, TEST_STEWARD, TEST_STEWARD_SECRET } from '../src/test/steward';
import {
  acceptNotice,
  copyInvite,
  expect,
  expectAccessible,
  heading,
  type NewGroup,
  type Person,
  test,
  visit,
} from './support/fixtures';
import { emptyShelf } from './support/relay';
import { readRelayLater } from './support/relayNow';
import {
  type Canary,
  describeFinding,
  findIn,
  keyCanaries,
  readFiles,
  scanRead,
  textCanary,
} from './support/scan';
import {
  consoleItem,
  found,
  hold,
  importStewardKey,
  join,
  listDoor,
  openConsole,
  proposeForShelf,
  release,
  report,
  shelfKinds,
  suspend,
  SYNC_MS,
  uphold,
  voteTwoLines,
} from './support/steps';

/** A random tag, so no two runs plant the same canaries. */
const TAG = randomBytes(6).toString('hex');

const FOUR = '4 · Strongly supportive';
const PHONE = { width: 390, height: 844 };

const LISTED = `Oak St Tenants ${TAG}`;
/** Sam's own group, whose listing he holds and leaves alone. */
const LEFT_ALONE = `Elm Co-op ${TAG}`;
const NAMES = { ana: `Ana${TAG}`, ben: `Ben${TAG}`, sam: `Sam${TAG}` };
const PUBLISHED = { title: `Rent strike vote ${TAG}`, text: `Thursday at seven, ${TAG}.` };
const NOTE = `Looks like a scam to me, canary-note ${TAG}`;
const APPLICANT = `Cy${TAG}`;
const MESSAGE = `I fix bikes on Sundays, canary-message ${TAG}.`;

const SPAM = 'C2: spam';
const IMPERSONATION = 'C3: impersonation of another group or person';
const VIOLENCE = 'C1: a call for violence, or speech that denies a group’s humanity';

/** A one-person group named `name`, founded by `founder`. */
function groupOf(name: string, founder: string): NewGroup {
  return { name, founder, title: 'House rules', atoms: ['We keep rents fair.'] };
}

/**
 * A hold's 7 relay days (`HOLD_MINUTES` in `src/shelf/notices.ts`, which
 * reads the build's pins and so can't load here) and a little more.
 */
const HOLD_ON = 10_080 + 5;

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

/** Keeps every request `person`'s browser sends from now on, its service worker's included. */
function capture(person: Person, into: Request[]): void {
  person.page.context().on('request', (request) => {
    into.push(request);
  });
}

/** A captured request as the scan reads it: its URL (path and query), then its body. */
function bytesOf(request: Request): Buffer {
  return Buffer.concat([Buffer.from(request.url()), request.postDataBuffer() ?? Buffer.alloc(0)]);
}

/**
 * Has `person`'s device read the shelf afresh: its kept copy's `readAt`
 * moves back the hour a read serves, in its own IndexedDB, and the page
 * reloads, so the reader asks the relay again (`shelf/read.ts`). The device
 * must hold a copy, which shows it read the shelf before.
 */
async function readShelfAfresh(person: Person): Promise<void> {
  const { page } = person;
  const moved = await page.evaluate(async (by) => {
    const asked = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB refused the request.'));
        };
      });
    const db = await asked(indexedDB.open('reconcile'));
    try {
      const device = db.transaction('device', 'readwrite').objectStore('device');
      const copy = (await asked(device.get('shelf'))) as { readAt?: unknown } | undefined;
      if (copy === undefined || typeof copy.readAt !== 'number') return false;
      await asked(device.put({ ...copy, readAt: copy.readAt - by }, 'shelf'));
      return true;
    } finally {
      db.close();
    }
  }, SHELF_READ_MS);
  expect(moved).toBe(true);
  await page.reload();
}

/** Discover's public shelf section. */
function shelfOn(page: Page) {
  return page.getByRole('region', { name: 'On the public shelf' });
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

test('a reader reports an entry, the steward holds and upholds it and suspends its listing, and the applicant’s device is told', async ({
  openProfile,
  relay,
  request,
}) => {
  const requests: Request[] = [];
  // The worker's earlier tests may have left the shelf full (`emptyShelf`).
  emptyShelf(relay.db);
  const sam = await openProfile(NAMES.sam);
  const ana = await openProfile(NAMES.ana, { viewport: { width: 1280, height: 800 } });
  const ben = await openProfile(NAMES.ben, { viewport: PHONE, colorScheme: 'dark' });
  const cy = await openProfile(APPLICANT);
  for (const person of [sam, ana, ben, cy]) capture(person, requests);
  let listedHome = '';
  let doorLink = '';
  let listedAt = '';
  let leftAt = '';
  let benHome = '';

  await test.step('Ana lists her group’s door and publishes one Dispatch by the shelf line', async () => {
    listedHome = await found(ana, groupOf(LISTED, NAMES.ana));
    doorLink = await listDoor(ana, listedHome);
    listedAt = addressOf(doorLink);
    await proposeForShelf(ana, listedHome, PUBLISHED);
    await voteTwoLines(ana, FOUR, FOUR);
    await expect(
      ana.page.getByText('Your group put its name to this on the public shelf.'),
    ).toBeVisible({ timeout: SYNC_MS });
  });

  await test.step('Sam lists a group of his own, imports the steward’s secret and releases both listings', async () => {
    leftAt = addressOf(await listDoor(sam, await found(sam, groupOf(LEFT_ALONE, NAMES.sam))));
    for (const address of [listedAt, leftAt]) {
      await expect
        .poll(() => shelfKinds(request, '/v1/shelf/held', address), { timeout: SYNC_MS })
        .toContain('listing');
    }
    await importStewardKey(sam, base64url(TEST_STEWARD_SECRET));
    for (const name of [LISTED, LEFT_ALONE]) await release(sam, name);
    await expect
      .poll(() => shelfKinds(request, '/v1/shelf', listedAt), { timeout: SYNC_MS })
      .toEqual(['listing', 'entry']);
  });

  await test.step('Ben joins Ana’s group and reports its entry from its page, with a note', async () => {
    await visit(ana.page, listedHome);
    const invite = await copyInvite(ana.page);
    benHome = await join(ben, invite, LISTED);
    const { page } = ben;
    await visit(page, '/#/discover');
    // A group's own entries show at once, a relay day before anyone else's (#431).
    await expect(shelfOn(page).getByRole('heading', { level: 3 })).toContainText([PUBLISHED.title]);
    // His group's feed holds the same Dispatch: the shelf's copy is the one to report.
    await shelfOn(page)
      .getByRole('article')
      .filter({ hasText: PUBLISHED.title })
      .getByRole('link', { name: 'Share or copy its link' })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: PUBLISHED.title })).toBeVisible();
    await report(ben, SPAM, NOTE);
  });

  await test.step('Cy, in no group, asks to join through the door with her name and a message', async () => {
    const { page } = cy;
    await visit(page, doorLink);
    await acceptNotice(cy);
    await expect(heading(page, LISTED)).toBeVisible({ timeout: SYNC_MS });
    await page.getByRole('textbox', { name: 'Name you’d like to use' }).fill(APPLICANT);
    await page.getByRole('textbox', { name: 'Why you’d like to join' }).fill(MESSAGE);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      `Sent. If someone in ${LISTED} invites you, it shows on Your groups.`,
    );
  });

  await test.step('Sam reads the report beside the entry, with axe on the console, and holds it', async () => {
    await openConsole(sam);
    const item = consoleItem(
      sam.page,
      'Reports and appeals',
      `About the entry “${PUBLISHED.title}”`,
    );
    await expect(item.getByRole('heading', { name: 'Report: spam' })).toBeVisible();
    await expect(item.getByText(NOTE)).toBeVisible();
    await expect(item.getByText(PUBLISHED.text)).toBeVisible();
    await inBothThemes(sam, 'Steward’s console, a report', 'light');
    await hold(sam, item, SPAM);
    expect(await shelfKinds(request, '/v1/shelf', listedAt)).toEqual(['listing']);
    expect(await shelfKinds(request, '/v1/shelf/held', listedAt)).toEqual(['entry']);
  });

  await test.step('Ben’s Discover shows the entry no more, and his Group home says it is held', async () => {
    const { page } = ben;
    await readShelfAfresh(ben);
    // The same fresh read: his Group home names the hold, which only members see.
    await visit(page, benHome);
    await expect(page.getByText('Held: spam')).toBeVisible({ timeout: SYNC_MS });
    await visit(page, '/#/discover');
    await expect(heading(page, 'Discover')).toBeVisible();
    // His group's feed still holds the Dispatch; the shelf shows nothing of it.
    await expect(shelfOn(page).getByText(PUBLISHED.title)).toHaveCount(0);
  });

  await test.step('Sam upholds it from Holds, and Ben reads “Removed: spam” in its place', async () => {
    await openConsole(sam);
    const item = consoleItem(sam.page, 'Holds', `The entry “${PUBLISHED.title}”`);
    await expect(item.getByText(/^Held: spam\. It shows again on /)).toBeVisible();
    await inBothThemes(sam, 'Steward’s console, a hold', 'light');
    await uphold(sam, item, SPAM);
    expect(await shelfKinds(request, '/v1/shelf/held', listedAt)).toEqual([]);

    const { page } = ben;
    await readShelfAfresh(ben);
    await visit(page, '/#/discover');
    const headings = shelfOn(page).getByRole('heading', { level: 3 });
    await expect(headings.filter({ hasText: 'Removed: spam' })).toHaveCount(1);
    await expect(shelfOn(page).getByText(PUBLISHED.title)).toHaveCount(0);
    await inBothThemes(ben, 'Discover, an upheld entry’s tombstone', 'dark');
  });

  await test.step('Sam suspends the listing, and Cy’s Start and Discover say the group she asked was removed', async () => {
    await openConsole(sam);
    await suspend(sam, consoleItem(sam.page, 'On the shelf', LISTED), IMPERSONATION);
    expect(await shelfKinds(request, '/v1/shelf', listedAt)).toEqual([]);

    const { page } = cy;
    await readShelfAfresh(cy);
    await visit(page, '/');
    const removals = page.getByRole('region', { name: 'Removed from the public shelf' });
    await expect(
      removals.getByText(
        /^A group you asked to join on .+ was removed from the shelf: impersonation of another group or person\.$/,
      ),
    ).toBeVisible({ timeout: SYNC_MS });
    await inBothThemes(cy, 'Start, a removal line', 'light');
    await visit(page, '/#/discover');
    await expect(
      shelfOn(page)
        .getByRole('heading', { level: 3 })
        .filter({ hasText: 'Removed: impersonation of another group or person' }),
    ).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Removed from the public shelf' })).toBeVisible();
    await inBothThemes(cy, 'Discover, a suspended listing’s tombstone', 'light');
  });

  await test.step('Sam holds his own listing and leaves the hold alone', async () => {
    await openConsole(sam);
    await hold(sam, consoleItem(sam.page, 'On the shelf', LEFT_ALONE), VIOLENCE);
    await openConsole(sam);
    await expect(
      consoleItem(sam.page, 'Holds', `The listing “${LEFT_ALONE}” and its entries`),
    ).toBeVisible();
    expect(await shelfKinds(request, '/v1/shelf/held', leftAt)).toEqual(['listing']);
  });

  // Nothing more crosses between the profiles, so every one reads the relay's
  // clock a hold's 7 days on, at once (#127).
  const later = await Promise.all([sam, ana, ben, cy].map((p) => readRelayLater(p, HOLD_ON)));

  await test.step('7 relay days on, the steward’s console lists no hold; the relay, on its own clock, still withholds it', async () => {
    await openConsole(sam);
    await expect(
      sam.page.getByRole('region', { name: 'Holds', exact: true }).getByText('Nothing is held.'),
    ).toBeVisible();
    expect(later[0]?.rewritten()).toBeGreaterThan(0);
    // The relay's clock can't move: its hold lapses on its own minute (`tests/`, #489).
    expect(await shelfKinds(request, '/v1/shelf/held', leftAt)).toEqual(['listing']);
  });

  const never: Canary[] = [
    textCanary('the report’s note', NOTE),
    textCanary('the applicant’s name', APPLICANT),
    textCanary('the applicant’s message', MESSAGE),
    ...keyCanaries('the steward’s secret', TEST_STEWARD_SECRET),
    ...keyCanaries('the steward’s signing secret', TEST_STEWARD.signing.secretKey),
    ...keyCanaries('the steward’s box secret', TEST_STEWARD.box.secretKey),
  ];
  const upholdNotice = textCanary('the uphold notice', '"act":"uphold"');
  const suspendNotice = textCanary('the suspend notice', '"act":"suspend"');

  await test.step('no request carries the note, the applicant’s words or the steward’s secret', () => {
    const leaks = requests.flatMap((sent) => findIn(bytesOf(sent), sent.url(), never));
    expect(leaks.map(describeFinding)).toEqual([]);
    // The control: the uphold notice's PUT is captured, and the scan finds it.
    const controls = requests.filter(
      (sent) => findIn(bytesOf(sent), sent.url(), [upholdNotice]).length > 0,
    );
    expect(controls.map((sent) => sent.method())).toEqual(['PUT']);
  });

  await test.step('the stopped relay holds the tombstones’ notices, and none of them', async () => {
    for (const moved of later) await moved.stop();
    for (const person of [sam, ana, ben, cy]) await person.page.context().setOffline(true);
    await relay.stop();
    const read = readFiles([relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log]);
    for (const control of [upholdNotice, suspendNotice]) {
      expect(scanRead(read, [control]).map(({ encoding }) => encoding)).toContain('bytes');
    }
    expect(scanRead(read, never).map(describeFinding)).toEqual([]);
  });
});
