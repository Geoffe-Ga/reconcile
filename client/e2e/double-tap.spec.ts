/**
 * A double tap on a busy submit button submits once (#190, #192, #193), in
 * Chromium, through the real relay and the deploy CSP. React Aria's usePress
 * starts a press on pointerdown even on a disabled button, and Chromium gives a
 * disabled button pointerdown and pointerup but no click, so 80 ms later
 * usePress clicks the button itself. If the save had finished by then, the
 * button was enabled again, and that click sent its form a second time.
 *
 * Two sites. The ballot (#192) is enabled again once its ballot is saved,
 * with "Sent". The Composer, which signs a Proposal, is enabled again only
 * when the Proposal couldn't be saved: here, because another tab opened the
 * app's database at a newer version, as a tab running a newer Reconcile
 * would, so this tab's store closed (src/store/db.ts). A second submit there
 * would try to sign it again, unasked. That is the last step, since this tab
 * can't save anything afterwards.
 *
 * The test holds the app's group store in a transaction of its own while it
 * double-taps, as a slow phone would, so the second tap lands while the
 * button is disabled. Then it lets the save go ahead and waits past the 80 ms.
 * A capture listener on the document counts every submit event: exactly one
 * per double tap. Without `holdPresses`, each double tap counts two.
 */
import { type Page } from '@playwright/test';

import { acceptNotice, expect, foundGroup, heading, pick, test } from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PROPOSAL = 'Later quiet hours';

/** How long React Aria's usePress waits for a click before clicking a pressed button itself. */
const PRESS_FALLBACK_MS = 80;

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Measured in Chromium (#192), which gives a disabled button pointerdown and pointerup.',
);

/** Counts every submit event in `page` from now on, before the app's own handlers see it. */
async function countSubmits(page: Page): Promise<void> {
  await page.evaluate(() => {
    let count = 0;
    document.addEventListener(
      'submit',
      () => {
        count += 1;
      },
      true,
    );
    Reflect.set(window, 'e2eSubmits', () => count);
  });
}

/** How many submit events `page` has seen since {@link countSubmits}. */
function submits(page: Page): Promise<number> {
  return page.evaluate(() => (Reflect.get(window, 'e2eSubmits') as () => number)());
}

/**
 * Holds the app's `groups` store in a read-write transaction of the test's
 * own, so the app's next read or write of a group waits, as on a slow phone,
 * until the test lets it go. A transaction stays open while it has a request
 * pending, so each count asks for the next one.
 */
async function holdGroups(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((held, failed) => {
        const opening = indexedDB.open('reconcile');
        opening.onerror = () => {
          failed(new Error('IndexedDB refused the open.'));
        };
        opening.onsuccess = () => {
          const db = opening.result;
          const store = db.transaction('groups', 'readwrite').objectStore('groups');
          let holding = true;
          Reflect.set(window, 'e2eHolder', db);
          Reflect.set(window, 'e2eRelease', () => {
            holding = false;
          });
          const keep = (): void => {
            if (holding) store.count().onsuccess = keep;
            else db.close();
          };
          store.count().onsuccess = () => {
            held();
            keep();
          };
        };
      }),
  );
}

/** Lets the app's waiting read or write of a group go ahead. */
async function releaseGroups(page: Page): Promise<void> {
  await page.evaluate(() => {
    (Reflect.get(window, 'e2eRelease') as () => void)();
  });
}

/**
 * Opens the app's database at the next version, as another tab running a
 * newer Reconcile would, then lets the held store go. The app closes its own
 * connection when it hears of the newer version (src/store/db.ts), so the save
 * it began fails. It hears in the same step as the test's connection, ahead of
 * it, so the store is let go only once the app's connection is closing.
 */
async function releaseIntoNewerTab(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const holder = Reflect.get(window, 'e2eHolder') as IDBDatabase;
        holder.onversionchange = () => {
          (Reflect.get(window, 'e2eRelease') as () => void)();
          done();
        };
        indexedDB.open('reconcile', holder.version + 1);
      }),
  );
}

/** Double-taps the button `name` while the group store is held, and checks the second tap found it off. */
async function doubleTapWhileHeld(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name });
  await holdGroups(page);
  await button.dblclick();
  await expect(button).toBeDisabled();
}

/** Waits past usePress's own click, so a second submit has had its chance. */
async function pastPressFallback(page: Page): Promise<void> {
  await page.waitForTimeout(PRESS_FALLBACK_MS * 3);
}

test('a double tap on a busy Send your vote or Propose submits once', async ({ openProfile }) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const { page } = ana;

  await test.step('A creates a group, and B joins it', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    const invite = await foundGroup(page, {
      name: GROUP,
      title: TITLE,
      atoms: ['Quiet hours start at 10pm.', 'Bins go out on Tuesday.'],
      founder: ana.name,
    });
    await ben.page.goto(invite);
    await acceptNotice(ben);
    await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
    await ben.page.getByRole('button', { name: 'Join group' }).click();
    await expect(page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
  });

  await test.step('A proposes, and a double tap on Send your vote sends one ballot (#192)', async () => {
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, PROPOSAL)).toBeVisible();

    await countSubmits(page);
    await pick(
      page,
      '4 · Strongly supportive',
      page.getByRole('radiogroup', { name: 'Score for version 1' }),
    );
    await doubleTapWhileHeld(page, 'Send your vote');
    await releaseGroups(page);
    await expect(page.locator('.ballot-send').getByRole('status')).toHaveText('Sent');
    await pastPressFallback(page);
    await expect(page.getByRole('button', { name: /your vote$/ })).toBeEnabled();
    expect(await submits(page)).toBe(1);
  });

  await test.step('a double tap on Propose that can’t be saved submits once', async () => {
    await page.getByRole('link', { name: GROUP }).click();
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 2' }).click();
    await expect(heading(page, 'Propose a change')).toBeVisible();
    await page.getByRole('textbox', { name: 'Title' }).fill('Bins on Monday');
    await page.getByRole('textbox', { name: 'Why' }).fill('The collection day moved.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Bins go out on Monday.');

    await doubleTapWhileHeld(page, 'Propose this change');
    await releaseIntoNewerTab(page);
    await expect(page.getByRole('alert')).toHaveText(
      'Your Proposal couldn’t be saved on this device. Try again.',
    );
    await pastPressFallback(page);
    await expect(page.getByRole('button', { name: 'Propose this change' })).toBeEnabled();
    expect(await submits(page)).toBe(2);
  });
});
