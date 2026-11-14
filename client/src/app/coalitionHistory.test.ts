/**
 * A coalition's history reaches whoever comes to a seated group after the
 * relay has let it go (#279; ADR-0057, retention). The relay keeps a
 * coalition's mailboxes 30 days, and a coalition read for the first time
 * reads only its last two weeks, so without its genesis a newcomer's device
 * could never fold the coalition, show it or take part in it. A group's
 * invite carries the whole log of every coalition the group reaches, as it
 * carries the group's own (#73), so:
 *
 * - someone who joins Riverside a month after it formed Eastside Housing
 *   reads the coalition's Document and participants, and takes part;
 * - a device of Riverside's that was away while the coalition formed
 *   catches up by opening a new invite from its group, as spec §7's
 *   "Catching up" tells it to.
 *
 * Each runs on the fake relay, whose clock drops blobs as the relay's does,
 * and checks first that the relay no longer holds the coalition's genesis.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { DAY_MINUTES } from '../engine/rules';
import { type TestDevice, TEST_NOW, testDevice } from '../test/appServices';
import {
  anaMakesCard,
  CARD_VALUES,
  closeAll,
  coalitionOn,
  formedCoalition,
  join,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { lookupInvite, makeInvite } from './actions';
import { parseInviteLink } from './invite';
import { bringCard, takePart } from './reconcile';

freshIndexedDBPerTest();

/** Devices a test opened outside `open`, which `syncAll` leaves alone. */
const away: TestDevice[] = [];

afterEach(() => {
  for (const device of away.splice(0)) device.services.store.close();
  closeAll();
});

/** How far the relay's clock moves: past the 30 days it keeps a coalition's blobs. */
const A_MONTH_ON = 32 * DAY_MINUTES;

/** The statement's sections, as the coalition's Document holds them. */
const SECTIONS = CARD_VALUES.statement.split('\n\n');

/** The text of each section of the coalition's Document in `state`, as the card wrote it. */
function sectionsOf(state: { readonly atoms: readonly { readonly text: string }[] }): string[] {
  return state.atoms.map((atom) => atom.text.trim());
}

/** The one coalition entry on `device`. */
async function entryOn(device: TestDevice) {
  const [entry] = await device.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected a coalition entry.');
  return entry;
}

/** How many blobs the relay still holds in the coalition's mailbox for the week the fake's clock started in. */
async function firstWeekBlobs(fake: FakeRelay, ana: TestDevice, start: number): Promise<number> {
  const { secret } = await entryOn(ana);
  return fake.blobs(deriveWeekMailboxId(secret, weekOf(start))).length;
}

describe('a coalition’s history in its group’s invite (#279)', SLOW, () => {
  it('reaches a newcomer a month on, who reads the coalition’s Document and participants and takes part', async () => {
    const fake = createFakeRelay();
    const start = fake.minute;
    const { ana, riverside } = await formedCoalition(fake);
    // The control: the relay holds the coalition's genesis and first records, then lets them go.
    expect(await firstWeekBlobs(fake, ana, start)).toBeGreaterThan(0);
    fake.minute += A_MONTH_ON;
    await syncAll(1);
    expect(await firstWeekBlobs(fake, ana, start)).toBe(0);

    const dee = await open(fake, 'dee');
    await join(ana, riverside, dee, 'Dee');
    const before = await coalitionOn(dee);
    expect(before.coalition?.status).toBe('formed');
    expect(sectionsOf(before)).toEqual(SECTIONS);
    expect(before.members.map((member) => member.name)).toEqual(['Cy', 'Ana E.']);

    await takePart(dee.services, (await entryOn(dee)).groupId, riverside, 'Dee E.');
    await syncAll(2);
    const names = ['Cy', 'Ana E.', 'Dee E.'];
    expect((await coalitionOn(dee)).members.map((member) => member.name)).toEqual(names);
    expect((await coalitionOn(ana)).members.map((member) => member.name)).toEqual(names);
  });

  it('reaches a device that was away while it formed, once it opens a new invite from its group', async () => {
    const fake = createFakeRelay();
    const start = fake.minute;
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
    // Eve joins after the reconcile Proposal opened, so it closes without her, then she's away.
    const eve = await testDevice(fake, 'eve', () => TEST_NOW);
    away.push(eve);
    await join(ana, riverside, eve, 'Eve');
    const brought = await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy]);
    await syncAll();
    fake.minute += A_MONTH_ON;
    await syncAll(1);
    expect(await firstWeekBlobs(fake, ana, start)).toBe(0);
    await eve.services.sync.syncOnce();
    // The control: what Eve's device read of the coalition before she left holds no genesis.
    expect((await coalitionOn(eve)).group).toBeNull();

    const seed = parseInviteLink(await makeInvite(ana.services, riverside, ana.services.origin));
    if (seed === null) throw new Error('Expected an invite link.');
    expect((await lookupInvite(eve.services, seed)).kind).toBe('joined');
    const caught = await coalitionOn(eve);
    expect(caught.coalition?.status).toBe('formed');
    expect(sectionsOf(caught)).toEqual(SECTIONS);
    expect(caught.members.map((member) => member.name)).toEqual(['Cy', 'Ana E.']);
  });
});
