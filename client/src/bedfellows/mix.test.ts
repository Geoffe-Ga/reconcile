/**
 * The mix (#479; ADR-0080 §4, §6): the dial's table of shares, the floors and
 * ceilings every view keeps, and the turn that rotates a tier's order by day.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CEILING,
  ceilingCount,
  clampDial,
  FLOORS,
  floorCount,
  mix,
  rotate,
  sharesAt,
  SHARES,
  TOP,
  turn,
} from './mix';
import type { Tier } from './types';

const TIERS: readonly Tier[] = ['close', 'middle', 'strange'];

/** `count` distinct items for `tier`. */
function items(tier: Tier, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${tier}${String(i)}`);
}

/** Tiered input with `close`, `middle` and `strange` items. */
function tiered(close: number, middle: number, strange: number): Record<Tier, string[]> {
  return {
    close: items('close', close),
    middle: items('middle', middle),
    strange: items('strange', strange),
  };
}

/** How many of `shown` came from `tier`. */
function countOf(shown: readonly string[], tier: Tier): number {
  return shown.filter((item) => item.startsWith(tier)).length;
}

describe('the dial table (#479)', () => {
  it('is mostly close at 0 and mostly strange at the top', () => {
    expect(sharesAt(0).close).toBeGreaterThan(sharesAt(0).strange);
    expect(sharesAt(TOP).strange).toBeGreaterThan(sharesAt(TOP).close);
    expect(sharesAt(0)).toEqual({ close: 0.7, middle: 0.2, strange: 0.1 });
    expect(sharesAt(TOP)).toEqual({ close: 0.15, middle: 0.25, strange: 0.6 });
  });

  it('has one row for every step from 0 to the top, each summing to the whole', () => {
    expect(TOP).toBe(8);
    expect(SHARES).toHaveLength(TOP + 1);
    for (const row of SHARES) expect(row.close + row.middle + row.strange).toBe(100);
  });

  it('keeps every floor and ceiling at every step', () => {
    for (const row of SHARES) {
      expect(row.close).toBeGreaterThanOrEqual(FLOORS.close);
      expect(row.strange).toBeGreaterThanOrEqual(FLOORS.strange);
      for (const tier of TIERS) expect(row[tier]).toBeLessThanOrEqual(CEILING);
    }
  });

  it('turns outward: strange never falls and close never rises from one step to the next', () => {
    SHARES.slice(1).forEach((row, i) => {
      const before = SHARES[i];
      expect(row.strange).toBeGreaterThan(before?.strange ?? Infinity);
      expect(row.close).toBeLessThan(before?.close ?? -Infinity);
    });
  });

  it('reads a dial outside the table, or between steps, as the nearest step', () => {
    expect(clampDial(-3)).toBe(0);
    expect(clampDial(TOP + 4)).toBe(TOP);
    expect(clampDial(2.4)).toBe(2);
    expect(clampDial(2.6)).toBe(3);
    expect(clampDial(Number.NaN)).toBe(0);
    expect(sharesAt(99)).toEqual(sharesAt(TOP));
  });
});

describe('floor and ceiling counts (#479)', () => {
  it('rounds a floor down and a ceiling up, so a small view can still be filled', () => {
    expect(floorCount('close', 10)).toBe(1);
    expect(floorCount('strange', 10)).toBe(1);
    expect(floorCount('close', 20)).toBe(3);
    expect(floorCount('middle', 20)).toBe(0);
    expect(ceilingCount(10)).toBe(7);
    expect(ceilingCount(4)).toBe(3);
    expect(ceilingCount(1)).toBe(1);
  });
});

describe('mix (#479)', () => {
  it('shows each tier its share of the view at the dial, close kin first', () => {
    const at0 = mix(tiered(20, 20, 20), 0, 10);
    expect(at0.unkept).toEqual([]);
    expect(at0.shown).toEqual([
      ...items('close', 7),
      ...items('middle', 2),
      ...items('strange', 1),
    ]);

    const atTop = mix(tiered(20, 20, 20), TOP, 10);
    expect([
      countOf(atTop.shown, 'close'),
      countOf(atTop.shown, 'middle'),
      countOf(atTop.shown, 'strange'),
    ]).toEqual([2, 2, 6]);
  });

  it('fills a short tier’s room from the others and names the floor it couldn’t keep', () => {
    const result = mix(tiered(20, 20, 0), 0, 10);

    expect(result.shown).toHaveLength(10);
    expect(countOf(result.shown, 'strange')).toBe(0);
    expect(countOf(result.shown, 'close')).toBe(7);
    expect(countOf(result.shown, 'middle')).toBe(3);
    expect(result.unkept).toEqual(['strange']);
  });

  it('lets no tier past its ceiling, even when the view comes up short', () => {
    const result = mix(tiered(20, 0, 0), 0, 10);

    expect(result.shown).toEqual(items('close', 7));
    expect(result.unkept).toEqual(['strange']);
  });

  it('names both floors when neither close nor strange has enough', () => {
    expect(mix(tiered(0, 20, 0), 4, 10).unkept).toEqual(['close', 'strange']);
  });

  it('keeps a floor of none without complaint, and shows nothing for a view of none', () => {
    expect(mix(tiered(3, 0, 0), 0, 3).unkept).toEqual([]);
    expect(mix(tiered(3, 3, 3), 0, 0)).toEqual({ shown: [], unkept: [] });
    expect(mix(tiered(3, 3, 3), 0, -2)).toEqual({ shown: [], unkept: [] });
  });

  it('holds every floor and ceiling at every step for any input with enough entries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOP }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 40 }),
        (dial, size, spare) => {
          const enough = size + spare;
          const { shown, unkept } = mix(tiered(enough, enough, enough), dial, size);
          expect(shown).toHaveLength(size);
          expect(unkept).toEqual([]);
          expect(countOf(shown, 'close')).toBeGreaterThanOrEqual(floorCount('close', size));
          expect(countOf(shown, 'strange')).toBeGreaterThanOrEqual(floorCount('strange', size));
          for (const tier of TIERS)
            expect(countOf(shown, tier)).toBeLessThanOrEqual(ceilingCount(size));
        },
      ),
    );
  });

  it('never lowers the strange share as the dial turns outward', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOP - 1 }),
        fc.integer({ min: 1, max: 60 }),
        (dial, size) => {
          const input = tiered(size, size, size);
          const before = countOf(mix(input, dial, size).shown, 'strange');
          const after = countOf(mix(input, dial + 1, size).shown, 'strange');
          expect(after).toBeGreaterThanOrEqual(before);
          expect(sharesAt(dial + 1).strange).toBeGreaterThanOrEqual(sharesAt(dial).strange);
        },
      ),
    );
  });

  it('never shows an entry twice or more than it was asked for, and names only floors it missed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOP }),
        fc.integer({ min: 0, max: 30 }),
        fc.tuple(fc.nat(30), fc.nat(30), fc.nat(30)),
        (dial, size, [close, middle, strange]) => {
          const { shown, unkept } = mix(tiered(close, middle, strange), dial, size);
          expect(new Set(shown).size).toBe(shown.length);
          expect(shown.length).toBeLessThanOrEqual(size);
          for (const tier of unkept)
            expect(countOf(shown, tier)).toBeLessThan(floorCount(tier, size));
          for (const tier of TIERS)
            expect(countOf(shown, tier)).toBeLessThanOrEqual(ceilingCount(size));
        },
      ),
    );
  });

  it('keeps each tier’s own order and takes from its front', () => {
    const input = { close: ['c2', 'c1', 'c3'], middle: ['m9'], strange: ['s5', 's4'] };

    expect(mix(input, TOP, 4).shown).toEqual(['c2', 'm9', 's5', 's4']);
  });
});

describe('rotate and turn (#479)', () => {
  it('turns by the same amount for the same day, seed and salt, and by another for another day', () => {
    expect(turn(20_000, 7, 'close')).toBe(turn(20_000, 7, 'close'));
    const days = Array.from({ length: 30 }, (_, i) => turn(20_000 + i, 7, 'close') % 5);
    expect(new Set(days).size).toBeGreaterThan(1);
    expect(turn(20_000, 7, 'close')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(turn(20_000, 7, 'close'))).toBe(true);
  });

  it('rotates a list without losing or repeating anything', () => {
    expect(rotate(['a', 'b', 'c', 'd'], 1)).toEqual(['b', 'c', 'd', 'a']);
    expect(rotate(['a', 'b', 'c', 'd'], 6)).toEqual(['c', 'd', 'a', 'b']);
    expect(rotate([], 3)).toEqual([]);
    fc.assert(
      fc.property(fc.uniqueArray(fc.string()), fc.nat(), (list, by) => {
        expect([...rotate(list, by)].sort()).toEqual([...list].sort());
      }),
    );
  });
});
