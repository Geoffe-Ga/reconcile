/**
 * Discover's feed (#429; ADR-0077 Context and §7): every Dispatch the device
 * already holds, from its groups and coalitions, newest first, each once, at
 * the highest level it reached. Pure, so fast-check can shuffle the places.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Dispatch } from '../engine/dispatches';
import type { Group } from '../store/db';
import { foldGroup } from '../store/expiry';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import {
  coalitionPlace,
  discoverFeed,
  type FeedPlace,
  type FeedState,
  groupPlace,
} from './discoverFeed';

freshIndexedDBPerTest();

/** A Dispatch with only what the feed reads. */
function dispatch(id: string, received: number, by: Dispatch['by'] = 'author'): Dispatch {
  return { id, by, title: `Title ${id}`, text: '', doc: null, received };
}

/** A place holding `dispatches`, with the promotion motions that carried any of them. */
function place(
  kind: FeedPlace['kind'],
  id: string,
  dispatches: readonly Dispatch[],
  promoted: readonly { readonly motion: string; readonly level: number }[] = [],
): FeedPlace<FeedState> {
  const proposals = promoted.map(({ motion, level }) => ({
    id: motion,
    target: { kind: 'promote', level },
  }));
  return { kind, id, ended: false, state: { name: id, dispatches, proposals } };
}

/** A Dispatch that rose into a coalition by `motion`, under its own id (#126). */
function risen(id: string, received: number, motion: string): Dispatch {
  return dispatch(id, received, { proposal: motion });
}

describe('discoverFeed (#429)', () => {
  it('lists every Dispatch from groups and coalitions, newest first, as the issue’s example', () => {
    const a = place('group', 'Group A', [dispatch('a1', 10)]);
    const b = place('group', 'Group B', [dispatch('b1', 20)]);
    const c = place('coalition', 'Coalition C', [dispatch('c1', 30)]);

    expect(discoverFeed([a, b], [c]).map((item) => item.from.state.name)).toEqual([
      'Coalition C',
      'Group B',
      'Group A',
    ]);
  });

  it('breaks a tie in time by id, and holds nothing for no places', () => {
    const a = place('group', 'a', [dispatch('zz', 5), dispatch('aa', 5)]);

    expect(discoverFeed([a], []).map((item) => item.dispatch.id)).toEqual(['aa', 'zz']);
    expect(discoverFeed([], [])).toEqual([]);
  });

  it('shows a Dispatch that rose once, at the highest level it reached, as that level holds it', () => {
    const group = place('group', 'Riverside', [dispatch('d', 100)]);
    const coalition = place(
      'coalition',
      'Valley',
      [risen('d', 10_180, 'm1')],
      [{ motion: 'm1', level: 1 }],
    );
    const above = place(
      'coalition',
      'Watershed',
      [risen('d', 20_260, 'm2')],
      [{ motion: 'm2', level: 2 }],
    );

    const once = discoverFeed([group], [coalition, above]);
    expect(once.map((item) => [item.dispatch.id, item.from.id, item.dispatch.received])).toEqual([
      ['d', 'Watershed', 20_260],
    ]);
    expect(discoverFeed([group], [coalition]).map((item) => item.from.id)).toEqual(['Valley']);
  });

  it('keeps a group’s own Dispatch where only the group holds it', () => {
    const group = place('group', 'Riverside', [dispatch('d', 100)]);
    const coalition = place('coalition', 'Valley', [dispatch('other', 50)]);

    expect(discoverFeed([group], [coalition]).map((item) => item.from.id)).toEqual([
      'Riverside',
      'Valley',
    ]);
  });

  it('never depends on the order places come in, and never lists an id twice', () => {
    const ids = fc.constantFrom('d1', 'd2', 'd3', 'd4', 'd5');
    const held = fc.uniqueArray(fc.record({ id: ids, received: fc.integer({ min: 0, max: 50 }) }), {
      selector: (entry) => entry.id,
      maxLength: 5,
    });
    const places = fc.uniqueArray(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 4 }),
        coalition: fc.boolean(),
        level: fc.integer({ min: 1, max: 3 }),
        held,
      }),
      { selector: (entry) => entry.id, maxLength: 6 },
    );
    fc.assert(
      fc.property(places, fc.integer(), (drawn, seed) => {
        const built = drawn.map(({ id, coalition, level, held: dispatches }) =>
          coalition
            ? place(
                'coalition',
                id,
                dispatches.map((d) => risen(d.id, d.received, `${id}-${d.id}`)),
                dispatches.map((d) => ({ motion: `${id}-${d.id}`, level })),
              )
            : place(
                'group',
                id,
                dispatches.map((d) => dispatch(d.id, d.received)),
              ),
        );
        const groups = built.filter((p) => p.kind === 'group');
        const coalitions = built.filter((p) => p.kind === 'coalition');
        const feed = discoverFeed(groups, coalitions);
        const shuffled = discoverFeed(shuffle(groups, seed), shuffle(coalitions, seed + 1));

        const key = (items: typeof feed) =>
          items.map((item) => `${item.dispatch.id}@${item.from.id}`);
        expect(key(shuffled)).toEqual(key(feed));
        const seen = feed.map((item) => item.dispatch.id);
        expect(new Set(seen).size).toBe(seen.length);
        expect(new Set(seen)).toEqual(
          new Set(built.flatMap((p) => p.state.dispatches.map((d) => d.id))),
        );
        for (const [i, item] of feed.entries()) {
          const next = feed[i + 1];
          if (next === undefined) continue;
          const newer = item.dispatch.received > next.dispatch.received;
          const tie = item.dispatch.received === next.dispatch.received;
          expect(newer || (tie && item.dispatch.id < next.dispatch.id)).toBe(true);
        }
      }),
    );
  });
});

