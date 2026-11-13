/**
 * Dispatches rising through coalitions (#126; ADR-0037) through the app's
 * actions and screens, on several devices and a fake relay: Ana in Riverside
 * Tenants, Ben in Oak St Co-op, and Cy in both, reconciled into Eastside
 * Housing (#114), and, nested, Eastside Housing with Eve's Elm Row in Metro
 * Renters (#122).
 *
 * Ana puts a Dispatch to Riverside's vote from Send a Dispatch, choosing how
 * far it can go. Once Riverside passes it, Ana's device, bound to
 * Riverside's seat, posts the promotion record in Eastside Housing, which
 * opens it in Oak St and in no new vote in Riverside. Cy's device carries
 * Cy's score from Riverside into Oak St, cast under Cy's Oak St identity at
 * the relay minute it drew, never before, with no note. Each level that
 * passes it sends it out on its Dispatches list, and no other does. Nothing
 * else crosses a line, and the relay reads none of it.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../app/App';
import { castBallot } from '../app/proposals';
import { bringCard, lookupCard, makeCard, postCard } from '../app/reconcile';
import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { parseCardLink } from '../coalition/card';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { parseRecord } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import type { Random } from '../store/carry';
import { foldCoalitions, foldWithCoalitions } from '../store/coalitions';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { concat } from '../test/bytes';
import {
  anaMakesCard,
  closeAll,
  found,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount any app before its device's store closes.
  cleanup();
  closeAll();
});

/** A motion's voting window: the ordinary default, 7 days, in relay minutes. */
const WINDOW = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES;

/** Relay time past a motion's deadline and the week its results still count. */
const PAST_FINAL = WINDOW + RESULT_GRACE_MINUTES + 60;

/** Passes on every device: ballots up, each line's result and record, then every device reads it. */
const SETTLE = 4;

/** How many minutes into the rest of the window Cy's device draws to cast at. */
const CAST_AFTER = 2_000;

/** The Dispatch Ana puts to Riverside's vote. */
const WORDS = { title: 'Rally Saturday', text: 'Canary meet at the river at ten.' };

/** The reason Cy gives in Riverside, which must never reach another group. */
const CY_NOTE = 'Canary Cy’s reason in Riverside';

