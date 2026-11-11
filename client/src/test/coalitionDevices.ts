/**
 * Coalition devices for tests (#114): several devices on one fake relay, set
 * up through the app's own actions. Ana founds Riverside Tenants, Ben founds
 * Oak St Co-op, and Cy joins both; Ana makes a card, which Cy opens.
 */
import { createGroup, joinGroup, lookupInvite, makeInvite } from '../app/actions';
import { parseInviteLink } from '../app/invite';
import { castBallot } from '../app/proposals';
import { lookupCard, makeCard, postCard } from '../app/reconcile';
import { parseCardLink } from '../coalition/card';
import type { Score } from '../engine/event';
import { LEVELS } from '../engine/capabilities';
import { fold, type GroupState } from '../engine/fold';
import { TEST_NOW, type TestDevice, testDevice } from './appServices';
import type { FakeRelay } from './fakeRelay';

/** The creating level, so every person here may propose and bring cards. */
const [, , CREATING] = LEVELS;

/** Several devices syncing in turn: these tests run longer than one device's. */
export const SLOW = { timeout: 30_000 };

/** The devices a test opened, in order: `syncAll` syncs them, `closeAll` closes them. */
const devices: TestDevice[] = [];

/** Closes every device a test opened; a test unmounts its own app first. */
export function closeAll(): void {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
}

/** Opens device `name` on `fake`, kept for `syncAll` and `closeAll`. */
export async function open(fake: FakeRelay, name: string): Promise<TestDevice> {
  const device = await testDevice(fake, name, () => TEST_NOW);
  devices.push(device);
  return device;
}

/** `device` founds `groupName` as `yourName`, and syncs; returns its id. */
export async function found(
  device: TestDevice,
  groupName: string,
  yourName: string,
): Promise<string> {
  const created = await createGroup(device.services, {
    groupName,
    yourName,
    chat: null,
    title: 'House rules',
    text: 'Quiet hours start at ten.',
  });
  if (created.outcome !== 'created') throw new Error('Expected a group.');
  await device.services.sync.syncOnce();
  return created.groupId;
}

/** `device` joins `groupId` as `name`, a Co-Creator, from a link `from` makes. */
export async function join(from: TestDevice, groupId: string, device: TestDevice, name: string) {
  const seed = parseInviteLink(await makeInvite(from.services, groupId, from.services.origin));
  if (seed === null) throw new Error('Expected an invite link.');
  const lookup = await lookupInvite(device.services, seed);
  if (lookup.kind !== 'found') throw new Error('Expected the invite to open.');
  await joinGroup(device.services, lookup.group, name, CREATING);
  await device.services.sync.syncOnce();
}

/** Every device syncs, `rounds` times over. */
export async function syncAll(rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) await device.services.sync.syncOnce();
  }
}

/** Riverside Tenants (Ana, Cy) and Oak St Co-op (Ben, Cy), all synced. */
export async function twoGroups(fake: FakeRelay) {
  const ana = await open(fake, 'ana');
  const ben = await open(fake, 'ben');
  const cy = await open(fake, 'cy');
  const riverside = await found(ana, 'Riverside Tenants', 'Ana');
  const oak = await found(ben, 'Oak St Co-op', 'Ben');
  await join(ana, riverside, cy, 'Cy');
  await join(ben, oak, cy, 'Cy');
  await syncAll(1);
  return { ana, ben, cy, riverside, oak };
}

/** What Ana writes on her card. */
export const CARD_VALUES = {
  name: 'Eastside Housing',
  statement: 'Everyone on the east side has a safe home.\n\nWe meet on the first Sunday.',
  why: 'We share a landlord.',
  yourName: 'Ana E.',
};

/** Ana's card for Riverside, posted, and the card `opener` opens from its link. */
export async function anaMakesCard(
  ana: TestDevice,
  opener: TestDevice,
  riverside: string,
  values = CARD_VALUES,
) {
  const made = await makeCard(ana.services, riverside, values);
  if (made.outcome !== 'queued') throw new Error('Expected a card.');
  const link = await postCard(ana.services, made.card, ana.services.origin);
  await syncAll(1);
  const seed = parseCardLink(link);
  if (seed === null) throw new Error('Expected a card link.');
  const lookup = await lookupCard(opener.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  return { proposal: made.proposalId, found: lookup.found, seed, link, card: made.card };
}

/** Each device scores the Proposal `score` in `groupId`, with a reason for a 0. */
export async function vote(
  groupId: string,
  proposal: string,
  voters: readonly TestDevice[],
  score: Score = 4,
) {
  for (const voter of voters) {
    const note = score === 0 ? 'Not with them.' : '';
    await castBallot(voter.services, groupId, { proposal, scores: { [proposal]: score }, note });
  }
}

/** The coalition as `device` folds its one entry, failing when it holds none or more. */
export async function coalitionOn(device: TestDevice): Promise<GroupState> {
  const entries = await device.services.store.listCoalitions();
  const [entry] = entries;
  if (entry === undefined || entries.length !== 1) {
    throw new Error(`Expected one coalition entry, not ${String(entries.length)}.`);
  }
  return fold(entry.log, entry.relayNow);
}
