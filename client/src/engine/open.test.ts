import { describe, expect, it } from 'vitest';

import { isOpenAt } from './open';

describe('isOpenAt (#289)', () => {
  const deadline = 29_385_090;

  it('is open from its receipt until the minute before its deadline', () => {
    expect(isOpenAt({ deadline, closedAt: null }, deadline - 10_080)).toBe(true);
    expect(isOpenAt({ deadline, closedAt: null }, deadline - 1)).toBe(true);
  });

  it('is closed from its deadline on', () => {
    expect(isOpenAt({ deadline, closedAt: null }, deadline)).toBe(false);
    expect(isOpenAt({ deadline, closedAt: null }, deadline + 1)).toBe(false);
  });

  it('is closed once the fold has reached its early close, whatever the minute', () => {
    expect(isOpenAt({ deadline, closedAt: deadline - 100 }, deadline - 100)).toBe(false);
    expect(isOpenAt({ deadline, closedAt: deadline - 100 }, deadline - 50)).toBe(false);
    expect(isOpenAt({ deadline, closedAt: deadline - 100 }, deadline - 200)).toBe(false);
  });
});