/** `items` in an order `seed` picks, so the same seed always shuffles the same way. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const keyed = items.map((item, i) => ({ item, key: Math.imul(i + 1, 2_654_435_761) ^ seed }));
  return keyed.sort((x, y) => x.key - y.key).map(({ item }) => item);
}

describe('which stored groups and coalitions the feed reads (#429)', { timeout: 60_000 }, () => {
  /** Ana's one group, as the store keeps it. */
  async function stored() {
    const made = await members(createFakeRelay(), ['Ana']);
    const [ana] = made.devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const group = await ana.services.store.getGroup(made.groupId);
    ana.services.sync.stop();
    ana.services.store.close();
    if (group === undefined) throw new Error('Expected Ana’s group.');
    return group;
  }

  it('reads a group the person is in, and a restored copy that hasn’t heard from it yet (#231)', async () => {
    const group = await stored();

    expect(groupPlace(group)).toMatchObject({ kind: 'group', id: group.groupId, ended: false });
    expect(groupPlace(group)?.state.name).toBe('Riverside Tenants');
    const unconfirmed: Group = { ...group, archived: { reason: 'unconfirmed', since: 0 } };
    expect(groupPlace(unconfirmed)).toMatchObject({ ended: false });
  });

  it('marks a dissolved group’s archive as ended, and leaves out a removed member’s copy and a group it’s leaving', async () => {
    const group = await stored();

    expect(groupPlace({ ...group, archived: { reason: 'dissolved' } })).toMatchObject({
      ended: true,
    });
    expect(groupPlace({ ...group, archived: { reason: 'removed' } })).toBeNull();
    expect(groupPlace({ ...group, leaving: Uint8Array.from([1]) })).toBeNull();
    // One whose genesis isn't back has no name to show yet.
    expect(groupPlace({ ...group, log: [] })).toBeNull();
  });

  it('reads a coalition entry, followed or taken part in, by its folded log', async () => {
    const entry = await stored();
    const state = foldGroup(entry);

    expect(coalitionPlace({ entry: { ...entry, following: true }, state })).toMatchObject({
      kind: 'coalition',
      id: entry.groupId,
      ended: false,
    });
  });
});
