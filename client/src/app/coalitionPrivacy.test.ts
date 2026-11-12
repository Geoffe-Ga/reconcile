/**
 * What a device keeps of a coalition, and for how long (#278; CLAUDE.md,
 * "consent and reversibility"), through the app's actions and the sync loop
 * on a fake relay, checked by a raw read of the device's IndexedDB, with the
 * same read finding it before:
 *
 * - A coalition goes with the group that held it: leaving the only group on
 *   the device that holds it takes the coalition's entry off the device, its
 *   secret, log and the participants' names in it with it. One another group
 *   here still holds stays.
 * - A group's ballots on a coalition's motion expire as its ballots on its
 *   own Proposals do (#111): a member's device posts the group's result in
 *   its own log, and 30 days after the close every device clears the
 *   ballots and their notes, keeping the outcome.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { parseRecord } from '../engine/event';
import { foldCoalitions, foldWithCoalitions } from '../store/coalitions';
import { CARD_VALUES, closeAll, formedCoalition, SLOW, syncAll } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { containsBytes, scanDb } from '../test/scanDb';
import type { TestDevice } from '../test/appServices';
import { leaveGroup } from './actions';
import { castBallot, propose } from './proposals';

freshIndexedDBPerTest();

afterEach(() => {
  closeAll();
});

/** The one coalition entry on `device`, failing when it holds none or more. */
async function onlyEntry(device: TestDevice) {
  const entries = await device.services.store.listCoalitions();
  const [entry] = entries;
  if (entry === undefined || entries.length !== 1) {
    throw new Error(`Expected one coalition entry, not ${String(entries.length)}.`);
  }
  return entry;
}

/** What a raw read of `name`'s database finds of the coalition `entry`: its id, its secret and its name. */
async function traces(name: string, entry: { groupId: string; secret: Uint8Array }) {
  const scan = await scanDb(name);
  return {
    id: scan.text.includes(entry.groupId),
    secret: containsBytes(scan.bytes, entry.secret),
    name: scan.text.includes(CARD_VALUES.name),
  };
}

describe('a coalition held through a group this device leaves (#278)', SLOW, () => {
  it('goes from the device with its only holding group, leaving nothing of it in the database', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await formedCoalition(fake);
    const entry = await onlyEntry(ana);
    // The control: the same read finds the coalition while Riverside holds it.
    expect(await traces('ana', entry)).toEqual({ id: true, secret: true, name: true });

    await leaveGroup(ana.services, riverside);
    await syncAll(3);

    expect(await ana.services.store.getGroup(riverside)).toBeUndefined();
    expect(await ana.services.store.listCoalitions()).toEqual([]);
    expect(await ana.services.store.listRooms()).toEqual([]);
    expect(await traces('ana', entry)).toEqual({ id: false, secret: false, name: false });
  });

  it('stays while another group on the device still holds it', async () => {
    const fake = createFakeRelay();
    const { cy, riverside, oak } = await formedCoalition(fake);
    const entry = await onlyEntry(cy);

    await leaveGroup(cy.services, riverside);
    await syncAll(3);

    expect(await cy.services.store.getGroup(riverside)).toBeUndefined();
    expect(await cy.services.store.getGroup(oak)).toBeDefined();
    expect((await onlyEntry(cy)).groupId).toBe(entry.groupId);
  });
});

/** The reason Cy gives on the coalition's motion in Riverside, which must expire with the ballot. */
const NOTE = 'Canary-278 Cy’s reason on the coalition’s motion';

/** Days a ballot is kept after its Proposal closes (#111). */
const KEEP_DAYS = 30;

/** The events in `groupId`'s log on `device` naming `motion`, by type. */
async function namingIn(device: TestDevice, groupId: string, motion: string) {
  const group = await device.services.store.getGroup(groupId);
  return (group?.log ?? []).flatMap((record) => {
    const event = parseRecord(record.bytes)?.event;
    if (event?.type !== 'vote' && event?.type !== 'result') return [];
    return event.body.proposal === motion ? [event.type] : [];
  });
}

/** The coalition's motion as `groupId` folds it on `device`, with the coalitions there. */
async function motionIn(device: TestDevice, groupId: string, motion: string) {
  const { store } = device.services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group.');
  const state = foldWithCoalitions(group, foldCoalitions(await store.listCoalitions()));
  return state.proposals.find((proposal) => proposal.id === motion);
}

/** Ana proposes new words for the coalition's first section from its entry, and every device syncs. */
async function anaProposes(ana: TestDevice): Promise<string> {
  const [entry] = await ana.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected the coalition’s entry.');
  const coalitionId = foldCoalitions([entry])[0]?.state.group ?? '';
  const values = {
    atom: `${coalitionId}.0`,
    title: 'Banks too',
    why: 'The banks matter.',
    text: 'Everyone on the east side has a safe, warm home.',
    link: null,
  };
  const proposed = await propose(ana.services, entry.groupId, values, coalitionId);
  if (proposed.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
  await syncAll(2);
  return proposed.proposalId;
}

/** That `device`, its database `name`, keeps `motion` in `groupId` decided by its result alone. */
async function expectExpired(device: TestDevice, name: string, groupId: string, motion: string) {
  expect(await namingIn(device, groupId, motion)).toEqual(['result']);
  expect((await device.services.store.getGroup(groupId))?.cleared).toContain(motion);
  const kept = await motionIn(device, groupId, motion);
  expect([kept?.cleared, kept?.final, kept?.outcome.kind]).toEqual([true, true, 'pass']);
  expect((await scanDb(name)).text).not.toContain(NOTE);
}

describe('a group’s ballots on a coalition’s motion (#278)', SLOW, () => {
  it('expire as its own do: the group’s result goes in its log, and 30 days after the close its ballots and notes go', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await formedCoalition(fake);
    const motion = await anaProposes(ana);
    const scores = { [motion]: 4 as const };
    await castBallot(ana.services, riverside, { proposal: motion, scores, note: '' });
    await castBallot(cy.services, riverside, { proposal: motion, scores, note: NOTE });
    await castBallot(ben.services, oak, { proposal: motion, scores, note: '' });
    await castBallot(cy.services, oak, { proposal: motion, scores, note: '' });
    await syncAll(4);
    const closed = await motionIn(ana, riverside, motion);
    expect([closed?.final, closed?.outcome.kind]).toEqual([true, 'pass']);
    // The control: the same read finds Cy's reason while the ballots are kept.
    expect((await scanDb('ana')).text).toContain(NOTE);

    fake.minute = (closed?.closedAt ?? 0) + KEEP_DAYS * 1_440 + 60;
    await syncAll(4);

    await expectExpired(ana, 'ana', riverside, motion);
    await expectExpired(cy, 'cy', riverside, motion);
  });
});
