/**
 * A restored copy that hasn't heard from its group yet (#231; ADR-0051's
 * 2026-11-11 amendment): every group a restore takes comes back read-only
 * for now, noting the relay minute its copy last synced, and comes back live
 * once a pull shows the relay still held everything since then, or brings a
 * record the copy didn't hold, or an invite's merge brings word from someone
 * in the group. A `dissolve` makes it a dissolved archive instead, and a
 * `remove` of this member a removed one (#115): both are for good.
 */
import { describe, expect, it } from 'vitest';

import { text, utf8 } from '../test/bytes';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { type BackedUpGroup, HISTORY_GAP_MS, openStore, type Pull } from './db';
import { backedUpGroups } from './snapshot';

freshIndexedDBPerTest();

/** A test's event id: the bytes as text. */
const idOf = (bytes: Uint8Array): string => text(bytes);

/** The relay minute the copy last synced at. */
const SINCE = 29_000_010;

/** {@link HISTORY_GAP_MS} in relay minutes: 28 days. */
const GAP = HISTORY_GAP_MS / 60_000;

/** Ana's copy of her group, as a backup file holds it, last synced at relay minute {@link SINCE}. */
function copy(overrides: Partial<BackedUpGroup> = {}): BackedUpGroup {
  return {
    groupId: 'group-1',
    secret: new Uint8Array(32).fill(9),
    signingKey: new Uint8Array(32).fill(7),
    me: { author: 'author-ana', name: 'Ana' },
    log: [{ seq: 3, received: SINCE - 5, bytes: utf8('{"held":3}') }],
    cursor: 3,
    relayNow: SINCE,
    instance: 'relay-1',
    lastSyncAt: 1_000,
    missingHistory: false,
    ...overrides,
  };
}

/** A pass's pull at relay minute `relayNow`, reading `records`. */
function pullAt(relayNow: number, records: Pull['records'] = []): Pull {
  return { records, cursors: {}, relayNow, instance: 'relay-1', lastSyncAt: 2_000 };
}

/** A store holding Ana's copy, restored from a backup file. */
async function restored(overrides: Partial<BackedUpGroup> = {}) {
  const store = await openStore();
  await store.restoreGroups([copy(overrides)]);
  return store;
}

const UNCONFIRMED = { reason: 'unconfirmed', since: SINCE } as const;

describe('a restore (#231)', () => {
  it.each(['backup', 'link'] as const)(
    'brings a group back from a %s read-only for now, since the minute its copy last synced',
    async (from) => {
      const store = await openStore();

      await store.restoreGroups([copy()], [], from);

      expect((await store.getGroup('group-1'))?.archived).toEqual(UNCONFIRMED);
    },
  );

  it('counts a copy that never synced as last hearing from the group at minute 0', async () => {
    const store = await restored({ relayNow: null });

    expect((await store.getGroup('group-1'))?.archived).toEqual({
      reason: 'unconfirmed',
      since: 0,
    });
  });

  it('keeps a copy that folds to a dissolve dissolved, for good (#108)', async () => {
    const store = await restored({ archived: { reason: 'dissolved' } });

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'dissolved' });
  });

  it('marks no coalition’s entry, which never dissolves (#114)', async () => {
    const store = await restored({ kind: 'coalition' });

    expect((await store.getGroup('group-1'))?.archived).toBeUndefined();
  });

  it('marks nothing where the device keeps its own copy, which synced later', async () => {
    const store = await openStore();
    await store.addGroup(copy());
    await store.applyPull('group-1', { ...pullAt(SINCE), lastSyncAt: 5_000 }, idOf);

    await store.restoreGroups([copy()]);

    expect((await store.getGroup('group-1'))?.archived).toBeUndefined();
  });

  it('queues nothing for the copy until it hears from the group', async () => {
    const store = await restored();

    await expect(store.enqueue('group-1', utf8('{"vote":1}'))).rejects.toThrow(
      'This group is read-only on this device.',
    );
  });

  it('leaves the copy out of the next backup, whose restore would look current', async () => {
    const store = await restored();

    expect(backedUpGroups(await store.listGroups())).toEqual([]);
  });
});

