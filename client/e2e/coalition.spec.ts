/**
 * Two groups reconcile, then pass one coalition change and fail another
 * (#127; ADR-0036), in four browser profiles through the real relay:
 *
 * - Ana founds group A and Ben founds group B. Dee joins A as a Collaborator,
 *   so her score counts, and Cy joins A as a Collaborator and B as a
 *   Co-Creator. Neither group has 3 voting members before its last join, so
 *   everyone votes at once.
 * - Ana makes a reconcile card in A, Cy brings it to B, and each group passes
 *   its reconcile Proposal (A: Ana, Dee, Cy; B: Ben, Cy), closing it early.
 *   All four see the coalition formed, and Cy's one device holds it once,
 *   listed under both his groups.
 * - Ana proposes new wording for the coalition's first section from its
 *   home. A passes it, and A's profiles read "Your group passed this.
 *   Waiting for 1 more group."; then B passes it, and every profile reads
 *   that the coalition passed it, to take effect a week after its deadline.
 *   Before B votes, the motion's Copy link to this vote gives a link in A
 *   and another in B (#472), and Cy, in both, opens each in its own group.
 * - Ana proposes a change to the second section. A passes it and B scores
 *   it 0 (Ben's and Cy's reasons are canaries), so every profile reads "Not
 *   every group passed.". Dee and Ana, in A alone, never see either reason
 *   on any screen, nor B's totals.
 * - A pass is final only a week after its deadline (#100, #250), and the
 *   real relay's clock can't move, so every profile then reads the relay's
 *   mailbox answers that much later (`support/relayNow.ts`), once nothing
 *   more has to cross. Each coalition home lists both motions in Decided,
 *   and its Document has the first change and not the second.
 *
 * axe runs on every coalition screen, and any CSP violation fails the run.
 * Then the relay stops, and its files hold no canary in any encoding: the
 * group and coalition names, the statement, every motion's words, both
 * reasons, the coalition's and both groups' secrets and keys, and the card's;
 * a control blob, the coalition's and both groups' mailbox ids, and the
 * card's, all turn up.
 */
import {
  copyInvite,
  expect,
  expectAccessible,
  heading,
  type Person,
  test,
  visit,
} from './support/fixtures';
import { bringCard, coalitionKeys, makeCard, type NewCoalition } from './support/coalition';
import { readRelayLater, relayMinute } from './support/relayNow';
import {
  type Canary,
  describeFinding,
  keyCanaries,
  putControl,
  scan,
  tag,
  textCanary,
} from './support/scan';
import { firstRun, found, join, openVote, people, SYNC_MS, vote } from './support/steps';
import { groupMailboxes, storedGroups } from './support/stored';
import { watchFor } from './support/watch';

/** The pills the spec scores with. */
const FOUR = '4 · Strongly supportive';
const THREE = '3 · Supportive';
const ZERO = '0 · Strongly opposed';

/** Each founding group's one Document. */
const DOCUMENT = { title: 'House rules', atoms: ['Quiet hours start at ten.'] };

/** The coalition's results region on a coalition vote, once it has decided (#120). */
function coalitionResult(person: Person) {
  return person.page.getByRole('region', { name: 'The coalition’s result' });
}

/** The coalition's progress on a coalition vote, while it decides (#120). */
function acrossCoalition(person: Person) {
  return person.page.getByRole('region', { name: 'Across the coalition' });
}

