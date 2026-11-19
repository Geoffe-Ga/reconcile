/**
 * Telling affected devices (#491; listed-doors.md §6.5): a tombstone matched
 * on the device against the applications and reconcile cards it sent, by
 * door address, and what the device keeps of the cards it sent and the lines
 * its reader dismissed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ShelfTombstone } from './fold';
import type { Clause } from './record';
import {
  affectedBy,
  DISMISSED_KEEP_DAYS,
  type KeptRemovals,
  prunedRemovals,
  removalKey,
  removalLines,
  type SentToDoor,
  withDismissed,
  withSentCard,
} from './affected';

const ADDRESS = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const ENTRY = 'E'.repeat(43);
const DAY_MS = 86_400_000;
const DAY_3 = 3 * DAY_MS;

/** A suspend's tombstone for `address`'s listing, under `clause`. */
const suspended = (address: string, clause: Clause, seq = 9): ShelfTombstone => ({
  address,
  id: null,
  clause,
  seq,
});

/** An uphold's tombstone for entry `id` under `address`. */
const upheld = (address: string, id: string, clause: Clause, seq = 8): ShelfTombstone => ({
  address,
  id,
  clause,
  seq,
});

const application = (door: string, sentAt: number): SentToDoor => ({
  door,
  sentAt,
  kind: 'application',
});

const card = (door: string, sentAt: number): SentToDoor => ({ door, sentAt, kind: 'card' });

describe('affectedBy (#491)', () => {
  it('matches a tombstone to an application sent to that door', () => {
    const sent = [application(ADDRESS, DAY_3)];
    expect(affectedBy([suspended(ADDRESS, 'C3')], sent)).toEqual([
      {
        door: ADDRESS,
        sentAt: DAY_3,
        kind: 'application',
        clause: 'C3',
        entry: null,
        key: ADDRESS,
      },
    ]);
  });

  it('matches a card sent to that door, and an upheld entry under it', () => {
    const sent = [card(ADDRESS, DAY_3)];
    expect(affectedBy([upheld(ADDRESS, ENTRY, 'C2')], sent)).toEqual([
      {
        door: ADDRESS,
        sentAt: DAY_3,
        kind: 'card',
        clause: 'C2',
        entry: ENTRY,
        key: `${ADDRESS} ${ENTRY}`,
      },
    ]);
  });

  it('matches nothing sent to another door, and nothing without a tombstone', () => {
    expect(affectedBy([suspended(OTHER, 'C1')], [application(ADDRESS, DAY_3)])).toEqual([]);
    expect(affectedBy([], [application(ADDRESS, DAY_3)])).toEqual([]);
    expect(affectedBy([suspended(ADDRESS, 'C1')], [])).toEqual([]);
  });

  it('matches each thing sent to the door, for each tombstone there', () => {
    const sent = [application(ADDRESS, DAY_3), card(ADDRESS, DAY_MS), application(OTHER, 0)];
    const matched = affectedBy([suspended(ADDRESS, 'C1'), upheld(ADDRESS, ENTRY, 'C2')], sent);
    expect(matched.map(({ key, kind }) => [key, kind])).toEqual([
      [ADDRESS, 'application'],
      [ADDRESS, 'card'],
      [`${ADDRESS} ${ENTRY}`, 'application'],
      [`${ADDRESS} ${ENTRY}`, 'card'],
    ]);
  });

  it('never matches a door no sent thing names, whatever the tombstones', () => {
    const doors = fc.constantFrom(ADDRESS, OTHER, 'C'.repeat(43));
    const tombstone = fc.record({
      address: doors,
      id: fc.option(fc.constant(ENTRY)),
      clause: fc.constantFrom<Clause>('C1', 'C2', 'C3'),
      seq: fc.nat(),
    });
    const sentOne = fc.record({
      door: doors,
      sentAt: fc.nat(),
      kind: fc.constantFrom<SentToDoor['kind']>('application', 'card'),
    });
    fc.assert(
      fc.property(fc.array(tombstone), fc.array(sentOne), (tombstones, sent) => {
        const matched = affectedBy(tombstones, sent);
        for (const one of matched) {
          expect(sent.some((s) => s.door === one.door && s.sentAt === one.sentAt)).toBe(true);
          expect(tombstones.some((t) => t.address === one.door && t.clause === one.clause)).toBe(
            true,
          );
        }
      }),
    );
  });
});