describe('a pull into a copy that hasn’t heard from its group (#231)', () => {
  it('opens it when the relay minute is at most 28 days after the copy’s, since the relay still holds all since', async () => {
    const store = await restored();

    await store.applyPull('group-1', pullAt(SINCE + GAP), idOf);

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toBeUndefined();
    expect(kept?.relayNow).toBe(SINCE + GAP);
  });

  it('keeps it read-only a minute past 28 days with nothing new, the relay minute moving on', async () => {
    const store = await restored();

    await store.applyPull('group-1', pullAt(SINCE + GAP + 1), idOf);

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toEqual(UNCONFIRMED);
    expect(kept?.relayNow).toBe(SINCE + GAP + 1);
  });

  it('keeps measuring from the copy’s last sync, so a later pass soon after the first opens nothing', async () => {
    const store = await restored();
    await store.applyPull('group-1', pullAt(SINCE + GAP + 1), idOf);

    await store.applyPull('group-1', pullAt(SINCE + GAP + 2), idOf);

    expect((await store.getGroup('group-1'))?.archived).toEqual(UNCONFIRMED);
  });

  it('opens it for a record the copy didn’t hold, received at its last sync or after', async () => {
    const store = await restored();

    const record = { seq: 9, received: SINCE, bytes: utf8('{"new":9}') };
    await store.applyPull('group-1', pullAt(SINCE + GAP + 1, [record]), idOf);

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toBeUndefined();
    expect(kept?.log.map((each) => text(each.bytes))).toEqual(['{"held":3}', '{"new":9}']);
  });

  it('keeps it read-only for a record the copy missed from before its last sync', async () => {
    const store = await restored();

    const record = { seq: 2, received: SINCE - 1, bytes: utf8('{"old":2}') };
    await store.applyPull('group-1', pullAt(SINCE + GAP + 1, [record]), idOf);

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toEqual(UNCONFIRMED);
    expect(kept?.log).toHaveLength(2);
  });

  it('keeps it read-only for a record the copy already held, whenever the relay says it came', async () => {
    const store = await restored();

    const record = { seq: 3, received: SINCE + 1, bytes: utf8('{"held":3}') };
    await store.applyPull('group-1', pullAt(SINCE + GAP + 1, [record]), idOf);

    expect((await store.getGroup('group-1'))?.archived).toEqual(UNCONFIRMED);
  });

  it('leaves a dissolved archive as it is', async () => {
    const store = await restored({ archived: { reason: 'dissolved' } });

    await store.applyPull('group-1', pullAt(SINCE), idOf);

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'dissolved' });
  });
});

describe('an invite’s merge into a copy that hasn’t heard from its group (#231)', () => {
  it('opens it, since someone in the group made the link from a copy that takes new things', async () => {
    const store = await restored();

    await store.mergeLog('group-1', [], idOf);

    expect((await store.getGroup('group-1'))?.archived).toBeUndefined();
  });

  it('adds what the invite holds and the copy lacks', async () => {
    const store = await restored();

    await store.mergeLog(
      'group-1',
      [{ seq: 4, received: SINCE + 1, bytes: utf8('{"m":4}') }],
      idOf,
    );

    const kept = await store.getGroup('group-1');
    expect(kept?.log.map((each) => text(each.bytes))).toEqual(['{"held":3}', '{"m":4}']);
  });
});

describe('a dissolve folded into a copy that hasn’t heard from its group (#231)', () => {
  it('makes it a dissolved archive, for good', async () => {
    const store = await restored();

    await store.markArchived('group-1', 'dissolved');

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'dissolved' });
  });

  it('clears nothing until then: only an archive’s ballots, for good, are cleared', async () => {
    const store = await restored();

    await expect(
      store.clearArchive('group-1', { at: 7, state: testGroup().state, tallies: {} }),
    ).rejects.toThrow('This group isn’t archived.');
    expect((await store.getGroup('group-1'))?.log).toHaveLength(1);
  });
});

describe('a copy that hasn’t heard from its group, beside a removal (#115)', () => {
  it('keeps a copy that folds to this member’s removal removed, for good', async () => {
    const store = await restored({ archived: { reason: 'removed' } });

    await store.applyPull('group-1', pullAt(SINCE), idOf);

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'removed' });
  });

  it('makes it a removed archive once a remove of this member folds', async () => {
    const store = await restored();

    await store.markArchived('group-1', 'removed');

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'removed' });
  });

  it('keeps a removed archive removed: a later dissolve doesn’t replace it', async () => {
    const store = await restored();
    await store.markArchived('group-1', 'removed');

    await store.markArchived('group-1', 'dissolved');

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'removed' });
  });

  it('lets no invite’s merge open a removed archive, nor add to it', async () => {
    const store = await restored({ archived: { reason: 'removed' } });

    await store.mergeLog(
      'group-1',
      [{ seq: 4, received: SINCE + 1, bytes: utf8('{"m":4}') }],
      idOf,
    );

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toEqual({ reason: 'removed' });
    expect(kept?.log.map((each) => text(each.bytes))).toEqual(['{"held":3}']);
  });

  it('clears a removed archive’s ballots, as a dissolved one’s', async () => {
    const store = await restored({ archived: { reason: 'removed' } });
    const cleared = { at: 7, state: testGroup().state, tallies: {} };

    await store.clearArchive('group-1', cleared);

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toEqual({ reason: 'removed', cleared });
    expect(kept?.log).toEqual([]);
  });
});
