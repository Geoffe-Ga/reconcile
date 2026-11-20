/**
 * Dispatches rising through a coalition (#126; ADR-0037), end to end in two
 * browser profiles through the real relay (#378):
 *
 * - Ana founds Riverside Tenants and Ben founds Oak St Co-op. Ana makes a
 *   reconcile card, Ben brings it to Oak St, and each passes its reconcile
 *   Proposal, so both groups form Eastside Housing.
 * - A promotion the coalition in between votes down: Ana puts a Dispatch to
 *   Riverside's vote with "Two levels up" and passes it. It goes out to
 *   Riverside, and its promotion motion opens in Oak St, which says the
 *   coalition above would vote next. Ben scores it 0, so Eastside Housing
 *   fails it at once, and it never goes past: neither profile finds it on
 *   Eastside Housing's Dispatches, and its home lists it as didn't pass.
 * - A rise: Ana puts another to Riverside's vote with "One level up", and
 *   both groups pass it. Once the coalition's pass is final, a day after its
 *   deadline, both profiles read it on Eastside Housing's Dispatches.
 *
 * axe checks every new screen, and the fixture fails on any CSP violation.
 */
import {
  expect,
  expectAccessible,
  heading,
  type Person,
  pick,
  test,
  visit,
} from './support/fixtures';
import { bringCard, makeCard, type NewCoalition } from './support/coalition';
import { readRelayLater, relayMinute } from './support/relayNow';
import { found, openVote, SYNC_MS, vote } from './support/steps';

const FOUR = '4 · Strongly supportive';
const ZERO = '0 · Strongly opposed';

const RIVERSIDE = 'Riverside Tenants';
const OAK = 'Oak St Co-op';
const DOCUMENT = { title: 'House rules', atoms: ['Quiet hours start at ten.'] };

const COALITION: NewCoalition = {
  name: 'Eastside Housing',
  statement: ['Everyone on the east side has a safe home.'],
  why: 'We share a landlord.',
  yourName: 'Ana E.',
};

const VOTE_TAG = `Coalition vote · ${COALITION.name}`;

/** The Dispatch the coalition votes down, and the one that rises. */
const HELD = { title: 'March on the council', text: 'Bring a sign to the steps at noon.' };
const RISES = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };

/** The coalition's result on a coalition vote, once it has decided (#120). */
function coalitionResult(person: Person) {
  return person.page.getByRole('region', { name: 'The coalition’s result' });
}

/**
 * From Group home at `home`, Ana puts `words` to her group's vote, choosing
 * how far it can go, and scores it 4, which closes it: she is its one voter.
 */
async function putsToAVote(
  ana: Person,
  home: string,
  words: { readonly title: string; readonly text: string },
  reach: string,
  screen?: string,
): Promise<void> {
  const { page } = ana;
  await visit(page, home);
  await page
    .getByRole('region', { name: 'Dispatches', exact: true })
    .getByRole('link', { name: 'Send a Dispatch' })
    .click();
  await expect(heading(page, 'Send a Dispatch')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'How far can it go?' })).toBeVisible({
    timeout: SYNC_MS,
  });
  if (screen !== undefined) await expectAccessible(ana, screen);
  await page.getByRole('textbox', { name: 'Title' }).fill(words.title);
  await page.getByRole('textbox', { name: 'Text (optional)' }).fill(words.text);
  await pick(page, reach);
  await page.getByRole('button', { name: 'Put it to a vote' }).click();
  await expect(heading(page, words.title)).toBeVisible();
  await vote(ana, FOUR);
  await expect(page.getByRole('region', { name: 'Result', exact: true })).toContainText(
    'This passed. It went out to everyone in your group',
    { timeout: SYNC_MS },
  );
}

/** The Dispatches region of the coalition home `person` has open. */
function coalitionDispatches(person: Person) {
  return person.page.getByRole('region', { name: 'Dispatches', exact: true });
}