test('two groups reconcile, pass one coalition change and fail another', async ({
  openProfile,
  relay,
  request,
}) => {
  const run = tag();
  const words = {
    groupA: `CANARY-GROUP-A-${run}`,
    groupB: `CANARY-GROUP-B-${run}`,
    coalition: `CANARY-COALITION-${run}`,
    statement: `CANARY-STATEMENT-${run}`,
    meetings: `CANARY-MEETINGS-${run}`,
    why: `CANARY-WHY-${run}`,
    anaName: `CANARY-ANA-IN-COALITION-${run}`,
    cyName: `CANARY-CY-IN-COALITION-${run}`,
    passTitle: `CANARY-PASS-TITLE-${run}`,
    passWhy: `CANARY-PASS-WHY-${run}`,
    passText: `CANARY-PASS-TEXT-${run}`,
    failTitle: `CANARY-FAIL-TITLE-${run}`,
    failWhy: `CANARY-FAIL-WHY-${run}`,
    failText: `CANARY-FAIL-TEXT-${run}`,
    benReason: `CANARY-BEN-REASON-${run}`,
    cyReason: `CANARY-CY-REASON-${run}`,
  };
  const control = `CONTROL-${tag()}`;
  const coalition: NewCoalition = {
    name: words.coalition,
    statement: [words.statement, words.meetings],
    why: words.why,
    yourName: words.anaName,
  };
  const voteTag = `Coalition vote · ${words.coalition}`;
  const reconcileTitle = `Reconcile into ${words.coalition}`;

  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const dee = await openProfile('Dee');
  const cy = await openProfile('Cy');
  const everyone = [ana, ben, dee, cy];
  // A's own group name is the control: both are sure to see it.
  const forbidden = [words.benReason, words.cyReason];
  const watches = await Promise.all(
    [ana, dee].map((person) => watchFor(person, [words.groupA, ...forbidden])),
  );

  let homeA = '';
  let homeB = '';
  let cardLink = '';
  let coalitionHome = '';
  let settles = 0;

  await test.step('the control: one readable blob, PUT straight to a throwaway mailbox', async () => {
    await putControl(request, control);
  });

  await test.step('Ana founds A and Ben founds B; Dee and Cy join A, and Cy joins B as a Co-Creator', async () => {
    [homeA, homeB] = await Promise.all([
      found(ana, { ...DOCUMENT, name: words.groupA, founder: 'Ana' }),
      found(ben, { ...DOCUMENT, name: words.groupB, founder: 'Ben' }),
      firstRun(dee),
      firstRun(cy),
    ]);
    const [inviteA, inviteB] = await Promise.all([copyInvite(ana.page), copyInvite(ben.page)]);
    // Everyone's join is on the relay before any reconcile Proposal, so all of them vote on it.
    const lists = async (person: Person, rows: readonly string[]) => {
      const list = people(person.page);
      await expect(list.getByRole('listitem')).toHaveCount(rows.length, { timeout: SYNC_MS });
      for (const row of rows) await expect(list).toContainText(row);
    };
    await Promise.all([
      join(dee, inviteA, words.groupA),
      (async () => {
        await join(cy, inviteA, words.groupA);
        await join(cy, inviteB, words.groupB, 'Co-Creator');
      })(),
      lists(ana, [
        'Ana, Co-Creator, Steward',
        'Dee, invited by Ana, Collaborator',
        'Cy, invited by Ana, Collaborator',
      ]),
      lists(ben, ['Ben, Co-Creator, Steward', 'Cy, invited by Ben, Co-Creator']),
    ]);
  });

  await test.step('Ana makes a reconcile card in A, and Cy brings it to B', async () => {
    cardLink = await makeCard(ana, coalition);
    await bringCard(cy, cardLink, {
      coalition,
      from: words.groupA,
      to: words.groupB,
      yourName: words.cyName,
    });
  });

  await test.step('A and B each pass their reconcile Proposal, and each closes early', async () => {
    await Promise.all([
      (async () => {
        await ana.page.getByRole('link', { name: 'Open your group’s Proposal' }).click();
        await expect(heading(ana.page, reconcileTitle)).toBeVisible();
        await vote(ana, FOUR);
      })(),
      (async () => {
        await openVote(dee, homeA, reconcileTitle);
        await expectAccessible(dee, 'a reconcile Proposal');
        await vote(dee, THREE);
      })(),
      (async () => {
        // Cy landed on B's reconcile Proposal when he brought the card.
        await vote(cy, FOUR);
        await openVote(cy, homeA, reconcileTitle);
        await vote(cy, FOUR);
      })(),
      (async () => {
        await openVote(ben, homeB, reconcileTitle);
        await vote(ben, THREE);
      })(),
    ]);
    // Each closes once everyone in its group has scored, long before its deadline.
    const passed = 'This passed. Your group’s pass goes to the coalition';
    await Promise.all(
      everyone.map((person) =>
        expect(person.page.getByRole('region', { name: 'Result', exact: true })).toContainText(
          passed,
          { timeout: SYNC_MS },
        ),
      ),
    );
    await expectAccessible(ben, 'a reconcile Proposal’s result');
  });

  await test.step('every profile shows the coalition formed, and Cy holds it once, under both groups', async () => {
    const members = `${words.coalition}${words.groupA}, ${words.groupB}`;
    const formed = async (person: Person, home: string, screen?: string) => {
      await visit(person.page, home);
      const section = person.page.getByRole('region', { name: 'Coalitions' });
      await expect(section).toContainText('Formed', { timeout: SYNC_MS });
      await expect(section).toContainText(members);
      await expect(section.getByRole('listitem')).toHaveCount(1);
      if (screen !== undefined) await expectAccessible(person, screen);
    };
    await Promise.all([
      // Ana's row as one who takes part, a Collaborator's, and a Co-Creator's who may take part.
      formed(ana, homeA, 'Coalitions, taking part'),
      formed(dee, homeA, 'Coalitions, as a Collaborator'),
      formed(ben, homeB, 'Coalitions, with Take part'),
      (async () => {
        await formed(cy, homeA);
        await formed(cy, homeB);
      })(),
    ]);
    const cysEntries = (await storedGroups(cy.page)).filter((each) => each.kind === 'coalition');
    expect(cysEntries).toHaveLength(1);
  });

  await test.step('Ana proposes new wording for the first section, and A’s three members score it 4', async () => {
    const proposes = async () => {
      const { page } = ana;
      await visit(page, homeA);
      await page
        .getByRole('region', { name: 'Coalitions' })
        .getByRole('link', { name: 'Open the coalition' })
        .click();
      await expect(heading(page, words.coalition)).toBeVisible();
      coalitionHome = page.url();
      await expectAccessible(ana, 'the coalition’s home');
      await page
        .getByRole('region', { name: 'Documents' })
        .getByRole('link', { name: /Mission statement/ })
        .click();
      await expect(page.getByRole('article').getByRole('paragraph')).toHaveText(
        coalition.statement,
      );
      await expectAccessible(ana, 'the coalition’s Document');
      await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
      await expectAccessible(ana, 'the coalition’s composer');
      await page.getByRole('textbox', { name: 'Title' }).fill(words.passTitle);
      await page.getByRole('textbox', { name: 'Why' }).fill(words.passWhy);
      await page.getByRole('textbox', { name: 'New text' }).fill(words.passText);
      await page.getByRole('button', { name: 'Propose this change' }).click();
      await expect(heading(page, words.coalition)).toBeVisible();
    };
    const scores = async (person: Person, screen?: string) => {
      await openVote(person, homeA, words.passTitle, voteTag);
      await expect(acrossCoalition(person)).toContainText('0 of 2 groups have passed.');
      if (screen !== undefined) await expectAccessible(person, screen);
      await vote(person, FOUR);
    };
    await Promise.all([
      (async () => {
        await proposes();
        await scores(ana);
      })(),
      scores(dee, 'a coalition vote'),
      scores(cy),
    ]);
  });

  await test.step('A’s profiles read that A passed it and wait for 1 more group', async () => {
    await Promise.all(
      [ana, dee, cy].map((person) =>
        expect(acrossCoalition(person)).toContainText(
          'Your group passed this. Waiting for 1 more group.',
          { timeout: SYNC_MS },
        ),
      ),
    );
    await expectAccessible(dee, 'a coalition vote, waiting for 1 more group');
  });

  await test.step('the motion’s Copy link gives A and B different tokens, and Cy opens each in its own group (#472)', async () => {
    const linkOn = async (person: Person) => {
      const field = person.page.getByRole('textbox', { name: 'Link to this vote' });
      await expect(field).toBeVisible();
      return field.inputValue();
    };
    // Ana is still on the motion's ballot in A, where she voted.
    const inA = await linkOn(ana);
    await openVote(ben, homeB, words.passTitle, voteTag);
    const inB = await linkOn(ben);
    const token = /#vote\/([A-Za-z0-9_-]{22})$/;
    expect(inA).toMatch(token);
    expect(inB).toMatch(token);
    expect(inB).not.toBe(inA);
    // The Copy link line, on a phone in both themes.
    await ben.page.setViewportSize({ width: 390, height: 844 });
    await expectAccessible(ben, 'a coalition vote’s Copy link, on a phone');
    await ben.page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(ben, 'a coalition vote’s Copy link, on a dark phone');
    await ben.page.emulateMedia({ colorScheme: 'light' });
    await ben.page.setViewportSize({ width: 1280, height: 720 });

    // Cy is in both groups: each link opens the motion's ballot in its own group.
    const groupOf = (home: string) => /#\/g\/([^/]+)$/.exec(home)?.[1] ?? '';
    for (const [link, home] of [
      [inA, homeA],
      [inB, homeB],
    ] as const) {
      await cy.page.goto(link);
      await expect(heading(cy.page, words.passTitle)).toBeVisible({ timeout: SYNC_MS });
      await expect.poll(() => cy.page.url()).toContain(`#/g/${groupOf(home)}/p/`);
    }
  });

  await test.step('B scores it 3 and 4, and every profile reads that the coalition passed it', async () => {
    await Promise.all([
      (async () => {
        await openVote(ben, homeB, words.passTitle, voteTag);
        await vote(ben, THREE);
      })(),
      (async () => {
        await openVote(cy, homeB, words.passTitle, voteTag);
        await vote(cy, FOUR);
      })(),
    ]);
    await Promise.all(
      everyone.map((person) =>
        expect(coalitionResult(person)).toContainText(
          'The coalition passed this. It takes effect on',
          { timeout: SYNC_MS },
        ),
      ),
    );
    await expectAccessible(ana, 'a coalition pass, not yet final');
    // The relay minute it takes effect: a week after its deadline (#100, #250).
    const day = await coalitionResult(ana).locator('time').getAttribute('datetime');
    settles = Date.parse(day ?? '') / 60_000;
    expect(settles).toBeGreaterThan(await relayMinute(request));
  });

  await test.step('Ana proposes a change to the second section, and A passes it', async () => {
    const proposes = async () => {
      const { page } = ana;
      await visit(page, coalitionHome);
      await page
        .getByRole('region', { name: 'Documents' })
        .getByRole('link', { name: /Mission statement/ })
        .click();
      await page.getByRole('button', { name: 'Propose a change to section 2' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill(words.failTitle);
      await page.getByRole('textbox', { name: 'Why' }).fill(words.failWhy);
      await page.getByRole('textbox', { name: 'New text' }).fill(words.failText);
      await page.getByRole('button', { name: 'Propose this change' }).click();
      await expect(heading(page, words.coalition)).toBeVisible();
    };
    const scores = async (person: Person) => {
      await openVote(person, homeA, words.failTitle, voteTag);
      await vote(person, FOUR);
    };
    await Promise.all([
      (async () => {
        await proposes();
        await scores(ana);
      })(),
      scores(dee),
      scores(cy),
    ]);
  });

  await test.step('B scores it 0, and every profile reads that not every group passed', async () => {
    await Promise.all([
      (async () => {
        await openVote(ben, homeB, words.failTitle, voteTag);
        await vote(ben, ZERO, words.benReason);
      })(),
      (async () => {
        await openVote(cy, homeB, words.failTitle, voteTag);
        await vote(cy, ZERO, words.cyReason);
      })(),
    ]);
    await Promise.all(
      everyone.map(async (person) => {
        const result = coalitionResult(person);
        await expect(result).toContainText('Not every group passed.', { timeout: SYNC_MS });
        await expect(result.getByRole('listitem')).toHaveText([
          `${words.groupA}Passed`,
          `${words.groupB}Didn’t pass`,
        ]);
      }),
    );
    await expectAccessible(dee, 'a coalition fail');
  });

  await test.step('Dee and Ana, in A alone, never see B’s reasons or totals', async () => {
    // B's own result keeps its reasons and totals, on B's members' devices.
    const ownB = ben.page.getByRole('region', { name: 'Result', exact: true });
    await expect(ownB).toContainText(words.benReason);
    const totalsB = ownB.getByRole('list', { name: 'Totals' });
    await expect(totalsB).toContainText('Scored by 2');
    const shownB = await totalsB.innerText();
    for (const person of [ana, dee]) {
      const own = person.page.getByRole('region', { name: 'Result', exact: true });
      await expect(own.getByRole('list', { name: 'Totals' })).toContainText('Scored by 3');
      await expect(person.page.locator('body')).not.toContainText(shownB);
    }
    for (const watch of watches) {
      const seen = await watch.seen();
      expect(seen).toContain(words.groupA);
      for (const needle of forbidden) expect(seen).not.toContain(needle);
    }
  });

  await test.step('a week after the deadline, every coalition home has the first change and not the second', async () => {
    // Every profile reads the relay's clock at once, an hour past the minute the pass takes effect.
    const minutes = settles - (await relayMinute(request)) + 60;
    const later = await Promise.all(everyone.map((person) => readRelayLater(person, minutes)));
    const settled = async (person: Person, screens?: { home: string; document: string }) => {
      const { page } = person;
      await visit(page, coalitionHome);
      await expect(heading(page, words.coalition)).toBeVisible();
      const decided = page.getByRole('region', { name: 'Decided' });
      await expect(decided.getByRole('link', { name: words.passTitle })).toContainText('Passed', {
        timeout: SYNC_MS,
      });
      await expect(decided.getByRole('link', { name: words.failTitle })).toContainText(
        'Didn’t pass',
      );
      await expect(page.getByRole('region', { name: 'Open Proposals' })).toContainText(
        'Nothing is open in the coalition right now.',
      );
      if (screens !== undefined) await expectAccessible(person, screens.home);
      await page
        .getByRole('region', { name: 'Documents' })
        .getByRole('link', { name: /Mission statement/ })
        .click();
      await expect(page.getByRole('article').getByRole('paragraph')).toHaveText([
        words.passText,
        words.meetings,
      ]);
      if (screens !== undefined) await expectAccessible(person, screens.document);
    };
    await Promise.all([
      settled(ana),
      settled(ben, { home: 'the coalition’s home, decided', document: 'the changed Document' }),
      settled(dee),
      settled(cy),
    ]);
    for (const each of later) {
      expect(each.rewritten()).toBeGreaterThan(0);
      await each.stop();
    }
  });

  const held = (await Promise.all(everyone.map((person) => storedGroups(person.page)))).flat();
  const keys = coalitionKeys(
    held.filter((each) => each.kind === 'coalition'),
    cardLink,
  );
  const groups = held.filter((each) => each.kind === null);

  await test.step('the relay stops, and nothing it kept holds a canary', async () => {
    for (const { page } of everyone) await page.context().setOffline(true);
    await relay.stop();
    const files = [relay.db, `${relay.db}-wal`, `${relay.db}-shm`, relay.log];
    const canaries: Canary[] = [
      ...Object.entries(words).map(([field, text]) => textCanary(field, text)),
      ...keys.canaries,
      ...groups.flatMap((each, i) => [
        ...keyCanaries(`group secret ${String(i + 1)}`, Uint8Array.from(each.secret)),
        ...keyCanaries(`member key ${String(i + 1)}`, Uint8Array.from(each.signingKey)),
      ]),
    ];
    expect(scan(files, canaries).map(describeFinding)).toEqual([]);

    // The controls: the scan reads what the relay stored.
    const turnUp = (label: string, texts: readonly string[]) =>
      scan(
        files,
        texts.map((text) => textCanary(label, text)),
      ).map(({ encoding }) => encoding);
    expect(turnUp('control', [control])).toContain('bytes');
    expect(turnUp('the coalition’s mailbox id', keys.mailboxes)).toContain('bytes');
    expect(turnUp('the card’s mailbox id', [keys.cardMailbox])).toContain('bytes');
    for (const each of groups) {
      const ids = groupMailboxes(Uint8Array.from(each.secret));
      expect(turnUp('a group’s mailbox id', ids)).toContain('bytes');
    }
  });
});
