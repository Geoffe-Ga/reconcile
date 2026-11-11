/**
 * A coalition's mission statement through the normal loop (#120), on several
 * devices and a fake relay: Ana in Riverside Tenants, Ben in Oak St Co-op,
 * and Cy in both, reconciled into Eastside Housing (#114). Ana proposes a
 * change from the coalition's home; it opens as a coalition vote in both
 * groups; each group votes inside itself; and only once the coalition's pass
 * is final, a week after its deadline (#100), does its Document change for
 * everyone. A fail leaves it byte for byte as it was. Neither group's
 * ballots, notes, counts or voters' names reach the other.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../app/App';
import { joinGroup, lookupInvite, makeInvite } from '../app/actions';
import { parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { propose } from '../app/proposals';
import { bringCard } from '../app/reconcile';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount any app before its device's store closes.
  cleanup();
  closeAll();
});

const [, VOTING] = LEVELS;

/** Relay time a week past a motion's deadline, by which every pass on it is final. */
const PAST_FINAL = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + RESULT_GRACE_MINUTES + 60;

/** What Ana proposes for the coalition's first section. */
const CHANGE = {
  title: 'Paths and banks too',
  why: 'We all walk the river paths.',
  text: 'Everyone on the east side has a safe home, and safe paths to it.',
};

