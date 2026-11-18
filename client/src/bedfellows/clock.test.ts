/**
 * The slow clock (#479; ADR-0080 §4): the dial turns one step outward for each
 * week the reader opens Bedfellows, and the reader can set, reset or nudge it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dayOf, nextDial, nudge, resetDial, setDial, weekOf } from './clock';
import { TOP } from './mix';

/** Week `n`, as a week number. */
const week = (n: number): number => n;

describe('nextDial (#479)', () => {
  it('moves one step outward in a week Bedfellows was opened, and none in a week it wasn’t', () => {
    expect(nextDial(3, week(10), week(11), true)).toBe(4);
    expect(nextDial(3, week(10), week(14), true)).toBe(4); // one step, however long away
    expect(nextDial(3, week(10), week(11), false)).toBe(3);
  });

  it('never moves twice in one week, nor for a week already stepped or one before it', () => {
    expect(nextDial(3, week(11), week(11), true)).toBe(3);
    expect(nextDial(3, week(12), week(11), true)).toBe(3);
  });

  it('never moves past the top, and reads a dial outside the table as its nearest step', () => {
    expect(nextDial(TOP, week(1), week(2), true)).toBe(TOP);
    expect(nextDial(TOP + 5, week(1), week(2), true)).toBe(TOP);
    expect(nextDial(-4, week(1), week(2), true)).toBe(1);
  });

  it('moves at most one step, outward only, within the table', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TOP }),
        fc.integer(),
        fc.integer(),
        fc.boolean(),
        (dial, last, now, opened) => {
          const next = nextDial(dial, last, now, opened);
          expect(next - dial).toBeGreaterThanOrEqual(0);
          expect(next - dial).toBeLessThanOrEqual(1);
          expect(next).toBeLessThanOrEqual(TOP);
        },
      ),
    );
  });
});

describe('the reader’s hand (#479)', () => {
  it('sets the dial to any step, kept within the table', () => {
    expect(setDial(5)).toBe(5);
    expect(setDial(TOP + 1)).toBe(TOP);
    expect(setDial(-1)).toBe(0);
  });

  it('resets the dial to 0', () => {
    expect(resetDial()).toBe(0);
  });

  it('nudges one step in or out, never past either end', () => {
    expect(nudge(3, 'out')).toBe(4);
    expect(nudge(3, 'in')).toBe(2);
    expect(nudge(0, 'in')).toBe(0);
    expect(nudge(TOP, 'out')).toBe(TOP);
  });
});

describe('days and weeks from a calendar date (#479)', () => {
  it('counts days from 1970-01-01', () => {
    expect(dayOf('1970-01-01')).toBe(0);
    expect(dayOf('1970-01-02')).toBe(1);
    expect(dayOf('2026-11-18')).toBe(20_775);
  });

  it('starts each week on a Monday', () => {
    expect(weekOf('1970-01-04')).toBe(0); // a Sunday
    expect(weekOf('1970-01-05')).toBe(1); // the Monday after
    expect(weekOf('2026-11-16')).toBe(weekOf('2026-11-22'));
    expect(weekOf('2026-11-23')).toBe(weekOf('2026-11-22') + 1);
  });

  it('refuses anything but a YYYY-MM-DD date', () => {
    expect(() => dayOf('18/11/2026')).toThrow(RangeError);
    expect(() => dayOf('2026-13-01')).toThrow(RangeError);
    expect(() => dayOf('2026-02-30')).toThrow(RangeError);
  });
});