/** Random bytes that read as `value` in the 6 bytes a draw takes: Cy's device's minute. */
function drawing(value: number): Random {
  return (length) => {
    const bytes = new Uint8Array(length);
    let rest = value;
    for (let i = length - 1; i >= 0; i -= 1) {
      bytes[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    return bytes;
  };
}

/** Riverside and Oak St, reconciled into Eastside Housing (#114); Cy's device draws CAST_AFTER. */
async function eastsideFormed(fake: FakeRelay) {
  const groups = await twoGroups(fake, { random: drawing(CAST_AFTER) });
  const { ana, ben, cy, riverside, oak } = groups;
  const first = await anaMakesCard(ana, cy, riverside);
  const brought = await bringCard(cy.services, first.found, oak, 'Cy');
  await syncAll(1);
  await vote(riverside, first.proposal, [ana, cy]);
  await vote(oak, brought, [ben, cy]);
  await syncAll();
  return groups;
}

/** Every coalition entry on `device`, folded as the device folds them, by name. */
async function coalitionNamed(device: TestDevice, name: string): Promise<GroupState> {
  const held = foldCoalitions(await device.services.store.listCoalitions());
  const state = held.find(({ state: s }) => s.name === name)?.state;
  if (state === undefined) throw new Error(`Expected the coalition ${name}.`);
  return state;
}

/** Group `groupId` as `device` folds it, with the motions its seats decide. */
async function groupOn(device: TestDevice, groupId: string): Promise<GroupState> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group.');
  const held = foldCoalitions(await device.services.store.listCoalitions());
  return foldWithCoalitions(group, held);
}

/** Shows `device`'s app at `hash`, from a fresh render. */
function showAt(device: TestDevice, hash: string): void {
  cleanup();
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/**
 * Ana puts WORDS to Riverside's vote from Send a Dispatch, choosing `reach`,
 * which takes her to the Proposal's ballot. Returns its id, the Dispatch's.
 */
async function anaPutsItToAVote(ana: TestDevice, riverside: string, reach: string) {
  showAt(ana, `#/g/${riverside}/dispatch/new`);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('textbox', { name: 'Title' }));
  await user.paste(WORDS.title);
  await user.click(screen.getByRole('textbox', { name: 'Text (optional)' }));
  await user.paste(WORDS.text);
  await user.click(screen.getByText(reach));
  await user.click(screen.getByRole('button', { name: 'Put it to a vote' }));
  const prefix = `#/g/${riverside}/p/`;
  await waitFor(() => {
    expect(window.location.hash.startsWith(prefix)).toBe(true);
  });
  return window.location.hash.slice(prefix.length);
}

/** Ana scores it 4, and Cy 4 with a reason, so Riverside passes it; every device syncs. */
async function riversidePasses(
  groups: { ana: TestDevice; cy: TestDevice; riverside: string },
  id: string,
) {
  const { ana, cy, riverside } = groups;
  await syncAll(1);
  await castBallot(ana.services, riverside, { proposal: id, scores: { [id]: 4 }, note: '' });
  await castBallot(cy.services, riverside, { proposal: id, scores: { [id]: 4 }, note: CY_NOTE });
  await syncAll(SETTLE);
}

/** The promotion motion in `coalition` for the Dispatch `id`, failing when there is none. */
function promotionIn(coalition: GroupState, id: string) {
  const found = coalition.proposals.find(
    (p) => p.target.kind === 'promote' && p.target.dispatch.id === id,
  );
  if (found === undefined) throw new Error(`Expected a promotion motion in ${coalition.name}.`);
  return found;
}

/** The titles on `device`'s Dispatches list for `groupId`, as its screen shows them. */
async function groupDispatches(device: TestDevice, groupId: string): Promise<string[]> {
  showAt(device, `#/g/${groupId}/dispatches`);
  await screen.findByRole('heading', { level: 1, name: 'Dispatches' });
  return screen
    .queryAllByRole('article')
    .map((card) => within(card).getByRole('heading').textContent);
}

/** The titles on the coalition home's Dispatches for `coalition`, on `device`. */
async function coalitionDispatches(device: TestDevice, coalition: string): Promise<string[]> {
  const id = (await coalitionNamed(device, coalition)).group ?? '';
  showAt(device, `#/c/${id}`);
  const section = await screen.findByRole('region', { name: 'Dispatches' });
  return within(section)
    .queryAllByRole('article')
    .map((card) => within(card).getByRole('heading').textContent);
}

/** UTF-8 bytes of `text`. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `device`'s key in group `groupId`, failing when it isn't in it. */
async function keyIn(device: TestDevice, groupId: string): Promise<string> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group.');
  return group.me.author;
}

/** The coalition entry called `name` on `device`, failing when it holds none. */
async function entryOf(device: TestDevice, name: string) {
  const held = foldCoalitions(await device.services.store.listCoalitions());
  const entry = held.find(({ state }) => state.name === name)?.entry;
  if (entry === undefined) throw new Error(`Expected the coalition ${name}’s entry.`);
  return entry;
}

/** The body of the ballot `voter` cast on `proposal` in `groupId`, as `device`'s copy of its log holds it. */
async function ballotBy(device: TestDevice, groupId: string, voter: string, proposal: string) {
  const group = await device.services.store.getGroup(groupId);
  const events = (group?.log ?? []).map((record) => parseRecord(record.bytes)?.event);
  const ballot = events.find(
    (event) => event?.type === 'vote' && event.author === voter && event.body.proposal === proposal,
  );
  return ballot?.type === 'vote' ? ballot.body : null;
}

