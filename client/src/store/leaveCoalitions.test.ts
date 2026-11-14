/**
 * Leaving a group takes the coalitions only it held with it (#278), even
 * when the app closes partway through (#409), through fake-indexeddb, the
 * fake relay and the real sync loop, checked by a raw read of the device's
 * database that finds the coalition's entry before.
 *
 * Once the relay has the leave, `letGo` purges the coalitions only the group
 * held, then the group. The group's log is what names its coalitions, so the
 * group goes last: should the app close between the two, the next pass finds
 * the group still leaving and lets it go again, and no coalition entry is
 * ever left on the device with nothing to say whose it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { createRelay, type Fetch } from '../net/relay';
import { COALITION_STATEMENT, seatSecret, testSecret } from '../test/coalitions';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { signedAs, testKeys, testKx } from '../test/keys';
import { containsBytes, scanDb } from '../test/scanDb';
import { openStore, type Store } from './db';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const DB = 'leave-coalitions-device';
const TS = 1_762_650_000_000;
const START = 29_000_000;
const opened: Sync[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/** A device on the fake relay: the store at `DB` and its sync loop. */
async function openDevice(fetch: Fetch) {
  const store = await openStore(DB);
  stores.push(store);
  const sync = createSync({
    store,
    relay: createRelay({ fetch }),
    seal: xchachaSeal,
    clock: () => TS,
  });
  opened.push(sync);
  return { store, sync };
}

/**
 * Ana's device holding Riverside, whose log holds her Proposal to reconcile
 * it into a coalition, so the device keeps the coalition's entry; the
 * coalition's secret, its entry's id, and Ana's signed leave of Riverside.
 */
async function anaInCoalition(fake: FakeRelay) {
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      documents: [{ title: 'House rules', atoms: ['Quiet after 11pm.'] }],
      kx: testKx('ana').kx,
    },
  });
  const groupId = genesis.id;
  const reconcile = signedAs('ana', {
    type: 'proposal',
    group: groupId,
    ts: TS,
    body: {
      target: {
        kind: 'reconcile',
        secret: testSecret('coalition'),
        inner: testSecret('inner'),
        seat: base64url(seatSecret('A')),
        ...COALITION_STATEMENT,
      },
      title: 'Reconcile',
      why: 'We share a river.',
    },
  });
  const device = await openDevice(fake.fetch);
  const { secretKey, author } = testKeys('ana');
  await device.store.addGroup({
    groupId,
    secret: new Uint8Array(32).fill(9),
    signingKey: secretKey,
    kxKey: testKx('ana').kxKey,
    me: { author, name: 'Ana' },
  });
  await device.store.enqueueAll(groupId, [genesis.record, reconcile.record]);
  expect(await device.sync.syncOnce()).toBe(true);
  const secret = fromBase64url(testSecret('coalition'));
  const entry = deriveCoalitionEntryId(secret);
  const leave = signedAs('ana', { type: 'leave', group: groupId, ts: TS, body: {} });
  return { device, groupId, secret, entry, leave: leave.record };
}

/** What a raw read of the device's database finds of the coalition's entry `entry`: its id and its `secret`. */
async function traces(entry: string, secret: Uint8Array) {
  const scan = await scanDb(DB);
  return { id: scan.text.includes(entry), secret: containsBytes(scan.bytes, secret) };
}

/** The ids `secret` gives its weekly mailboxes, from five weeks before START's to the week after (#110). */
function weeksOf(secret: Uint8Array): string[] {
  const week = weekOf(START);
  return [-5, -4, -3, -2, -1, 0, 1].map((offset) => deriveWeekMailboxId(secret, week + offset));
}

/** How many requests named any of the coalition's weekly mailboxes. */
function coalitionRequests(fake: FakeRelay, secret: Uint8Array): number {
  const ids = weeksOf(secret);
  return fake.requests.filter((request) => ids.some((id) => request.url.includes(id))).length;
}

/**
 * `store.purgeGroup` as a closing app leaves it: a purge `closing` names, by
 * the group it purges and its place among the purges (1 for the first),
 * rejects as though the app closed just before it; every other runs as it
 * would.
 */
function closesAt(store: Store, closing: (groupId: string, call: number) => boolean) {
  const real = store.purgeGroup.bind(store);
  let call = 0;
  return vi.spyOn(store, 'purgeGroup').mockImplementation(async (groupId) => {
    call += 1;
    if (closing(groupId, call)) throw new Error('The app closed.');
    await real(groupId);
  });
}

/** The device opened again on the same database, then one pass, which reaches the relay. */
async function reopened(fake: FakeRelay) {
  const device = await openDevice(fake.fetch);
  fake.minute += 1;
  expect(await device.sync.syncOnce()).toBe(true);
  return device;
}

describe('leaving the one group that held a coalition (#278, #409)', () => {
  it('leaves no coalition entry on the device when the app closes once the group itself has gone', async () => {
    const fake = createFakeRelay({ minute: START });
    const { device, groupId, secret, entry, leave } = await anaInCoalition(fake);
    // The control: a raw read finds the coalition's entry while Ana is in the group.
    expect(await traces(entry, secret)).toEqual({ id: true, secret: true });
    let groupGone = false;
    closesAt(device.store, (id) => {
      const closing = groupGone;
      if (id === groupId) groupGone = true;
      return closing;
    });

    await device.store.markLeaving(groupId, leave);
    fake.minute += 1;
    await device.sync.syncOnce();
    device.sync.stop();
    const again = await reopened(fake);
    const before = coalitionRequests(fake, secret);
    fake.minute += 1;
    expect(await again.sync.syncOnce()).toBe(true);

    expect(await again.store.getGroup(groupId)).toBeUndefined();
    expect(await again.store.listCoalitions()).toEqual([]);
    expect(await traces(entry, secret)).toEqual({ id: false, secret: false });
    expect(coalitionRequests(fake, secret)).toBe(before);
  });

  it('purges the coalition first, and when the app closes before the group’s purge, the next pass lets the group go', async () => {
    const fake = createFakeRelay({ minute: START });
    const { device, groupId, secret, entry, leave } = await anaInCoalition(fake);
    expect(await traces(entry, secret)).toEqual({ id: true, secret: true });
    closesAt(device.store, (id, call) => id === groupId && call <= 2);

    await device.store.markLeaving(groupId, leave);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(false);
    device.sync.stop();
    // The coalition went before the app closed; the group stays, still leaving.
    expect(await traces(entry, secret)).toEqual({ id: false, secret: false });
    expect((await device.store.getGroup(groupId))?.leaving).toBeDefined();

    const again = await reopened(fake);
    expect(await again.store.getGroup(groupId)).toBeUndefined();
    expect(await again.store.listCoalitions()).toEqual([]);
    // Nor did the pass that finished the leave make the entry again from the group's log.
    expect(await traces(entry, secret)).toEqual({ id: false, secret: false });
  });
});
