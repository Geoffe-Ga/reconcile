/**
 * `ensureEntries`' sweep of archives (#405, #408): each pass purges what an
 * archive alone held, should the app have closed before its settle could,
 * but only once for each archive as the loop last read it (#409). An archive
 * reads nothing new, so a second look at one finds nothing to do, and the
 * sweep skips it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { COALITION_STATEMENT, seatSecret, testSecret } from '../test/coalitions';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { signedAs, testKeys, testKx } from '../test/keys';
import { ensureEntries } from './coalitions';
import { openStore, type Store } from './db';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const TS = 1_762_650_000_000;
const opened: Sync[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/**
 * Ana's group `name`, kept on `device` and synced, whose log holds her
 * Proposal to reconcile it into the coalition `coalition`; the group's id
 * and the coalition's entry id.
 */
async function groupIn(
  device: { store: Store; sync: Sync },
  name: string,
  coalition: string,
  fill: number,
) {
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name,
      founder: 'Ana',
      documents: [{ title: 'House rules', atoms: [`${name}: be kind.`] }],
      kx: testKx('ana').kx,
    },
  });
  const reconcile = signedAs('ana', {
    type: 'proposal',
    group: genesis.id,
    ts: TS,
    body: {
      target: {
        kind: 'reconcile',
        secret: testSecret(coalition),
        inner: testSecret(`${coalition} inner`),
        seat: base64url(seatSecret(name)),
        ...COALITION_STATEMENT,
      },
      title: 'Reconcile',
      why: 'We share a river.',
    },
  });
  const { secretKey, author } = testKeys('ana');
  await device.store.addGroup({
    groupId: genesis.id,
    secret: new Uint8Array(32).fill(fill),
    signingKey: secretKey,
    kxKey: testKx('ana').kxKey,
    me: { author, name: 'Ana' },
  });
  await device.store.enqueueAll(genesis.id, [genesis.record, reconcile.record]);
  expect(await device.sync.syncOnce()).toBe(true);
  return {
    groupId: genesis.id,
    entry: deriveCoalitionEntryId(fromBase64url(testSecret(coalition))),
  };
}

/**
 * Ana's device with Riverside, which a removal archived before its settle
 * purged the coalition only it held, and Oak St, which goes on in another
 * coalition, so the device still holds one and `ensureEntries` sweeps.
 */
async function archiveBesideLiveGroup(fake: FakeRelay) {
  const store = await openStore('drop-archived-device');
  stores.push(store);
  const sync = createSync({
    store,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
    clock: () => TS,
  });
  opened.push(sync);
  const device = { store, sync };
  const riverside = await groupIn(device, 'Riverside Tenants', 'river', 9);
  const oak = await groupIn(device, 'Oak St Co-op', 'oak', 7);
  sync.stop();
  await store.markArchived(riverside.groupId, 'removed');
  return { store, riverside, oak };
}

describe('ensureEntries’ sweep of archives (#405, #409)', () => {
  it('purges what an archive alone held once, and finds nothing to do for it on the next look', async () => {
    const { store, riverside, oak } = await archiveBesideLiveGroup(createFakeRelay());
    const shared = new Map<string, string>();
    const purges = vi.spyOn(store, 'purgeGroup');
    const reads = vi.spyOn(store, 'listGroups');

    await ensureEntries(store, shared);
    expect(purges.mock.calls).toEqual([[riverside.entry]]);
    expect((await store.listCoalitions()).map((entry) => entry.groupId)).toEqual([oak.entry]);
    purges.mockClear();
    reads.mockClear();

    await ensureEntries(store, shared);
    expect(purges).not.toHaveBeenCalled();
    // Its own read of the groups alone: no second look at the archive's coalitions.
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('looks again at an archive read in another loop, which purges nothing more (the control)', async () => {
    const { store, riverside } = await archiveBesideLiveGroup(createFakeRelay());
    await ensureEntries(store, new Map());
    const purges = vi.spyOn(store, 'purgeGroup');
    const reads = vi.spyOn(store, 'listGroups');

    await ensureEntries(store, new Map());
    expect(purges).not.toHaveBeenCalled();
    // A fresh loop reads the groups, then the archive's coalitions once more.
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await store.getGroup(riverside.entry)).toBeUndefined();
  });
});
