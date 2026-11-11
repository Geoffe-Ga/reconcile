/**
 * Nested coalitions (#122) through the app's actions, on several devices and
 * a fake relay: Ana in Riverside Tenants, Ben in Oak St Co-op, and Cy in
 * both, reconciled into Eastside Housing (#114); then Ana makes Eastside
 * Housing's card, and Eve brings it to Elm Row, so the coalition and the
 * group form Metro Renters, a coalition of a coalition. A motion in Metro
 * Renters opens in Elm Row, and through Eastside Housing in Riverside and
 * Oak St; each group votes inside itself, Eastside Housing reports its one
 * result up, and the motion resolves once its pass is final. No request
 * carries a secret of the coalition above.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../app/App';
import { propose } from '../app/proposals';
import { admitCard, bringCard, lookupCard, makeCard, postCard } from '../app/reconcile';
import { base64url } from '../crypto/base64url';
import { deriveSealKey, deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { openSeatSecrets } from '../crypto/innerSeal';
import { parseCardLink } from '../coalition/card';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { seatIn } from '../engine/crossing';
import { fold, type GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { coalitionKeys, foldCoalitions, newEntry } from '../store/coalitions';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
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
import { concat } from '../test/bytes';
import { findCanaries, keyCanaries } from '../test/scan';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount any app before its device's store closes.
  cleanup();
  closeAll();
});

/** Relay time a week past a motion's deadline, by which every pass on it is final. */
const PAST_FINAL = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + RESULT_GRACE_MINUTES + 60;

/** Three passes on every device: ballots up, each line's result, then every device reads it. */
const SETTLE = 4;

/** What Ana writes on Eastside Housing's card. */
const METRO = {
  name: 'Metro Renters',
  statement: 'Rent stays fair across the city.',
  why: 'Renters across the city share a landlord.',
  yourName: 'Ana M.',
};

/** Eve's motion in Metro Renters. */
const CHANGE = {
  title: 'Fair for everyone',
  why: 'Say who it is for.',
  text: 'Rent stays fair for everyone across the city.',
};

/** Every coalition entry on `device`, folded as the device folds them, by name. */
async function coalitionsOn(device: TestDevice): Promise<Record<string, GroupState>> {
  const held = foldCoalitions(await device.services.store.listCoalitions());
  return Object.fromEntries(held.map(({ state }) => [state.name, state]));
}

/** The coalition called `name` as `device` folds it, failing when it holds none. */
async function coalitionNamed(device: TestDevice, name: string): Promise<GroupState> {
  const found = (await coalitionsOn(device))[name];
  if (found === undefined) throw new Error(`Expected the coalition ${name}.`);
  return found;
}

/** The entry id of the coalition called `name` on `device`. */
async function entryNamed(device: TestDevice, name: string): Promise<string> {
  const held = foldCoalitions(await device.services.store.listCoalitions());
  const entry = held.find(({ state }) => state.name === name)?.entry;
  if (entry === undefined) throw new Error(`Expected the coalition ${name}’s entry.`);
  return entry.groupId;
}

