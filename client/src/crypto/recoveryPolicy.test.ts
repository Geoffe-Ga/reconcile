import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_THRESHOLDS,
  DEFAULT,
  isAllowedThreshold,
  MAX_CONTACTS,
  MAX_NEEDED,
  MIN_CONTACTS,
  MIN_NEEDED,
} from './recoveryPolicy';

/** Every pair from 2 of 3 up to 5 of 7 (ADR-0043 §1), written out by hand: t first, then n. */
const SEVENTEEN = [
  [2, 3],
  [3, 3],
  [2, 4],
  [3, 4],
  [4, 4],
  [2, 5],
  [3, 5],
  [4, 5],
  [5, 5],
  [2, 6],
  [3, 6],
  [4, 6],
  [5, 6],
  [2, 7],
  [3, 7],
  [4, 7],
  [5, 7],
] as const;

describe('recovery thresholds (ADR-0043 §1)', () => {
  it('follows the issue’s examples', () => {
    expect(isAllowedThreshold(3, 5)).toBe(true);
    expect(isAllowedThreshold(1, 3)).toBe(false); // t < 2
    expect(isAllowedThreshold(6, 7)).toBe(false); // t > 5
    expect(isAllowedThreshold(4, 3)).toBe(false); // t > n
  });

  it('allows exactly the 17 pairs from 2 of 3 to 5 of 7', () => {
    const passing: [number, number][] = [];
    for (let n = -1; n <= 12; n += 1) {
      for (let t = -1; t <= 12; t += 1) {
        if (isAllowedThreshold(t, n)) passing.push([t, n]);
      }
    }
    expect(passing.sort(([t1, n1], [t2, n2]) => n1 - n2 || t1 - t2)).toEqual(SEVENTEEN);
    expect(ALLOWED_THRESHOLDS.map(({ t, n }) => [t, n])).toEqual(SEVENTEEN);
  });

  it('names its bounds: 3 to 7 contacts, 2 to 5 needed', () => {
    expect([MIN_CONTACTS, MAX_CONTACTS, MIN_NEEDED, MAX_NEEDED]).toEqual([3, 7, 2, 5]);
  });

  it('defaults to 3 of 5, which it allows', () => {
    expect(DEFAULT).toEqual({ t: 3, n: 5 });
    expect(isAllowedThreshold(DEFAULT.t, DEFAULT.n)).toBe(true);
  });

  it('refuses anything that isn’t a whole number', () => {
    for (const bad of [2.5, Number.NaN, Infinity, -Infinity]) {
      expect(isAllowedThreshold(bad, 5)).toBe(false);
      expect(isAllowedThreshold(3, bad)).toBe(false);
    }
  });

  it('holds t ≤ n, 2 ≤ t ≤ 5 and 3 ≤ n ≤ 7 for every pair it allows', () => {
    fc.assert(
      fc.property(fc.integer({ min: -20, max: 20 }), fc.integer({ min: -20, max: 20 }), (t, n) => {
        const expected = t >= 2 && t <= 5 && n >= 3 && n <= 7 && t <= n;
        expect(isAllowedThreshold(t, n)).toBe(expected);
      }),
    );
  });
});
