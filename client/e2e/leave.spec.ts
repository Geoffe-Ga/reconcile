/**
 * Coming back, telling the group, and leaving (#77), end to end through the
 * real relay and the deploy CSP.
 *
 * Ana, on a desktop, proposes and taps Tell your group: the browser's Web
 * Share gets fixed words, the deadline and the app's address, and no title.
 * Ben, on a 390 px phone in the dark theme, finds the Proposal under Needs
 * your vote, where Tell your group shows him the message as it will read and
 * adds the title only once he ticks Include the title (#113). He then leaves
 * from People through the alert dialog, and the group goes from his device
 * once the relay has the leave. axe checks the Proposal view, Group home,
 * People with the dialog open, and Start; the fixture fails on any CSP
 * violation, the dialog's scroll lock included.
 */
import { type Page } from '@playwright/test';

import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  test,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const PROPOSAL = 'Later quiet hours';
const PHONE = { width: 390, height: 844 };

/** Where the stubbed Web Share keeps what it was handed. */
const SHARED = 'e2eShared';

/** Replaces `navigator.share` before the app starts with one that keeps what it's handed. */
function stubWebShare(key: string): void {
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: (data: unknown) => {
      Reflect.set(window, key, data);
      return Promise.resolve();
    },
  });
}

/** The group records this device's IndexedDB holds. */
async function storedGroups(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('reconcile');
        request.onerror = () => {
          reject(new Error('IndexedDB would not open.'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction('groups').objectStore('groups').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
}

/** True when the focused element is inside the open alert dialog. */
async function focusInDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null);
}

async function createAndJoin(ana: Person, ben: Person): Promise<void> {
  await ana.page.goto('/');
  await acceptNotice(ana);
  await ana.page.getByRole('link', { name: 'Create group' }).click();
  await ana.page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
  await ana.page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
  await ana.page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
  await ana.page
    .getByRole('textbox', { name: 'Document text' })
    .fill('Quiet hours start at 10pm.\n\nBins go out on Tuesday.');
  await ana.page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(ana.page, GROUP)).toBeVisible();
  await ana.page.getByRole('button', { name: 'Copy invite link' }).click();
  const invite = await ana.page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await ben.page.goto(invite);
  await acceptNotice(ben);
  await expect(heading(ben.page, GROUP)).toBeVisible();
  await ben.page.getByRole('textbox', { name: 'Your name' }).fill(ben.name);
  await ben.page.getByRole('button', { name: 'Join group' }).click();
  await expect(ben.page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
  await expect(ana.page.getByRole('region', { name: 'People', exact: true })).toContainText('Ben');
}

test('A tells the group a vote is open; B finds it under Needs your vote, then leaves', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana', { viewport: { width: 1280, height: 800 } });
  await ana.page.context().addInitScript(stubWebShare, SHARED);
  const ben = await openProfile('Ben', { viewport: PHONE, colorScheme: 'dark' });
  await createAndJoin(ana, ben);

  await test.step('A proposes, then Tell your group shares no content and no title', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(PROPOSAL);
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekday evenings run later now.');
    await page.getByRole('textbox', { name: 'New text' }).fill('Quiet hours start at 11pm.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await page.getByRole('button', { name: 'Tell your group' }).click();
    await expect(page.getByText('Shared.')).toBeVisible();
    const shared = await page.evaluate((key): unknown => {
      const value: unknown = Reflect.get(window, key);
      return value;
    }, SHARED);
    const origin = new URL(page.url()).origin;
    expect(shared).toEqual({
      text: expect.stringMatching(
        /^A new Proposal is open in Reconcile\. Voting ends \w{3} \d{1,2} \w{3}\.$/,
      ) as unknown,
      url: `${origin}/`,
    });
    expect(Object.keys(shared as object)).toEqual(['text', 'url']);
    await expectAccessible(ana, 'Proposal view');
  });

  await test.step('B finds it under Needs your vote on Group home', async () => {
    const { page } = ben;
    const needs = page.getByRole('region', { name: 'Needs your vote' });
    await expect(needs.getByRole('link', { name: new RegExp(PROPOSAL) })).toBeVisible();
    await expectAccessible(ben, 'Group home');
  });

  await test.step('B sees the message Tell your group shares, and the title only once ticked', async () => {
    const { page } = ben;
    await page
      .getByRole('region', { name: 'Needs your vote' })
      .getByRole('link', { name: new RegExp(PROPOSAL) })
      .click();
    const message = page.locator('.tell-message');
    await expect(message).toHaveText(/^A new Proposal is open in Reconcile\. Voting ends /);
    await page.getByText('Include the title').click();
    await expect(page.getByRole('checkbox', { name: 'Include the title' })).toBeChecked();
    await expect(message).toHaveText(
      new RegExp(`^A new Proposal is open in Reconcile: "${PROPOSAL}"\\. Voting ends `),
    );
    await expectAccessible(ben, 'Proposal view, title included');
    await page.getByRole('link', { name: GROUP }).click();
    await expect(heading(page, GROUP)).toBeVisible();
  });

  await test.step('B opens Leave this group: an alert dialog that keeps focus, and Escape queues nothing', async () => {
    const { page } = ben;
    const open = page.getByRole('button', { name: 'Leave this group' });
    await open.click();
    const dialog = page.getByRole('alertdialog', { name: 'Leave this group?' });
    await expect(dialog).toContainText('When you leave, the group gets a new key');
    await expectAccessible(ben, 'Leave dialog');
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInDialog(page)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    expect(await storedGroups(page)).toBe(1);
  });

  await test.step('B leaves, and the group goes from his device once the relay has it', async () => {
    const { page } = ben;
    await page.getByRole('button', { name: 'Leave this group' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Leave this group' }).click();
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expect(page.getByText('You aren’t in any groups on this device yet.')).toBeVisible();
    expect(await storedGroups(page)).toBe(0);
    await expectAccessible(ben, 'Start');
  });

  await test.step('A sees B gone from People', async () => {
    const { page } = ana;
    await page.getByRole('link', { name: GROUP }).click();
    await expect(
      page.getByRole('region', { name: 'People', exact: true }).getByRole('listitem'),
    ).toHaveText(['Ana, Co-Creator, Steward']);
  });
});