test('a Dispatch rises through the coalition, and one the coalition votes down goes no further', async ({
  openProfile,
  request,
}) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  let homeA = '';
  let homeB = '';
  let coalitionHome = '';

  await test.step('Riverside and Oak St reconcile into Eastside Housing', async () => {
    [homeA, homeB] = await Promise.all([
      found(ana, { ...DOCUMENT, name: RIVERSIDE, founder: 'Ana' }),
      found(ben, { ...DOCUMENT, name: OAK, founder: 'Ben' }),
    ]);
    const card = await makeCard(ana, COALITION);
    await bringCard(ben, card, {
      coalition: COALITION,
      from: RIVERSIDE,
      to: OAK,
      yourName: 'Ben E.',
    });
    const reconcile = `Reconcile into ${COALITION.name}`;
    await Promise.all([
      (async () => {
        await ana.page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
        await expect(heading(ana.page, reconcile)).toBeVisible();
        await vote(ana, FOUR);
      })(),
      vote(ben, FOUR),
    ]);
    const formed = async (person: Person, home: string) => {
      await visit(person.page, home);
      await expect(person.page.getByRole('region', { name: 'Coalitions' })).toContainText(
        'Formed',
        { timeout: SYNC_MS },
      );
    };
    await Promise.all([formed(ana, homeA), formed(ben, homeB)]);
    await ana.page
      .getByRole('region', { name: 'Coalitions' })
      .getByRole('link', { name: 'Open the coalition' })
      .click();
    await expect(heading(ana.page, COALITION.name)).toBeVisible();
    coalitionHome = ana.page.url();
  });

  await test.step('Ana puts a Dispatch that may go two levels up to Riverside’s vote, and it passes there', async () => {
    await putsToAVote(ana, homeA, HELD, 'Two levels up', 'Send a Dispatch, how far it can go');
    await expectAccessible(ana, 'a Dispatch passed in the group');
  });

  await test.step('Oak St votes on it inside the coalition, which would send it on, and Ben scores it 0', async () => {
    await openVote(ben, homeB, HELD.title, VOTE_TAG);
    const dispatch = ben.page.getByRole('region', { name: 'The Dispatch' });
    await expect(dispatch).toContainText(`Passed by ${RIVERSIDE}`);
    await expect(dispatch).toContainText('Then the coalition above votes on it.');
    await expectAccessible(ben, 'a promotion motion in the group');
    await vote(ben, ZERO, 'Not before we talk to the council.');
  });

  await test.step('the coalition fails it at once, on both profiles, and it goes no further', async () => {
    await expect(coalitionResult(ben)).toContainText('Not every group passed.', {
      timeout: SYNC_MS,
    });
    await expect(coalitionResult(ben).getByRole('listitem')).toHaveText([
      `${RIVERSIDE}Passed`,
      `${OAK}Didn’t pass`,
    ]);
    await expectAccessible(ben, 'a promotion motion the coalition failed');
    for (const person of [ana, ben]) {
      await visit(person.page, coalitionHome);
      await expect(heading(person.page, COALITION.name)).toBeVisible();
      // Riverside passed it already, so only on Ben's device does it link to a vote.
      const decided = person.page.getByRole('region', { name: 'Decided' });
      await expect(decided.getByRole('listitem').filter({ hasText: HELD.title })).toContainText(
        'Didn’t pass',
        { timeout: SYNC_MS },
      );
      await expect(coalitionDispatches(person)).not.toContainText(HELD.title);
    }
    await expectAccessible(ana, 'the coalition’s home, with a failed promotion');
  });

  let settles = 0;
  await test.step('Ana puts one that may go one level up to Riverside’s vote, and both groups pass it', async () => {
    await putsToAVote(ana, homeA, RISES, 'One level up');
    await openVote(ben, homeB, RISES.title, VOTE_TAG);
    const dispatch = ben.page.getByRole('region', { name: 'The Dispatch' });
    await expect(dispatch).toContainText(`Passed by ${RIVERSIDE}`);
    await expect(dispatch).not.toContainText('Then the coalition above votes on it.');
    await vote(ben, FOUR);
    await expect(coalitionResult(ben)).toContainText(
      'The coalition passed this. It takes effect on',
      { timeout: SYNC_MS },
    );
    await expectAccessible(ben, 'a promotion motion the coalition passed, not yet final');
    // The relay minute it goes out: a day after its deadline (#124, #250, #387).
    const day = await coalitionResult(ben).locator('time').getAttribute('datetime');
    settles = Date.parse(day ?? '') / 60_000;
    expect(settles).toBeGreaterThan(await relayMinute(request));
    for (const person of [ana, ben]) {
      await visit(person.page, coalitionHome);
      await expect(heading(person.page, COALITION.name)).toBeVisible();
      await expect(coalitionDispatches(person)).not.toContainText(RISES.title);
    }
  });

  await test.step('once the coalition’s pass is final, both profiles read it on its Dispatches', async () => {
    // Both profiles read the relay's clock at once, an hour past the minute it goes out.
    const minutes = settles - (await relayMinute(request)) + 60;
    const later = await Promise.all([ana, ben].map((person) => readRelayLater(person, minutes)));
    for (const person of [ana, ben]) {
      await visit(person.page, coalitionHome);
      await expect(heading(person.page, COALITION.name)).toBeVisible();
      const dispatches = coalitionDispatches(person);
      const card = dispatches.getByRole('article').filter({ hasText: RISES.title });
      await expect(card).toContainText(RISES.text, { timeout: SYNC_MS });
      await expect(card).toContainText(`From ${RIVERSIDE}`);
      await expect(dispatches).not.toContainText(HELD.title);
    }
    await expectAccessible(ben, 'the coalition’s home, with a Dispatch that rose');
    for (const each of later) {
      expect(each.rewritten()).toBeGreaterThan(0);
      await each.stop();
    }
  });
});
