/**
 * Push wakes for a coalition's motion (#284; the founder's decision of
 * 2026-11-12, option 1), through the app's actions and the sync loop on a
 * fake relay: Riverside Tenants (Ana, Cy) and Oak St Co-op (Ben, Cy) form
 * Eastside Housing, and Ana proposes a motion there, which opens in both
 * groups.
 *
 * Each group's devices nudge its own mailbox for the motion, as a proposer's
 * device does for its own Proposal (#99): a day before the deadline and at
 * it, but each group's minutes shift by its own offset,
 * HKDF(group secret, "reconcile/v1/nudge-offset" ‖ motion id) mod 60, so the
 * nudges the relay keeps don't line several groups' mailboxes up on one
 * motion's minutes. And the ballot that closes the motion early in a group
 * wakes that group, as for any Proposal.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { nudgeOffset } from '../crypto/nudgeOffset';
import { DAY_MINUTES } from '../engine/rules';
import { foldCoalitions, foldWithCoalitions } from '../store/coalitions';
import { mailboxAt } from '../store/mailbox';
import type { TestDevice } from '../test/appServices';
import { closeAll, formedCoalition, SLOW, syncAll } from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { castBallot, propose } from './proposals';

freshIndexedDBPerTest();

afterEach(() => {
  closeAll();
});

/** Each group's log length on `device`, by its id: its coalition entries' left out. */
async function groupLogs(device: TestDevice): Promise<Record<string, number>> {
  const groups = await device.services.store.listGroups();
  const own = groups.filter((group) => group.kind === undefined);
  return Object.fromEntries(own.map((group) => [group.groupId, group.log.length]));
}

/**
 * An hour after the coalition formed, so the motion's minutes aren't the
 * reconcile Proposals', and once each group's results for them are in, Ana
 * proposes new words for the coalition's first section from its entry, and
 * every device syncs. The motion's id, how many requests `fake` had taken
 * before, and each of Ana's groups' log length then.
 */
async function anaProposes(fake: FakeRelay, ana: TestDevice) {
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
  fake.minute += 60;
  await syncAll(4);
  const from = fake.requests.length;
  const logs = await groupLogs(ana);
  const proposed = await propose(ana.services, entry.groupId, values, coalitionId);
  if (proposed.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
  await syncAll(3);
  return { motion: proposed.proposalId, from, logs };
}

/** What `device` holds of `groupId`: its secret, and the motion as the group folds it. */
async function held(device: TestDevice, groupId: string, motion: string) {
  const { store } = device.services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group.');
  const state = foldWithCoalitions(group, foldCoalitions(await store.listCoalitions()));
  const opened = state.proposals.find((proposal) => proposal.id === motion);
  if (opened === undefined) throw new Error('Expected the motion to open in the group.');
  return { group, opened };
}

/** The minutes of the nudges POSTed to `mailbox` from request `from` on, each once, in order. */
function nudgedAt(fake: FakeRelay, mailbox: string, from: number): number[] {
  const minutes = fake.requests
    .slice(from)
    .filter((r) => r.method === 'POST' && r.url === `/v1/push/${mailbox}/nudge`)
    .map(
      (r) => (JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array())) as Due).not_before,
    );
  return [...new Set(minutes)].sort((a, b) => a - b);
}

/** A nudge's body (#89). */
interface Due {
  readonly not_before: number;
}

/**
 * The minutes the group's devices nudged since `from`, each once, in the
 * group's mailbox for the week `motion` was received in (#110), and the
 * minutes the group's offset gives.
 */
async function nudgesOf(
  fake: FakeRelay,
  from: number,
  device: TestDevice,
  groupId: string,
  motion: string,
) {
  const { group, opened } = await held(device, groupId, motion);
  const offset = nudgeOffset(group.secret, motion);
  const mailbox = mailboxAt(group, opened.received);
  return {
    taken: nudgedAt(fake, mailbox, from),
    expected: [opened.deadline - DAY_MINUTES + offset, opened.deadline + offset],
    base: [opened.deadline - DAY_MINUTES, opened.deadline],
    offset,
  };
}