/** Shows `device`'s app at `hash`, from a fresh render. */
function showAt(device: TestDevice, hash: string): void {
  cleanup();
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/** Riverside and Oak St, reconciled into Eastside Housing (#114): both groups passed. */
async function eastsideFormed(fake: FakeRelay) {
  const groups = await twoGroups(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const first = await anaMakesCard(ana, cy, riverside);
  const brought = await bringCard(cy.services, first.found, oak, 'Cy');
  await syncAll(1);
  await vote(riverside, first.proposal, [ana, cy]);
  await vote(oak, brought, [ben, cy]);
  await syncAll();
  return groups;
}

/** A card `maker` makes from `from` with `values`, opened on `opener`'s device. */
async function cardFor(maker: TestDevice, from: string, opener: TestDevice, values = METRO) {
  const made = await makeCard(maker.services, from, values);
  if (made.outcome !== 'queued') throw new Error('Expected a card.');
  const seed = parseCardLink(await postCard(maker.services, made.card, maker.services.origin));
  if (seed === null) throw new Error('Expected a card link.');
  await syncAll(1);
  const lookup = await lookupCard(opener.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  return { proposal: made.proposalId, found: lookup.found, seed };
}

/**
 * Riverside and Oak St form Eastside Housing; Ana makes its card for another
 * coalition, Eve brings it to Elm Row, and every group passes: Metro Renters
 * forms, with Eastside Housing's seat and Elm Row's.
 */
async function nested(fake: FakeRelay) {
  const groups = await eastsideFormed(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const eve = await open(fake, 'eve');
  const elm = await found(eve, 'Elm Row', 'Eve');
  const eastside = await entryNamed(ana, 'Eastside Housing');
  const made = await makeCard(ana.services, eastside, METRO);
  if (made.outcome !== 'queued') throw new Error('Expected Eastside Housing’s card.');
  const link = await postCard(ana.services, made.card, ana.services.origin);
  await syncAll(1);
  const seed = parseCardLink(link);
  if (seed === null) throw new Error('Expected a card link.');
  const lookup = await lookupCard(eve.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  const elmProposal = await bringCard(eve.services, lookup.found, elm, 'Eve M.');
  await syncAll(1);
  await vote(riverside, made.proposalId, [ana, cy]);
  await vote(oak, made.proposalId, [ben, cy]);
  await vote(elm, elmProposal, [eve]);
  await syncAll(SETTLE);
  return { ...groups, eve, elm, eastside, intoMetro: made.proposalId, card: lookup.found };
}

/** Eve proposes CHANGE in Metro Renters, and every device syncs; returns the motion's id. */
async function eveProposes(eve: TestDevice): Promise<string> {
  const metroId = (await coalitionNamed(eve, 'Metro Renters')).group ?? '';
  const values = { atom: `${metroId}.0`, ...CHANGE, link: null };
  const result = await propose(
    eve.services,
    await entryNamed(eve, 'Metro Renters'),
    values,
    metroId,
  );
  if (result.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
  await syncAll(SETTLE);
  return result.proposalId;
}

/** The results `coalition` recorded on `motion`, as "seat result" lines, sorted: devices race. */
function resultsOn(coalition: GroupState, motion: string): string[] {
  const results = coalition.coalition?.results ?? [];
  return results
    .filter((r) => r.motion === motion)
    .map((r) => `${r.seat} ${r.result}`)
    .sort();
}

/** "seat pass" for each of `coalition`'s seats, sorted. */
function everySeatPassed(coalition: GroupState): string[] {
  return (coalition.coalition?.seats ?? []).map((seat) => `${seat.key} pass`).sort();
}

/** The text of `coalition`'s first section, without the trailing newline Atoms keep. */
function firstSection(coalition: GroupState): string {
  return coalition.atoms[0]?.text.trim() ?? '';
}

/** `motion` as `coalition` folds it: final, and its outcome's kind. */
function decided(coalition: GroupState, motion: string) {
  const proposal = coalition.proposals.find((p) => p.id === motion);
  return { final: proposal?.final, outcome: proposal?.outcome.kind };
}

/** The admit motion in `coalition`, failing when there is none. */
function admitMotion(coalition: GroupState) {
  const admit = coalition.proposals.find((p) => p.target.kind === 'admit');
  if (admit === undefined) throw new Error('Expected an admit motion.');
  return admit;
}

/** A formed coalition's card, made by `maker` from `entryId`'s row for `groupId`'s seat, opened by `opener`. */
async function admitCardFor(
  maker: TestDevice,
  entryId: string,
  groupId: string,
  opener: TestDevice,
) {
  const card = await admitCard(maker.services, entryId, groupId);
  const seed = parseCardLink(await postCard(maker.services, card, maker.services.origin));
  if (seed === null) throw new Error('Expected a card link.');
  const lookup = await lookupCard(opener.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  return lookup.found;
}

/** Every request `fake` received, its URL then its body, as one run of bytes. */
function requestBytes(fake: FakeRelay): Uint8Array {
  return concat(
    ...fake.requests.flatMap((request) => [
      new TextEncoder().encode(request.url),
      request.body ?? new Uint8Array(),
    ]),
  );
}

/**
 * What Ana's device holds above Eastside Housing: Metro Renters' keys, every
 * secret of them as canaries, with Eastside Housing's seat secret there, and
 * Eastside Housing's own entry id, secret and inner.
 */
async function secretsAbove(ana: TestDevice) {
  const entries = await ana.services.store.listCoalitions();
  const keys = coalitionKeys(await ana.services.store.listGroups(), entries);
  const eastsideState = await coalitionNamed(ana, 'Eastside Housing');
  const metro = await coalitionNamed(ana, 'Metro Renters');
  const above = keys.get(await entryNamed(ana, 'Metro Renters'));
  const seatSecret = above?.seats.get(seatIn(eastsideState, metro) ?? '');
  const entryId = await entryNamed(ana, 'Eastside Housing');
  const own = keys.get(entryId);
  if (above === undefined || seatSecret === undefined || own === undefined) {
    throw new Error('Expected Ana to hold both coalitions’ keys.');
  }
  const canaries = [
    ...keyCanaries('Metro Renters’ secret', above.secret),
    ...keyCanaries('Metro Renters’ inner', above.inner),
    ...keyCanaries('Metro Renters’ seal key', deriveSealKey(above.secret)),
    ...keyCanaries('Eastside Housing’s seat secret there', seatSecret),
  ];
  return { keys: above, canaries, eastside: { entryId, secret: own.secret, inner: own.inner } };
}

/** The sealed field of the reconcile motion `id` in `state`, failing when there is none. */
function sealedIn(state: GroupState, id: string): string {
  const target = state.proposals.find((p) => p.id === id)?.target;
  if (target?.kind !== 'reconcile' || !('sealed' in target)) {
    throw new Error('Expected the sealed reconcile motion.');
  }
  return target.sealed;
}

describe('nested coalitions', SLOW, () => {
  it('forms Metro Renters from Eastside Housing and Elm Row, with every device of theirs reading it', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, eve, card } = await nested(fake);

    expect(card.card.seat).toMatchObject({ name: 'Eastside Housing', level: 1 });
    for (const device of [ana, ben, cy, eve]) {
      const metro = await coalitionNamed(device, 'Metro Renters');
      expect(metro.coalition?.status).toBe('formed');
      expect(metro.coalition?.level).toBe(2);
      expect(metro.coalition?.seats).toEqual([
        expect.objectContaining({ name: 'Eastside Housing', level: 1 }),
        expect.objectContaining({ name: 'Elm Row' }),
      ]);
    }
    // Ana takes part in Metro Renters under Eastside Housing's seat, by a name of her own there.
    const metro = await coalitionNamed(ana, 'Metro Renters');
    const eastside = await coalitionNamed(ana, 'Eastside Housing');
    const anaM = metro.members.find((m) => m.name === 'Ana M.');
    expect(metro.coalition?.bindings.find((b) => b.author === anaM?.author)?.seat).toBe(
      seatIn(eastside, metro),
    );
  });

  it('shows the chain on group home, and Eastside Housing as a coalition in Metro Renters’ home', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await nested(fake);
    showAt(ana, `#/g/${riverside}`);
    const coalitions = await screen.findByRole('region', { name: 'Coalitions' });
    const above = within(coalitions).getByRole('list', { name: 'Coalitions it’s in' });
    expect(above).toHaveTextContent(
      'FormedRiverside Tenants · in Eastside Housing · in Metro RentersOpen the coalition→',
    );
    // Eastside Housing is level 1, so it may take another seat above.
    expect(
      within(coalitions).getByRole('link', { name: /Reconcile with another coalition/ }),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    const metroId = (await coalitionNamed(ana, 'Metro Renters')).group ?? '';
    showAt(ana, `#/c/${metroId}`);
    const members = await screen.findByRole('region', { name: 'Member groups' });
    expect(
      within(members)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Eastside HousingYour coalition', 'Elm Row']);
    expect(await axeViolations()).toEqual([]);
  });

  it('brings a card into a coalition this person takes part in, which then votes group by group', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await nested(fake);
    const pine = await open(fake, 'pine');
    const pineGroup = await found(pine, 'Pine Row', 'Pat');
    const card = await cardFor(pine, pineGroup, ana, { ...METRO, name: 'Westside Renters' });
    // Ana may bring it to her group, or to either coalition she takes part in.
    expect(card.found.groups.map(({ name, kind }) => `${name} (${kind})`).sort()).toEqual([
      'Eastside Housing (coalition)',
      'Metro Renters (coalition)',
      'Riverside Tenants (group)',
    ]);
    const eastside = await entryNamed(ana, 'Eastside Housing');
    const motion = await bringCard(ana.services, card.found, eastside, 'Ana W.');
    await syncAll(1);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await vote(pineGroup, card.proposal, [pine]);
    await syncAll(SETTLE);

    const westside = await coalitionNamed(ana, 'Westside Renters');
    expect(westside.coalition?.status).toBe('formed');
    expect(westside.coalition?.level).toBe(2);
    expect(westside.coalition?.seats.map((seat) => [seat.name, seat.level ?? 0])).toEqual([
      ['Pine Row', 0],
      ['Eastside Housing', 1],
    ]);
    // Eastside Housing holds the card now, so it isn't offered it again.
    const again = await lookupCard(ana.services, card.seed);
    const offered = again.kind === 'found' ? again.found.groups.map((g) => g.name) : [];
    expect(offered).toEqual(['Riverside Tenants', 'Metro Renters']);
  });

  it('admits Eastside Housing into a formed coalition of groups, at the level its admit motion states', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await eastsideFormed(fake);
    const eve = await open(fake, 'eve');
    const elm = await found(eve, 'Elm Row', 'Eve');
    const pine = await open(fake, 'pine');
    const pineGroup = await found(pine, 'Pine Row', 'Pat');
    const founding = await cardFor(eve, elm, pine, { ...METRO, yourName: 'Eve M.' });
    const pineProposal = await bringCard(pine.services, founding.found, pineGroup, 'Pat M.');
    await syncAll(1);
    await vote(elm, founding.proposal, [eve]);
    await vote(pineGroup, pineProposal, [pine]);
    await syncAll(SETTLE);
    expect((await coalitionNamed(eve, 'Metro Renters')).coalition?.level).toBe(1);

    // Eve makes Metro Renters' card for another group; Ana brings it into Eastside Housing.
    const card = await admitCardFor(eve, await entryNamed(eve, 'Metro Renters'), elm, ana);
    expect(card.mode).toBe('admit');
    const eastsideEntry = await entryNamed(ana, 'Eastside Housing');
    const into = await bringCard(ana.services, card, eastsideEntry, 'Ana M.');
    await syncAll(1);
    await vote(riverside, into, [ana, cy]);
    await vote(oak, into, [ben, cy]);
    await syncAll(SETTLE);

    // Ana's device proposes the admission, stating Eastside Housing's level and member groups.
    const admit = admitMotion(await coalitionNamed(eve, 'Metro Renters'));
    expect(admit.target).toMatchObject({
      seat: { name: 'Eastside Housing', level: 1 },
      groups: ['Riverside Tenants', 'Oak St Co-op'],
    });
    showAt(eve, `#/g/${elm}/p/${admit.id}`);
    const asking = await screen.findByRole('region', { name: 'Asking to join' });
    expect(asking).toHaveTextContent(
      'Eastside HousingLevel 1A coalition of Riverside Tenants, Oak St Co-op',
    );
    expect(await axeViolations()).toEqual([]);

    await vote(elm, admit.id, [eve]);
    await vote(pineGroup, admit.id, [pine]);
    await syncAll(SETTLE);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(SETTLE);

    const after = await coalitionNamed(ana, 'Metro Renters');
    expect(after.coalition?.level).toBe(2);
    expect(after.coalition?.seats.at(-1)).toMatchObject({ name: 'Eastside Housing', level: 1 });
    const anaM = after.members.find((m) => m.name === 'Ana M.');
    const eastside = await coalitionNamed(ana, 'Eastside Housing');
    expect(after.coalition?.bindings.find((b) => b.author === anaM?.author)?.seat).toBe(
      seatIn(eastside, after),
    );
  });

  it('opens a motion in Metro Renters in every group beneath it, carries one result up each line, and resolves once final', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, eve, riverside, oak, elm } = await nested(fake);
    const motion = await eveProposes(eve);

    // It waits on every group's members, tagged with the route it came by.
    for (const [device, groupId, tag] of [
      [ana, riverside, 'Coalition vote · Metro Renters (through Eastside Housing)'],
      [ben, oak, 'Coalition vote · Metro Renters (through Eastside Housing)'],
      [eve, elm, 'Coalition vote · Metro Renters'],
    ] as const) {
      showAt(device, `#/g/${groupId}`);
      const needs = await screen.findByRole('region', { name: 'Needs your vote' });
      const link = within(needs).getByRole('link', { name: new RegExp(CHANGE.title) });
      expect(link).toHaveTextContent(`${tag}${CHANGE.title}`);
    }
    showAt(ana, `#/g/${riverside}/p/${motion}`);
    await screen.findByRole('heading', { level: 1, name: CHANGE.title });
    const progress = screen.getByRole('region', { name: 'Across the coalition' });
    expect(progress).toHaveTextContent('In Eastside Housing0 of 2 groups have passed.');
    expect(progress).toHaveTextContent('In Metro Renters0 of 2 groups have passed.');
    expect(await axeViolations()).toEqual([]);

    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await vote(elm, motion, [eve]);
    await syncAll(SETTLE);

    const eastside = await coalitionNamed(ana, 'Eastside Housing');
    const metro = await coalitionNamed(ana, 'Metro Renters');
    // Each group's result went to Eastside Housing, and only Eastside Housing's to Metro Renters.
    expect(resultsOn(eastside, motion)).toEqual(everySeatPassed(eastside));
    expect(resultsOn(metro, motion)).toEqual(everySeatPassed(metro));
    expect(metro.coalition?.seats[0]?.key).toBe(seatIn(eastside, metro));
    // Both passed, but results still count for a week: the text hasn't changed yet.
    expect(firstSection(metro)).toBe(METRO.statement);

    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(SETTLE);

    for (const device of [ana, ben, cy, eve]) {
      const after = await coalitionNamed(device, 'Metro Renters');
      expect(firstSection(after)).toBe(CHANGE.text);
      expect(decided(after, motion)).toEqual({ final: true, outcome: 'pass' });
    }
    showAt(ben, `#/g/${oak}/p/${motion}`);
    await screen.findByRole('heading', { level: 1, name: CHANGE.title });
    const done = screen.getByRole('region', { name: 'The coalition’s result' });
    expect(done).toHaveTextContent(`The coalition passed this. It now reads:${CHANGE.text}`);
    expect(done).toHaveTextContent('Eastside HousingPassedElm RowPassed');
    expect(await axeViolations()).toEqual([]);
  });

  it('fails a motion in Metro Renters at once when Oak St fails it, through Eastside Housing', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, eve, riverside, oak, elm } = await nested(fake);
    const motion = await eveProposes(eve);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy], 0);
    await vote(elm, motion, [eve]);
    await syncAll(SETTLE);

    const eastside = await coalitionNamed(ana, 'Eastside Housing');
    expect(decided(eastside, motion)).toEqual({ final: true, outcome: 'fail' });
    for (const device of [ana, eve]) {
      const metro = await coalitionNamed(device, 'Metro Renters');
      expect(decided(metro, motion)).toEqual({ final: true, outcome: 'fail' });
      expect(firstSection(metro)).toBe(METRO.statement);
    }
  });

  it('sends the relay no secret of the coalition above, in any spelling, with controls the scan finds', async () => {
    const fake = createFakeRelay();
    const { ana } = await nested(fake);
    const { keys, canaries } = await secretsAbove(ana);
    const sent = requestBytes(fake);
    expect(findCanaries(sent, canaries)).toEqual([]);
    // The controls: Metro Renters' weekly mailbox id is in the requests the scan read, and a
    // secret planted in them is found.
    const mailbox = deriveWeekMailboxId(keys.secret, weekOf(fake.minute));
    expect(fake.requests.some((request) => request.url.includes(mailbox))).toBe(true);
    const planted = concat(sent, new TextEncoder().encode(base64url(keys.inner)));
    expect(findCanaries(planted, canaries)).not.toEqual([]);
  });

  it('lets a follower of Eastside Housing, holding its secret but no inner, keep no entry above and open nothing', async () => {
    const fake = createFakeRelay();
    const { ana, intoMetro } = await nested(fake);
    const { keys, canaries, eastside } = await secretsAbove(ana);
    const follower = await open(fake, 'follower');
    await follower.services.store.addGroup(newEntry(eastside.secret));
    await follower.services.sync.syncOnce();
    await follower.services.sync.syncOnce();
    const followed = await follower.services.store.listCoalitions();
    // It keeps no entry above, so it syncs no Metro Renters.
    expect(followed.map((e) => e.groupId)).toEqual([eastside.entryId]);
    expect(coalitionKeys([], followed).size).toBe(0);
    const read = fold(followed[0]?.log ?? [], null);
    const sealed = sealedIn(read, intoMetro);
    const id = read.group ?? '';
    // The positive control: it opens under the inner a member group's device holds …
    expect(openSeatSecrets(id, eastside.inner, sealed)?.secret).toEqual(keys.secret);
    // … and under nothing a follower holds: the secret, or its seal key.
    expect(openSeatSecrets(id, eastside.secret, sealed)).toBeNull();
    expect(openSeatSecrets(id, deriveSealKey(eastside.secret), sealed)).toBeNull();
    // The follower's copy holds no secret above in any spelling either.
    const copy = concat(...(followed[0]?.log ?? []).map((record) => record.bytes));
    expect(findCanaries(copy, canaries)).toEqual([]);
  });
});
