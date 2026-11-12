import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { coalitionOutcome, RESULT_GRACE_MINUTES, settlesAt } from './coalition';

describe('coalitionOutcome', () => {
  it('reads the issue’s examples', () => {
    expect(coalitionOutcome({ seats: 6, passes: 4, fails: 1, expired: false })).toEqual({
      kind: 'pass',
    });
    expect(coalitionOutcome({ seats: 5, passes: 3, fails: 0, expired: false })).toEqual({
      kind: 'open',
    });
    expect(coalitionOutcome({ seats: 5, passes: 3, fails: 0, expired: true })).toEqual({
      kind: 'fail',
    });
  });

  it('needs every seat up to 4, and fails at the first fail', () => {
    expect(coalitionOutcome({ seats: 2, passes: 2, fails: 0, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 2, passes: 1, fails: 0, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 2, passes: 1, fails: 1, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 4, passes: 4, fails: 0, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 4, passes: 3, fails: 1, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 4, passes: 3, fails: 0, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 4, passes: 0, fails: 1, expired: false }).kind).toBe('fail');
  });

  it('needs two-thirds from 5 seats: 3·passes ≥ 2·N passes, 3·(N − fails) < 2·N fails', () => {
    expect(coalitionOutcome({ seats: 5, passes: 4, fails: 0, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 5, passes: 4, fails: 1, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 5, passes: 0, fails: 1, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 5, passes: 3, fails: 1, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 5, passes: 0, fails: 2, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 6, passes: 3, fails: 0, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 6, passes: 4, fails: 0, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 6, passes: 0, fails: 2, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 6, passes: 0, fails: 3, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 7, passes: 5, fails: 0, expired: false }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 7, passes: 4, fails: 0, expired: false }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 7, passes: 0, fails: 3, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 7, passes: 0, fails: 2, expired: false }).kind).toBe('open');
  });

  it('counts every missing result as a fail once it has expired', () => {
    expect(coalitionOutcome({ seats: 2, passes: 1, fails: 0, expired: true }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 2, passes: 2, fails: 0, expired: true }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 6, passes: 4, fails: 0, expired: true }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 6, passes: 3, fails: 0, expired: true }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 5, passes: 0, fails: 0, expired: true }).kind).toBe('fail');
  });

  it('lets a fail win if the counts ever say both, which distinct seats never do', () => {
    expect(coalitionOutcome({ seats: 2, passes: 2, fails: 1, expired: false }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 5, passes: 5, fails: 3, expired: false }).kind).toBe('fail');
  });

  it('is never open once expired, and a fail never turns into a pass with more results', () => {
    const counts = fc.integer({ min: 2, max: 12 }).chain((seats) =>
      fc
        .tuple(fc.nat({ max: seats }), fc.nat({ max: seats }))
        .filter(([passes, fails]) => passes + fails <= seats)
        .map(([passes, fails]) => ({ seats, passes, fails })),
    );
    fc.assert(
      fc.property(counts, ({ seats, passes, fails }) => {
        expect(coalitionOutcome({ seats, passes, fails, expired: true }).kind).not.toBe('open');
        if (coalitionOutcome({ seats, passes, fails, expired: false }).kind !== 'fail') return;
        for (let more = 0; passes + fails + more <= seats; more += 1) {
          const later = { seats, passes: passes + more, fails, expired: false };
          expect(coalitionOutcome(later).kind).toBe('fail');
        }
      }),
    );
  });

  it('needs every seat for a motion that admits a group, however many seats (#114)', () => {
    const every = { expired: false, everySeat: true };
    expect(coalitionOutcome({ seats: 5, passes: 4, fails: 1, ...every }).kind).toBe('fail');
    expect(coalitionOutcome({ seats: 5, passes: 4, fails: 0, ...every }).kind).toBe('open');
    expect(coalitionOutcome({ seats: 5, passes: 5, fails: 0, ...every }).kind).toBe('pass');
    expect(coalitionOutcome({ seats: 2, passes: 2, fails: 0, ...every }).kind).toBe('pass');
    expect(
      coalitionOutcome({ seats: 6, passes: 5, fails: 0, everySeat: true, expired: true }).kind,
    ).toBe('fail');
  });

  it('decides a motion that needs every seat as unanimity does at any size (#114)', () => {
    const counts = fc.integer({ min: 2, max: 12 }).chain((seats) =>
      fc
        .tuple(fc.nat({ max: seats }), fc.nat({ max: seats }), fc.boolean())
        .filter(([passes, fails]) => passes + fails <= seats)
        .map(([passes, fails, expired]) => ({ seats, passes, fails, expired })),
    );
    fc.assert(
      fc.property(counts, ({ seats, passes, fails, expired }) => {
        const missing = expired ? seats - passes - fails : 0;
        const unanimous = fails + missing > 0 ? 'fail' : passes === seats ? 'pass' : 'open';
        expect(coalitionOutcome({ seats, passes, fails, expired, everySeat: true }).kind).toBe(
          unanimous,
        );
      }),
    );
  });

  it('gives results a week past the deadline', () => {
    expect(RESULT_GRACE_MINUTES).toBe(10_080);
  });

  it('settles a motion, and any Dispatch it carries, a week past its deadline (#124)', () => {
    expect(settlesAt({ deadline: 29_385_100 })).toBe(29_395_180);
  });
});