describe('nudges for a coalition’s motion (#284)', SLOW, () => {
  it('nudge each group’s mailbox a day before the deadline and at it, shifted by the group’s own offset, once each', async () => {
    const fake = createFakeRelay();
    const { ana, ben, riverside, oak } = await formedCoalition(fake);
    const { motion, from, logs } = await anaProposes(fake, ana);

    const inRiverside = await nudgesOf(fake, from, ana, riverside, motion);
    const inOak = await nudgesOf(fake, from, ben, oak, motion);
    // The motion opened from the coalition's log alone: no group's own log took a record.
    expect(await groupLogs(ana)).toEqual(logs);
    expect(inRiverside.taken).toEqual(inRiverside.expected);
    expect(inOak.taken).toEqual(inOak.expected);
    // Each device that may vote on it posts each nudge once, however many passes run.
    const before = fake.requests.filter((r) => r.url.endsWith('/nudge')).length;
    await syncAll(2);
    expect(fake.requests.filter((r) => r.url.endsWith('/nudge')).length).toBe(before);
    for (const device of [ana, ben]) {
      const nudged = (await device.services.store.getGroup(device === ana ? riverside : oak))
        ?.nudged;
      expect(nudged?.filter((key) => key.startsWith(`${motion}@`))).toHaveLength(2);
    }
  });

  it('keep the relay from lining two groups’ mailboxes up on one motion’s minutes, but by chance', async () => {
    const fake = createFakeRelay();
    const { ana, ben, riverside, oak } = await formedCoalition(fake);
    const { motion, from } = await anaProposes(fake, ana);

    const inRiverside = await nudgesOf(fake, from, ana, riverside, motion);
    const inOak = await nudgesOf(fake, from, ben, oak, motion);
    // The control: unshifted, both groups' nudges would fall due at the very same minutes.
    expect(inRiverside.base).toEqual(inOak.base);
    // Each group's random secret gives its own offset; two agree 1 time in 60, and then
    // their minutes meet by chance, which says nothing of the coalition.
    if (inRiverside.offset !== inOak.offset) {
      expect(inRiverside.taken.filter((minute) => inOak.taken.includes(minute))).toEqual([]);
    }
    expect(inRiverside.taken).toEqual(inRiverside.expected);
    expect(inOak.taken).toEqual(inOak.expected);
  });

  it('register a phone under the week its group’s nudges for the motion wait in, once that week has passed', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await formedCoalition(fake);
    const { motion } = await anaProposes(fake, ana);
    const { group, opened } = await held(ana, riverside, motion);
    // Into a later week, with the motion's vote still open.
    fake.minute += 3 * DAY_MINUTES;
    await syncAll(1);

    ana.push.answer = 'granted';
    expect(await ana.services.push.turnOn(riverside)).toBe('on');
    const registered = (await ana.services.store.getGroup(riverside))?.push?.mailboxes ?? [];
    expect(registered).toContain(mailboxAt(group, opened.received));
    expect(mailboxAt(group, opened.received)).not.toBe(mailboxAt(group, fake.minute));
  });
});

describe('a ballot that closes a coalition’s motion early in a group (#284)', SLOW, () => {
  it('wakes the group, as for any Proposal, and an earlier ballot doesn’t', async () => {
    const fake = createFakeRelay();
    const { ana, cy, riverside } = await formedCoalition(fake);
    const { motion } = await anaProposes(fake, ana);
    const { group } = await held(ana, riverside, motion);
    const mailbox = mailboxAt(group, fake.minute);
    /** Each blob PUT to Riverside's mailbox since `from`, as whether it asked for a wake. */
    const wakes = (from: number) =>
      fake.requests
        .slice(from)
        .filter((r) => r.method === 'PUT' && r.url.startsWith(`/v1/mailbox/${mailbox}?`))
        .map((r) => r.url.endsWith('&wake=1'));
    const scores = { [motion]: 4 as const };

    let from = fake.requests.length;
    await castBallot(ana.services, riverside, { proposal: motion, scores, note: '' });
    await ana.services.sync.syncOnce();
    const first = wakes(from);
    await cy.services.sync.syncOnce();
    from = fake.requests.length;
    await castBallot(cy.services, riverside, { proposal: motion, scores, note: '' });
    await cy.services.sync.syncOnce();
    const closing = wakes(from);

    expect(first).toEqual([false]);
    expect(closing).toEqual([true]);
  });
});
