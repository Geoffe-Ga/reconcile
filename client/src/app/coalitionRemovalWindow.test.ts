/**
 * Coalition reporting while a member's removal is in flight (#377, from
 * #323's merge; #115, #122, #126). Riverside (Ana, Cy) and Oak St (Ben, Cy)
 * formed Eastside Housing, and Cy's coalition entry is bound to Oak St's
 * seat. Oak St removes Cy. From the removal's final pass Cy only reads there
 * (`isOusted`), but until a `remove` folds on Cy's own device, which never
 * posts the remove of him, Cy's group still goes on there. In that window his
 * device acts for Oak St in no coalition: it posts no result and no
 * promotion record for Oak St's seat, as it posts none once the `remove`
 * folds and Oak St is archived on it.
 *
 * Everything runs on one fake relay through the app's own actions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { castBallot, propose, proposeDispatch, proposeRemoval } from './proposals';
import { isOusted } from '../engine/capabilities';
import { parseRecord } from '../engine/event';
import { closeAll, coalitionOn, formedCoalition, SLOW, syncAll } from '../test/coalitionDevices';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { foldGroup } from '../store/expiry';

freshIndexedDBPerTest();

afterEach(closeAll);

/** `device`'s member key in `groupId`. */
async function authorIn(device: TestDevice, groupId: string): Promise<string> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  return group.me.author;
}

/** `device`'s one coalition entry. */
async function entryOf(device: TestDevice) {
  const [entry] = await device.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected a coalition entry.');
  return entry;
}

/** Each result and promotion record `device`'s participant signed for the coalition, queued or in its log. */
async function reportsBy(device: TestDevice): Promise<string[]> {
  const entry = await entryOf(device);
  const records = [...entry.log.map((r) => r.bytes), ...entry.outbox];
  return records.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    if (parsed === null || parsed.event.author !== entry.me.author) return [];
    const { event } = parsed;
    if (event.type === 'group-result') return [`result ${event.body.result}`];
    const promote = event.type === 'proposal' && 'target' in event.body;
    return promote && event.body.target.kind === 'promote' ? ['promotion record'] : [];
  });
}

/** The type of each event `device` has queued for `groupId`. */
async function queuedIn(device: TestDevice, groupId: string): Promise<string[]> {
  const group = await device.services.store.getGroup(groupId);
  return (group?.outbox ?? []).flatMap((bytes) => parseRecord(bytes)?.event.type ?? []);
}

/** `voter` scores `proposal` 4 in `groupId`, and its device syncs. */
async function four(voter: TestDevice, groupId: string, proposal: string): Promise<void> {
  await castBallot(voter.services, groupId, { proposal, scores: { [proposal]: 4 }, note: '' });
  await voter.services.sync.syncOnce();
}

describe('a member’s device while their removal is in flight (#377)', SLOW, () => {
  it('reports nothing for the group’s seat from the removal’s final pass, though no remove has folded', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, oak, riverside } = await formedCoalition(fake);
    const coalition = (await coalitionOn(ana)).group;
    if (coalition === null) throw new Error('Expected the coalition to have formed.');
    const before = await reportsBy(cy);

    // Eastside Housing votes on a motion, and Oak St on a Dispatch that may rise.
    const change = {
      atom: `${coalition}.0`,
      title: 'Paths and banks too',
      why: 'We all walk the river paths.',
      text: 'Everyone on the east side has a safe home, and safe paths to it.',
      link: null,
    };
    const motion = await propose(ana.services, (await entryOf(ana)).groupId, change, coalition);
    if (motion.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
    const dispatch = await proposeDispatch(ben.services, oak, {
      title: 'Rally Saturday',
      text: 'Meet at the river at ten.',
      doc: null,
      ceiling: 1,
    });
    if (dispatch.outcome !== 'proposed') throw new Error('Expected the Dispatch to queue.');
    await syncAll(3);
    // Cy scores both first, so neither closes yet.
    await four(cy, oak, dispatch.proposalId);
    await four(cy, oak, motion.proposalId);
    expect(await reportsBy(cy)).toEqual(before);

    // Ben scores both, which closes each early with a pass, then puts Cy's removal to the vote.
    await four(ben, oak, dispatch.proposalId);
    await four(ben, oak, motion.proposalId);
    const cyInOak = await authorIn(cy, oak);
    const removal = await proposeRemoval(ben.services, oak, {
      member: cyInOak,
      title: 'Remove Cy',
      why: 'Cy moved away.',
    });
    if (removal.outcome !== 'proposed') throw new Error('Expected the removal to queue.');
    await ben.services.sync.syncOnce();
    // Ben's ballot closes it early with a pass, final at once. The one pass that posts the ballot
    // queues the remove, which only Ben's next pass would post.
    const scores = { [removal.proposalId]: 4 } as const;
    await castBallot(ben.services, oak, { proposal: removal.proposalId, scores, note: '' });
    await vi.waitFor(async () => {
      expect(await queuedIn(ben, oak)).toContain('remove');
    });

    // Two minutes on, Cy's device syncs before Ben's posts the remove: the window.
    fake.minute += 2;
    await cy.services.sync.syncOnce();
    await cy.services.sync.syncOnce();
    const held = await cy.services.store.getGroup(oak);
    if (held === undefined) throw new Error('Expected Oak St on Cy’s device.');
    const state = foldGroup(held);
    expect(isOusted(state, cyInOak)).toBe(true);
    expect(held.archived).toBeUndefined();
    // Its own fold holds the removal's pass and the Dispatch's, each final (the motion opens only beside the coalition).
    const passed = state.proposals.filter((p) => p.final && p.outcome.kind === 'pass');
    expect(passed.map((p) => p.id)).toEqual(
      expect.arrayContaining([removal.proposalId, dispatch.proposalId]),
    );

    expect(await reportsBy(cy)).toEqual(before);

    // Once Ben's device posts the remove and Cy's folds it, Oak St is archived there, and still nothing goes.
    await ben.services.sync.syncOnce();
    await ben.services.sync.syncOnce();
    await cy.services.sync.syncOnce();
    expect((await cy.services.store.getGroup(oak))?.archived).toEqual({ reason: 'removed' });
    expect(await reportsBy(cy)).toEqual(before);
    // Riverside, where Cy is still in, goes on as before.
    expect((await cy.services.store.getGroup(riverside))?.archived).toBeUndefined();
  });
});
