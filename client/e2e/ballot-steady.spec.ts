/**
 * A ballot holds still while a sync changes what's around it (#407, #354): on
 * a coalition motion's ballot, a tap aimed at a score, the reason field or
 * Send lands where it was aimed, whatever the sync loop brings in meanwhile.
 *
 * - Ana and Dee are in Riverside, Ben in Oak St, and Cy in both. The groups
 *   reconcile, and Ana proposes a coalition motion. Ana, on a phone, and Dee,
 *   at a desktop, each open it in Riverside, score it 0 and write a reason,
 *   but don't send yet.
 * - Cy's own 0 in Riverside syncs in, so each of their consent meters fills
 *   in its readings. Then Oak St passes the motion, so "Across the
 *   coalition" names one group fewer. After each, every score pill, the
 *   reason field and Send sit exactly where they were, and each ballot sends.
 *
 * WebKit has no scroll anchoring, so every scroll position there shows what
 * moves. Chromium's anchoring hides a move above the viewport, so each page
 * turns it off to show what Safari does.
 */
import type { Page } from '@playwright/test';

import {
  copyInvite,
  expect,
  expectAccessible,
  heading,
  pick,
  type Person,
  test,
  visit,
} from './support/fixtures';
import { bringCard, makeCard, type NewCoalition } from './support/coalition';
import {
  expectSent,
  firstRun,
  found,
  join,
  openVote,
  people,
  SYNC_MS,
  vote,
} from './support/steps';

/** Group names long enough that the waiting line wraps at either width. */
const RIVERSIDE = 'Riverside Tenants Association';
const OAK = 'Oak Street Housing Co-operative';

const FOUR = '4 · Strongly supportive';
const ZERO = '0 · Strongly opposed';
const REASON = 'Your reason for a 0';

/** Each founding group's one Document. */
const DOCUMENT = { title: 'House rules', atoms: ['Quiet hours start at ten.'] };

/** The motion Ana proposes, and the tag each group lists it under. */
const MOTION = 'Banks too';

/** A phone: Ana's profile. */
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true };

/**
 * Where each of the ballot's controls sits in the viewport, as
 * `getBoundingClientRect` reads it: its five score pills, the reason field
 * and Send.
 */
async function controls(page: Page): Promise<number[][]> {
  const ballot = page.locator('form.ballot');
  const parts = [
    ballot.locator('.score-pill'),
    ballot.getByRole('textbox', { name: REASON }),
    ballot.getByRole('button', { name: 'Send your vote' }),
  ];
  const rects = await Promise.all(
    parts.map((part) =>
      part.evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return [x, y, width, height];
        }),
      ),
    ),
  );
  return rects.flat();
}

/**
 * `person` opens the motion in Riverside, where it waits on both groups,
 * scores it 0 with a reason, and scrolls to Send, as if about to press it;
 * where the controls sit then is returned.
 */
async function aboutToSend(person: Person, home: string): Promise<number[][]> {
  const { page } = person;
  await openVote(person, home, MOTION, 'Coalition vote');
  // Chromium keeps a scrolled page's content in place when what's above it changes; WebKit doesn't.
  await page.evaluate(() => {
    document.documentElement.style.overflowAnchor = 'none';
    document.body.style.overflowAnchor = 'none';
  });
  const across = page.getByRole('region', { name: 'Across the coalition' });
  await expect(across).toContainText('0 of 2 groups have passed.');
  await expect(page.getByRole('group', { name: 'How version 1 stands so far' })).toContainText(
    'No scores yet',
  );
  await pick(page, ZERO);
  await page.getByRole('textbox', { name: REASON }).fill(`${person.name}’s reason`);
  await page.getByRole('button', { name: 'Send your vote' }).scrollIntoViewIfNeeded();
  const before = await controls(page);
  expect(before).toHaveLength(7);
  return before;
}