describe('removalKey (#491)', () => {
  it('names a listing by its address and an entry by its address and id', () => {
    expect(removalKey({ address: ADDRESS, id: null })).toBe(ADDRESS);
    expect(removalKey({ address: ADDRESS, id: ENTRY })).toBe(`${ADDRESS} ${ENTRY}`);
  });
});

describe('removalLines (#491)', () => {
  it('shows one line a tombstone, for the earliest thing sent, until it is dismissed', () => {
    const sent = [application(ADDRESS, DAY_3), card(ADDRESS, DAY_MS)];
    const matched = affectedBy([suspended(ADDRESS, 'C1')], sent);

    expect(removalLines(matched, new Set())).toEqual([
      { door: ADDRESS, sentAt: DAY_MS, kind: 'card', clause: 'C1', entry: null, key: ADDRESS },
    ]);
    expect(removalLines(matched, new Set([ADDRESS]))).toEqual([]);
  });

  it('keeps an entry’s line when only the listing’s was dismissed', () => {
    const matched = affectedBy(
      [suspended(ADDRESS, 'C1'), upheld(ADDRESS, ENTRY, 'C2')],
      [application(ADDRESS, DAY_3)],
    );
    expect(removalLines(matched, new Set([ADDRESS])).map(({ key }) => key)).toEqual([
      `${ADDRESS} ${ENTRY}`,
    ]);
  });
});

describe('what the device keeps (#491)', () => {
  const NONE: KeptRemovals = { cards: [], dismissed: [] };

  it('adds a card sent, and forgets cards from 30 days before it', () => {
    const old = withSentCard(NONE, { door: OTHER, sentAt: 0 });
    const kept = withSentCard(old, { door: ADDRESS, sentAt: 30 * DAY_MS });
    expect(kept.cards).toEqual([{ door: ADDRESS, sentAt: 30 * DAY_MS }]);
    const both = withSentCard(old, { door: ADDRESS, sentAt: 30 * DAY_MS - 1 });
    expect(both.cards).toEqual([
      { door: OTHER, sentAt: 0 },
      { door: ADDRESS, sentAt: 30 * DAY_MS - 1 },
    ]);
  });

  it('adds a dismissal once by its key', () => {
    const once = withDismissed(NONE, { key: ADDRESS, door: ADDRESS, at: DAY_3 });
    const twice = withDismissed(once, { key: ADDRESS, door: ADDRESS, at: DAY_3 + 1 });
    expect(twice.dismissed).toEqual([{ key: ADDRESS, door: ADDRESS, at: DAY_3 }]);
  });

  it('forgets cards 30 days old, and a dismissal only once its door is unsent and it is old', () => {
    const now = 100 * DAY_MS;
    const keep = DISMISSED_KEEP_DAYS * DAY_MS;
    const kept: KeptRemovals = {
      cards: [
        { door: ADDRESS, sentAt: now - 30 * DAY_MS },
        { door: OTHER, sentAt: now - 30 * DAY_MS + 1 },
      ],
      dismissed: [
        // Its door is still sent to (OTHER's card), so it stays however old.
        { key: OTHER, door: OTHER, at: 0 },
        // Its door is no longer sent to, but it is recent.
        { key: ADDRESS, door: ADDRESS, at: now - keep + 1 },
        // Neither: it goes.
        { key: `${ADDRESS} ${ENTRY}`, door: ADDRESS, at: now - keep },
      ],
    };

    expect(prunedRemovals(kept, [], now)).toEqual({
      cards: [{ door: OTHER, sentAt: now - 30 * DAY_MS + 1 }],
      dismissed: [
        { key: OTHER, door: OTHER, at: 0 },
        { key: ADDRESS, door: ADDRESS, at: now - keep + 1 },
      ],
    });
    // An application still kept to the door keeps its dismissals too.
    const sent = [application(ADDRESS, 0)];
    expect(prunedRemovals(kept, sent, now).dismissed).toHaveLength(3);
  });
});