/** Every request `fake` received, its URL then its body, as one run of bytes. */
function requestBytes(fake: FakeRelay): Uint8Array {
  return concat(
    ...fake.requests.flatMap((request) => [utf8(request.url), request.body ?? new Uint8Array()]),
  );
}

/** A log's records as one run of bytes: what anyone who reads that log holds. */
async function logBytes(device: TestDevice, groupId: string): Promise<Uint8Array> {
  const group = await device.services.store.getGroup(groupId);
  return concat(...(group?.log ?? []).map((record) => record.bytes));
}

/**
 * A Dispatch with ceiling 1 from Riverside, through Eastside Housing, with
 * Cy's score carried into Oak St, until Eastside Housing's pass is final.
 */
async function risesOneLevel(fake: FakeRelay) {
  const groups = await eastsideFormed(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const id = await anaPutsItToAVote(ana, riverside, 'One level up');
  await riversidePasses(groups, id);
  const motion = promotionIn(await coalitionNamed(ben, 'Eastside Housing'), id);
  const castAt = motion.received + CAST_AFTER;
  return { ...groups, ana, ben, cy, riverside, oak, id, motion, castAt };
}

describe('Dispatches rising through coalitions', SLOW, () => {
  it('rises from Riverside to Eastside Housing, carrying Cy’s score into Oak St at its minute, and goes out at each level that passed it', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak, id, motion, castAt } = await risesOneLevel(fake);

    // The record carries the Dispatch's words, ceiling 1 and level 1, from Riverside's seat.
    expect(motion.target).toMatchObject({
      kind: 'promote',
      dispatch: { id, ...WORDS },
      ceiling: 1,
      level: 1,
    });
    // It opens in Oak St to vote on, and no new vote in Riverside, which passed it.
    expect((await groupOn(ben, oak)).proposals.map((p) => p.id)).toContain(motion.id);
    expect((await groupOn(ana, riverside)).proposals.map((p) => p.id)).not.toContain(motion.id);

    // Cy's device plans to cast Cy's 4 from Riverside in Oak St, at the minute it drew.
    const planned = (await cy.services.store.getGroup(oak))?.carries;
    expect(planned).toEqual([
      { motion: motion.id, dispatch: id, score: 4, castAt, deadline: motion.deadline },
    ]);
    showAt(cy, `#/g/${oak}/p/${motion.id}`);
    expect(
      await screen.findByText('Your 4 from another group will be cast here before voting ends.'),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    // Ben votes by hand. Cy's carried score waits for its minute, and never comes before it.
    await vote(oak, motion.id, [ben]);
    act(() => {
      fake.minute = castAt - 1;
    });
    await syncAll(SETTLE);
    const cyInOak = (await cy.services.store.getGroup(oak))?.me.author ?? '';
    const waiting = (await groupOn(ben, oak)).proposals.find((p) => p.id === motion.id);
    expect(waiting?.ballots.map((b) => b.voter)).not.toContain(cyInOak);

    act(() => {
      fake.minute = castAt;
    });
    await syncAll(SETTLE);
    const cast = (await groupOn(ben, oak)).proposals.find((p) => p.id === motion.id);
    const carried = cast?.ballots.find((b) => b.voter === cyInOak);
    expect(carried).toMatchObject({ scores: { [motion.id]: 4 }, note: null, received: castAt });
    expect(cast?.final).toBe(true);
    expect(cast?.outcome.kind).toBe('pass');

    // Eastside Housing passes it once both seats have; it goes out once that pass is final.
    expect(await coalitionDispatches(ben, 'Eastside Housing')).toEqual([]);
    act(() => {
      fake.minute = motion.deadline + PAST_FINAL;
    });
    await syncAll(SETTLE);
    expect(await groupDispatches(ana, riverside)).toEqual([WORDS.title]);
    expect(await coalitionDispatches(ben, 'Eastside Housing')).toEqual([WORDS.title]);
    expect(screen.getByRole('region', { name: 'Dispatches' })).toHaveTextContent(
      'From Riverside Tenants',
    );
    expect(await axeViolations()).toEqual([]);
    // Oak St voted inside Eastside Housing; it sent nothing out itself.
    expect(await groupDispatches(ben, oak)).toEqual([]);
  });

  it('lets nothing but the promotion record cross a line, and sends the relay nothing it can read, with controls the scan finds', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak, motion, castAt } = await risesOneLevel(fake);
    await vote(oak, motion.id, [ben]);
    act(() => {
      fake.minute = castAt;
    });
    await syncAll(SETTLE);

    const riversideVoters = await Promise.all([ana, cy].map((device) => keyIn(device, riverside)));
    const voters = riversideVoters.flatMap((key, i) =>
      keyCanaries(`Riverside voter ${String(i)}`, fromBase64url(key)),
    );
    const note = [textCanary('Cy’s note', CY_NOTE)];
    const dispatch = [textCanary('the Dispatch', WORDS.text)];

    // What Oak St's and Eastside Housing's members read holds no note and no Riverside voter.
    const eastside = await entryOf(ben, 'Eastside Housing');
    const coalitionLog = await logBytes(ben, eastside.groupId);
    expect(findCanaries(coalitionLog, [...note, ...voters]), 'Eastside Housing').toEqual([]);
    expect(findCanaries(await logBytes(ben, oak), [...note, ...voters]), 'Oak St').toEqual([]);
    // The control: the promotion record did cross, so the coalition's log holds the Dispatch's words.
    expect(findCanaries(coalitionLog, dispatch)).not.toEqual([]);
    // Cy's carried ballot holds the score alone: no note, under Cy's Oak St key.
    expect(await ballotBy(ben, oak, await keyIn(cy, oak), motion.id)).toEqual({
      proposal: motion.id,
      scores: { [motion.id]: 4 },
      salt: expect.any(String) as string,
    });

    // The relay reads none of it, in any spelling.
    const sent = requestBytes(fake);
    expect(findCanaries(sent, [...dispatch, ...note])).toEqual([]);
    // The controls: Eastside Housing's weekly mailbox is in the requests the scan read, and words
    // planted in them are found.
    const mailbox = deriveWeekMailboxId(eastside.secret, weekOf(fake.minute));
    expect(fake.requests.some((request) => request.url.includes(mailbox))).toBe(true);
    const planted = concat(sent, utf8(base64url(utf8(CY_NOTE))));
    expect(findCanaries(planted, note)).not.toEqual([]);
  });
});

