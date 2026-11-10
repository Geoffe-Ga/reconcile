import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Bar, DEFAULT_RULES } from '../engine/rules';
import {
  averageShare,
  formatAverage,
  formatAverageLine,
  formatDay,
  formatShortfall,
  formatZeroLine,
  formatZeroShare,
  lineShare,
  zeroShare,
} from './format';

/** The consent floor, an ordinary change's bar (ADR-0002). */
const CONSENT_FLOOR: Bar = DEFAULT_RULES.bars.ordinary;
/** The entrenched bar (ADR-0015 §2), so nothing here assumes the consent floor. */
const HIGH: Bar = DEFAULT_RULES.bars.entrenched;

const scorers = fc.integer({ min: 1, max: 500 });
const totals = scorers.chain((n) =>
  fc.record({ scorers: fc.constant(n), sum: fc.integer({ min: 0, max: 4 * n }) }),
);
const zeroTotals = scorers.chain((n) =>
  fc.record({ scorers: fc.constant(n), zeros: fc.integer({ min: 0, max: n }) }),
);

describe('formatAverage', () => {
  it('floors to one decimal, so an exact 1.96 reads 1.9', () => {
    expect(formatAverage({ sum: 49, scorers: 25 })).toBe('1.9');
    expect(formatAverage({ sum: 50, scorers: 25 })).toBe('2.0');
    expect(formatAverage({ sum: 7, scorers: 3 })).toBe('2.3');
    expect(formatAverage({ sum: 12, scorers: 3 })).toBe('4.0');
    expect(formatAverage({ sum: 0, scorers: 4 })).toBe('0.0');
  });

  it('reads 0.0 rather than dividing by zero before anyone has scored', () => {
    expect(formatAverage({ sum: 0, scorers: 0 })).toBe('0.0');
  });

  it('never shows the bar or more unless the exact average reaches it', () => {
    fc.assert(
      fc.property(totals, fc.constantFrom(CONSENT_FLOOR, HIGH), (t, bar) => {
        const shown = Number(formatAverage(t));
        expect(shown >= bar.avgAtLeast).toBe(t.sum >= bar.avgAtLeast * t.scorers);
        expect(shown).toBeLessThanOrEqual(t.sum / t.scorers);
        expect(t.sum / t.scorers - shown).toBeLessThan(0.1);
      }),
    );
  });
});

describe('formatShortfall', () => {
  it('rounds the gap up to one decimal', () => {
    expect(formatShortfall({ sum: 49, scorers: 25 }, CONSENT_FLOOR)).toBe('0.1');
    expect(formatShortfall({ sum: 5, scorers: 3 }, CONSENT_FLOOR)).toBe('0.4');
    expect(formatShortfall({ sum: 3, scorers: 3 }, CONSENT_FLOOR)).toBe('1.0');
    expect(formatShortfall({ sum: 0, scorers: 3 }, CONSENT_FLOOR)).toBe('2.0');
  });

  it('is null once the average meets the bar', () => {
    expect(formatShortfall({ sum: 50, scorers: 25 }, CONSENT_FLOOR)).toBeNull();
    expect(formatShortfall({ sum: 9, scorers: 3 }, HIGH)).toBeNull();
    expect(formatShortfall({ sum: 8, scorers: 3 }, HIGH)).toBe('0.4');
  });

  it('never shows 0.0, and the shown average plus the gap always reaches the bar', () => {
    fc.assert(
      fc.property(totals, fc.constantFrom(CONSENT_FLOOR, HIGH), (t, bar) => {
        const gap = formatShortfall(t, bar);
        if (t.sum >= bar.avgAtLeast * t.scorers) {
          expect(gap).toBeNull();
          return;
        }
        expect(gap).not.toBe('0.0');
        expect(Number(gap)).toBeGreaterThanOrEqual(bar.avgAtLeast - t.sum / t.scorers - 1e-9);
        expect(Number(gap) - (bar.avgAtLeast - t.sum / t.scorers)).toBeLessThan(0.1);
      }),
    );
  });
});

describe('formatZeroShare', () => {
  it('floors to a whole percent', () => {
    expect(formatZeroShare({ zeros: 1, scorers: 10 })).toBe('10%');
    expect(formatZeroShare({ zeros: 1, scorers: 11 })).toBe('9%');
    // 9.52% fails nothing, so it must not round up to the 10% line.
    expect(formatZeroShare({ zeros: 2, scorers: 21 })).toBe('9%');
    expect(formatZeroShare({ zeros: 2, scorers: 3 })).toBe('66%');
    expect(formatZeroShare({ zeros: 0, scorers: 3 })).toBe('0%');
    expect(formatZeroShare({ zeros: 0, scorers: 0 })).toBe('0%');
  });

  it('shows the line’s share or more exactly when the zeros fail the bar', () => {
    fc.assert(
      fc.property(zeroTotals, fc.constantFrom(CONSENT_FLOOR, HIGH), (t, bar) => {
        const shown = Number(formatZeroShare(t).replace('%', ''));
        const fails = 100 * t.zeros >= bar.zerosUnderPercent * t.scorers;
        expect(shown >= bar.zerosUnderPercent).toBe(fails);
      }),
    );
  });
});

describe('the bar’s lines', () => {
  it('reads each line from the bar it is given', () => {
    expect(formatAverageLine(CONSENT_FLOOR)).toBe('2.0');
    expect(formatZeroLine(CONSENT_FLOOR)).toBe('10%');
    expect(formatAverageLine(HIGH)).toBe('3.0');
    expect(formatZeroLine(HIGH)).toBe('5%');
  });

  it('places the lines and fills as shares of each bar’s width', () => {
    expect(lineShare(CONSENT_FLOOR)).toEqual({ average: 0.5, zeros: 0.1 });
    expect(averageShare({ sum: 6, scorers: 2 })).toBe(0.75);
    expect(averageShare({ sum: 0, scorers: 0 })).toBe(0);
    expect(zeroShare({ zeros: 1, scorers: 4 })).toBe(0.25);
    expect(zeroShare({ zeros: 0, scorers: 0 })).toBe(0);
  });
});

describe('formatDay', () => {
  it('writes a relay minute as a short date in the messages’ locale', () => {
    // 29,375,000 minutes after the epoch is 07:20 UTC on Friday 7 November 2025.
    expect(formatDay(29_375_000, 'UTC')).toBe('Fri 7 Nov');
  });
});