/** Riverside and Oak St, reconciled into Eastside Housing: both groups passed. */
async function formed(fake: FakeRelay) {
  const groups = await twoGroups(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
  const brought = await bringCard(cy.services, card, oak, 'Cy');
  await syncAll(1);
  await vote(riverside, proposal, [ana, cy]);
  await vote(oak, brought, [ben, cy]);
  await syncAll();
  const coalition = await coalitionOn(ana);
  if (coalition.group === null) throw new Error('Expected the coalition to have formed.');
  return { ...groups, coalition: coalition.group };
}

/**
 * Three passes on every device: the ballots go up, then each group's result
 * from its participant's device, then every device reads it, whatever order
 * they sync in.
 */
const SETTLE = 3;

/** Shows `device`'s app at `hash`, from a fresh render. */
function showAt(device: TestDevice, hash: string): void {
  cleanup();
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/** The coalition's first section as `device` folds it. */
async function firstSection(device: TestDevice): Promise<string> {
  const coalition: GroupState = await coalitionOn(device);
  return coalition.atoms[0]?.text ?? '';
}

/** Ana proposes the change straight through the app's action, and every device syncs. */
async function anaProposes(ana: TestDevice, coalitionId: string): Promise<string> {
  const entry = (await ana.services.store.listCoalitions())[0];
  if (entry === undefined) throw new Error('Expected Ana’s coalition entry.');
  const values = { atom: `${coalitionId}.0`, ...CHANGE, link: null };
  const result = await propose(ana.services, entry.groupId, values, coalitionId);
  if (result.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
  await syncAll(SETTLE);
  return result.proposalId;
}

/** `device`'s Proposal view of the motion in `groupId`, once it has its heading. */
async function motionIn(device: TestDevice, groupId: string, motion: string): Promise<void> {
  showAt(device, `#/g/${groupId}/p/${motion}`);
  await screen.findByRole('heading', { level: 1, name: CHANGE.title });
}

describe('a coalition’s mission statement through the normal loop', SLOW, () => {
  it('opens Ana’s change in both groups, and changes the Document for everyone once its pass is final', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak, coalition } = await formed(fake);
    const before = await firstSection(ben);

    // Ana opens the coalition from Riverside's home, then its Document, and proposes a change.
    showAt(ana, `#/g/${riverside}`);
    const row = await screen.findByRole('region', { name: 'Coalitions' });
    await user.click(within(row).getByRole('link', { name: 'Open the coalition' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' }),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    const documents = screen.getByRole('region', { name: 'Documents' });
    await user.click(within(documents).getByRole('link', { name: /Mission statement/ }));
    await user.click(await screen.findByRole('button', { name: 'Propose a change to section 1' }));
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), CHANGE.title);
    await user.type(screen.getByRole('textbox', { name: 'Why' }), CHANGE.why);
    const text = screen.getByRole('textbox', { name: 'New text' });
    await user.clear(text);
    await user.type(text, CHANGE.text);
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' }),
    ).toBeVisible();
    await syncAll(SETTLE);

    const [motion] = (await coalitionOn(ana)).proposals;
    if (motion === undefined) throw new Error('Expected Ana’s motion in the coalition.');
    // It waits on both groups' members, tagged with the coalition.
    for (const [device, groupId] of [
      [ana, riverside],
      [ben, oak],
    ] as const) {
      showAt(device, `#/g/${groupId}`);
      const needs = await screen.findByRole('region', { name: 'Needs your vote' });
      const card = within(needs).getByRole('link', { name: new RegExp(CHANGE.title) });
      expect(card).toHaveTextContent(`Coalition vote · Eastside Housing${CHANGE.title}`);
    }

    // Its vote in Oak St: the coalition's words, a diff against its text, and its progress.
    await motionIn(ben, oak, motion.id);
    expect(screen.getByText(/^Coalition vote/)).toHaveTextContent(
      'Coalition vote · Eastside Housing',
    );
    expect(screen.getByText(CHANGE.why)).toBeVisible();
    const ballot = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(ballot).toHaveTextContent('and safe paths to it');
    // Its one version is Ana's, by the name she takes part under in the coalition.
    expect(within(ballot).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Version 1 · Ana E.',
    );
    expect(screen.getByRole('region', { name: 'Across the coalition' })).toHaveTextContent(
      '0 of 2 groups have passed. Waiting for Riverside Tenants and Oak St Co-op.',
    );
    expect(await axeViolations()).toEqual([]);

    await vote(riverside, motion.id, [ana, cy]);
    await vote(oak, motion.id, [ben, cy]);
    await syncAll(SETTLE);
    // Both passed, but results still count for a week: the text hasn't changed yet.
    await motionIn(ben, oak, motion.id);
    const pending = screen.getByRole('region', { name: 'The coalition’s result' });
    expect(pending).toHaveTextContent('The coalition passed this. It takes effect on');
    expect(await firstSection(ben)).toBe(before);

    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(SETTLE);

    for (const [device, groupId] of [
      [ana, riverside],
      [ben, oak],
    ] as const) {
      await motionIn(device, groupId, motion.id);
      const result = screen.getByRole('region', { name: 'The coalition’s result' });
      expect(result).toHaveTextContent(`The coalition passed this. It now reads:${CHANGE.text}`);
      expect(result).toHaveTextContent(/Thank you, Ana E\.(?!\.)/);
      expect(result).toHaveTextContent('Riverside TenantsPassedOak St Co-opPassed');
      // The group's own pass went to the coalition; its ballot now shows the text as it reads.
      expect(screen.getByText(messages.coalitions.motionPassed)).toBeVisible();
      expect(screen.getByRole('region', { name: 'On the ballot' })).toHaveTextContent(CHANGE.text);
      expect(screen.queryByRole('region', { name: 'Changes to section 1' })).toBeNull();
      expect(await axeViolations()).toEqual([]);

      showAt(device, `#/c/${coalition}`);
      const decided = await screen.findByRole('region', { name: 'Decided' });
      expect(
        within(decided).getByRole('link', { name: new RegExp(CHANGE.title) }),
      ).toHaveTextContent('Passed');
      showAt(device, `#/c/${coalition}/doc/${coalition}`);
      expect(await screen.findByText(CHANGE.text)).toBeVisible();
    }
    expect(await firstSection(ben)).toBe(`${CHANGE.text}\n`);
  });

  it('shows Riverside the waiting line while Oak St votes, then the fail, and leaves the text as it was', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak, coalition } = await formed(fake);
    const before = await firstSection(ana);
    const motion = await anaProposes(ana, coalition);

    await vote(riverside, motion, [ana, cy]);
    await syncAll(SETTLE);
    await motionIn(ana, riverside, motion);
    expect(screen.getByRole('region', { name: 'Across the coalition' })).toHaveTextContent(
      'Your group passed this. Waiting for 1 more group.',
    );

    await vote(oak, motion, [ben, cy], 0);
    await syncAll(SETTLE);
    for (const [device, groupId] of [
      [ana, riverside],
      [ben, oak],
    ] as const) {
      await motionIn(device, groupId, motion);
      const result = screen.getByRole('region', { name: 'The coalition’s result' });
      expect(result).toHaveTextContent('Not every group passed.');
      expect(result).toHaveTextContent('Riverside TenantsPassedOak St Co-opDidn’t pass');
      expect(screen.queryByRole('region', { name: 'Across the coalition' })).toBeNull();
    }
    expect(await axeViolations()).toEqual([]);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(SETTLE);
    for (const device of [ana, ben, cy]) expect(await firstSection(device)).toBe(before);
    showAt(ana, `#/c/${coalition}`);
    const decided = await screen.findByRole('region', { name: 'Decided' });
    expect(decided).toHaveTextContent(`${CHANGE.title}→Didn’t pass`);
  });

  it('never shows one group another group’s ballots, notes, counts or voters', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak, coalition } = await formed(fake);
    const motion = await anaProposes(ana, coalition);
    await vote(riverside, motion, [ana, cy]);
    // Oak St fails it: Ben's 0, with his reason, and Cy's 4.
    await vote(oak, motion, [ben], 0);
    await vote(oak, motion, [cy], 4);
    await syncAll(SETTLE);

    // Ana is only in Riverside: Ben's name, his note and Oak St's tally never reach her screens.
    const theirs = [/\bBen\b/, /Not with them/, /average 2\.0/, /1 zero/];
    await motionIn(ana, riverside, motion);
    const result = screen.getByRole('region', { name: 'The coalition’s result' });
    expect(result).toHaveTextContent('Oak St Co-opDidn’t pass');
    expect(result.textContent).not.toMatch(/Scored by|average|zero|[0-9]/);
    expect(document.body.textContent).toMatch(/average 4\.0/);
    for (const pattern of theirs) expect(document.body.textContent).not.toMatch(pattern);
    showAt(ana, `#/c/${coalition}`);
    await screen.findByRole('region', { name: 'Decided' });
    for (const pattern of theirs) expect(document.body.textContent).not.toMatch(pattern);
    expect(document.body.textContent).not.toMatch(/Scored by|average/);

    // Ben sees his own group's ballots in Oak St's own result, and none of Riverside's.
    await motionIn(ben, oak, motion);
    expect(document.body.textContent).toMatch(/Not with them/);
    expect(document.body.textContent).not.toMatch(/average 4\.0|\bAna\b(?! E\.)/);
  });

  it('offers a Collaborator no Propose a change on the coalition’s sections', async () => {
    const fake = createFakeRelay();
    const { ana, riverside, coalition } = await formed(fake);
    const dee = await open(fake, 'dee');
    const seed = parseInviteLink(await makeInvite(ana.services, riverside, ana.services.origin));
    if (seed === null) throw new Error('Expected an invite link.');
    const lookup = await lookupInvite(dee.services, seed);
    if (lookup.kind !== 'found') throw new Error('Expected the invite to open.');
    await joinGroup(dee.services, lookup.group, 'Dee', VOTING);
    await syncAll(SETTLE);

    showAt(dee, `#/c/${coalition}/doc/${coalition}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mission statement' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take part' })).toBeNull();
    expect(screen.getByText(messages.coalitions.cantPropose)).toBeVisible();
    showAt(dee, `#/c/${coalition}/propose/${coalition}.0`);
    expect(await screen.findByText(messages.coalitions.cantPropose)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers Ben, a Co-Creator who hasn’t joined, Take part first', async () => {
    const fake = createFakeRelay();
    const { ben, coalition } = await formed(fake);
    showAt(ben, `#/c/${coalition}/doc/${coalition}`);
    expect(await screen.findByText(messages.coalitions.takePartFirst)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Take part' })).toBeVisible();
  });
});