/** What Ana writes on Eastside Housing's card for Metro Renters. */
const METRO = {
  name: 'Metro Renters',
  statement: 'Rent stays fair across the city.',
  why: 'Renters across the city share a landlord.',
  yourName: 'Ana M.',
};

/**
 * Eastside Housing and Eve's Elm Row form Metro Renters (#122): Ana makes
 * Eastside Housing's card, Eve brings it to Elm Row, and every group passes.
 */
async function metroFormed(fake: FakeRelay) {
  const groups = await eastsideFormed(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const eve = await open(fake, 'eve');
  const elm = await found(eve, 'Elm Row', 'Eve');
  const entries = foldCoalitions(await ana.services.store.listCoalitions());
  const eastside = entries.find(({ state }) => state.name === 'Eastside Housing')?.entry.groupId;
  const made = await makeCard(ana.services, eastside ?? '', METRO);
  if (made.outcome !== 'queued') throw new Error('Expected Eastside Housing’s card.');
  const seed = parseCardLink(await postCard(ana.services, made.card, ana.services.origin));
  if (seed === null) throw new Error('Expected a card link.');
  await syncAll(1);
  const lookup = await lookupCard(eve.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  const elmProposal = await bringCard(eve.services, lookup.found, elm, 'Eve M.');
  await syncAll(1);
  await vote(riverside, made.proposalId, [ana, cy]);
  await vote(oak, made.proposalId, [ben, cy]);
  await vote(elm, elmProposal, [eve]);
  await syncAll(SETTLE);
  return { ...groups, eve, elm };
}

describe('a Dispatch as far as the coalitions go', SLOW, () => {
  it('rises from Riverside through Eastside Housing to Metro Renters, and goes out at each, and in no group that only voted', async () => {
    const fake = createFakeRelay();
    const groups = await metroFormed(fake);
    const { ana, ben, eve, riverside, oak, elm } = groups;
    const id = await anaPutsItToAVote(ana, riverside, 'As high as your group’s coalitions reach');
    await riversidePasses(groups, id);

    // Eastside Housing: Ben passes it in Oak St; Cy's 4 is carried there at its minute.
    const inEastside = promotionIn(await coalitionNamed(ben, 'Eastside Housing'), id);
    await vote(oak, inEastside.id, [ben]);
    act(() => {
      fake.minute = inEastside.received + CAST_AFTER;
    });
    await syncAll(SETTLE);

    // Eastside Housing's pass is certain, so its participant in Metro Renters sends it on, at level 2.
    const inMetro = promotionIn(await coalitionNamed(eve, 'Metro Renters'), id);
    expect(inMetro.target).toMatchObject({ ceiling: 'coalitions', level: 2 });
    // It opens in Elm Row, and no new vote in Eastside Housing or the groups beneath it.
    expect((await groupOn(eve, elm)).proposals.map((p) => p.id)).toContain(inMetro.id);
    expect((await groupOn(ben, oak)).proposals.map((p) => p.id)).not.toContain(inMetro.id);
    expect(
      (await coalitionNamed(ana, 'Eastside Housing')).proposals.map((p) => p.id),
    ).not.toContain(inMetro.id);
    await vote(elm, inMetro.id, [eve]);
    await syncAll(SETTLE);

    act(() => {
      fake.minute = inMetro.deadline + PAST_FINAL;
    });
    await syncAll(SETTLE);
    expect(await groupDispatches(ana, riverside)).toEqual([WORDS.title]);
    expect(await coalitionDispatches(ben, 'Eastside Housing')).toEqual([WORDS.title]);
    expect(await coalitionDispatches(eve, 'Metro Renters')).toEqual([WORDS.title]);
    expect(screen.getByRole('region', { name: 'Dispatches' })).toHaveTextContent(
      'From Eastside Housing',
    );
    expect(await groupDispatches(ben, oak)).toEqual([]);
    expect(await groupDispatches(eve, elm)).toEqual([]);
  });

  it('stops at Eastside Housing with a ceiling of one level up: nothing opens in Metro Renters', async () => {
    const fake = createFakeRelay();
    const groups = await metroFormed(fake);
    const { ana, ben, eve, riverside, oak } = groups;
    const id = await anaPutsItToAVote(ana, riverside, 'One level up');
    await riversidePasses(groups, id);
    const inEastside = promotionIn(await coalitionNamed(ben, 'Eastside Housing'), id);
    await vote(oak, inEastside.id, [ben]);
    // Cy's carried 4 lands at its minute, so Oak St passes it.
    act(() => {
      fake.minute = inEastside.received + CAST_AFTER;
    });
    await syncAll(SETTLE);
    act(() => {
      fake.minute = inEastside.deadline + PAST_FINAL;
    });
    await syncAll(SETTLE);

    const metro = await coalitionNamed(eve, 'Metro Renters');
    expect(metro.proposals.some((p) => p.target.kind === 'promote')).toBe(false);
    expect(await coalitionDispatches(ben, 'Eastside Housing')).toEqual([WORDS.title]);
    expect(await coalitionDispatches(eve, 'Metro Renters')).toEqual([]);
  });
});