test('a coalition motion’s ballot holds still while a ballot and another group’s pass sync in', async ({
  openProfile,
}) => {
  const coalition: NewCoalition = {
    name: 'East Side Housing Coalition',
    statement: ['Everyone on the east side has a safe, warm home.'],
    why: 'We share a river.',
    yourName: 'Ana',
  };
  const reconcileTitle = `Reconcile into ${coalition.name}`;
  const ana = await openProfile('Ana', PHONE);
  const ben = await openProfile('Ben');
  const dee = await openProfile('Dee', { deviceScaleFactor: 2 });
  const cy = await openProfile('Cy');
  const viewers = [ana, dee];
  let homeA = '';
  let homeB = '';
  let where: number[][][] = [];

  await test.step('Ana founds Riverside and Ben Oak St; Dee and Cy join Riverside, and Cy joins Oak St', async () => {
    [homeA, homeB] = await Promise.all([
      found(ana, { ...DOCUMENT, name: RIVERSIDE, founder: 'Ana' }),
      found(ben, { ...DOCUMENT, name: OAK, founder: 'Ben' }),
      firstRun(dee),
      firstRun(cy),
    ]);
    const [inviteA, inviteB] = await Promise.all([copyInvite(ana.page), copyInvite(ben.page)]);
    await Promise.all([
      join(dee, inviteA, RIVERSIDE),
      (async () => {
        await join(cy, inviteA, RIVERSIDE);
        await join(cy, inviteB, OAK, 'Co-Creator');
      })(),
    ]);
    await Promise.all([
      expect(people(ana.page).getByRole('listitem')).toHaveCount(3, { timeout: SYNC_MS }),
      expect(people(ben.page).getByRole('listitem')).toHaveCount(2, { timeout: SYNC_MS }),
    ]);
  });

  await test.step('the groups reconcile', async () => {
    const link = await makeCard(ana, coalition);
    await bringCard(cy, link, { coalition, from: RIVERSIDE, to: OAK, yourName: 'Cy' });
    await Promise.all([
      (async () => {
        await openVote(ana, homeA, reconcileTitle);
        await vote(ana, FOUR);
      })(),
      (async () => {
        await openVote(dee, homeA, reconcileTitle);
        await vote(dee, FOUR);
      })(),
      (async () => {
        await vote(cy, FOUR);
        await openVote(cy, homeA, reconcileTitle);
        await vote(cy, FOUR);
      })(),
      (async () => {
        await openVote(ben, homeB, reconcileTitle);
        await vote(ben, FOUR);
      })(),
    ]);
    await Promise.all(
      [ana, ben].map(async (person) => {
        const home = person === ana ? homeA : homeB;
        await visit(person.page, home);
        const section = person.page.getByRole('region', { name: 'Coalitions' });
        await expect(section).toContainText('Formed', { timeout: SYNC_MS });
      }),
    );
  });

  await test.step('Ana proposes a motion, and Ana and Dee each score it 0 with a reason, unsent', async () => {
    const { page } = ana;
    await page
      .getByRole('region', { name: 'Coalitions' })
      .getByRole('link', { name: 'Open the coalition' })
      .click();
    await expect(heading(page, coalition.name)).toBeVisible();
    await page
      .getByRole('region', { name: 'Documents' })
      .getByRole('link', { name: /Mission statement/ })
      .click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(MOTION);
    await page.getByRole('textbox', { name: 'Why' }).fill('The banks matter.');
    await page
      .getByRole('textbox', { name: 'New text' })
      .fill('Everyone on the east side has a safe, warm home, and a bank that serves them.');
    await page.getByRole('button', { name: 'Propose this change' }).click();
    await expect(heading(page, coalition.name)).toBeVisible();
    where = await Promise.all(viewers.map((person) => aboutToSend(person, homeA)));
  });

  await test.step('Cy’s 0 in Riverside syncs in, and nothing on either ballot moves', async () => {
    await openVote(cy, homeA, MOTION, 'Coalition vote');
    await vote(cy, ZERO, 'Cy’s reason');
    await Promise.all(
      viewers.map(async (person, i) => {
        const meter = person.page.getByRole('group', { name: 'How version 1 stands so far' });
        await expect(meter).toContainText('Scored by 1', { timeout: SYNC_MS });
        await expect(meter).toContainText('Too many zeros: 1 of 1');
        expect(await controls(person.page), `${person.name}’s ballot`).toEqual(where[i]);
      }),
    );
  });

  await test.step('Oak St passes it, so one group fewer waits, and nothing on either ballot moves', async () => {
    await Promise.all(
      [ben, cy].map(async (person) => {
        await openVote(person, homeB, MOTION, 'Coalition vote');
        await vote(person, FOUR);
      }),
    );
    await Promise.all(
      viewers.map(async (person, i) => {
        const across = person.page.getByRole('region', { name: 'Across the coalition' });
        await expect(across).toContainText(`1 of 2 groups has passed. Waiting for ${RIVERSIDE}.`, {
          timeout: SYNC_MS,
        });
        expect(await controls(person.page), `${person.name}’s ballot`).toEqual(where[i]);
      }),
    );
    await expectAccessible(ana, 'a coalition vote, held steady');
  });

  await test.step('each ballot sends', async () => {
    await Promise.all(
      viewers.map(async ({ page }) => {
        await page.getByRole('button', { name: 'Send your vote' }).click();
        await expectSent(page);
      }),
    );
  });
});
