import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CoalitionGenesisBody } from './event';
import {
  coalitionOutcome,
  HORIZON_STEP_MINUTES,
  horizonOf,
  type MotionSeats,
  motionHorizon,
  newCoalition,
  raisesLevel,
  resultsCount,
} from './coalition';
import { DEFAULT_RULES } from './rules';

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
});

/** A motion's snapshot at `level`, deciding nothing, for the horizon's rules alone. */
function snapshot(id: string, deadline: number, level: number): MotionSeats {
  return { id, deadline, level, seats: [], admit: null };
}

describe('horizons (#250, #387)', () => {
  const D = 29_385_100;

  it('steps one day per level: g is 1,440 minutes', () => {
    expect(HORIZON_STEP_MINUTES).toBe(1_440);
  });

  it('puts a level-k motion’s horizon at its deadline plus k days', () => {
    expect(horizonOf({ deadline: D, level: 0 })).toBe(D);
    expect(horizonOf({ deadline: D, level: 1 })).toBe(D + 1_440);
    expect(horizonOf({ deadline: D, level: 2 })).toBe(D + 2_880);
    expect(horizonOf({ deadline: D, level: 3 })).toBe(D + 4_320);
  });

  it('reads a motion’s level from its snapshot, which a later admission doesn’t move', () => {
    const coalition = { level: 2, motions: [snapshot('m', D, 1)] };
    expect(motionHorizon(coalition, { id: 'm', deadline: D })).toBe(D + 1_440);
  });

  it('takes the coalition’s level for a motion with no snapshot, and a group’s deadline as its own', () => {
    expect(motionHorizon({ level: 3, motions: [] }, { id: 'x', deadline: D })).toBe(D + 4_320);
    expect(motionHorizon(null, { id: 'x', deadline: D })).toBe(D);
  });

  it('counts results until the minute before each level’s horizon, and not at it', () => {
    for (const level of [1, 2, 3]) {
      const coalition = { formsFinal: 0, motions: [snapshot('m', D, level)] };
      const horizon = D + level * 1_440;
      expect(resultsCount(coalition, 'g', 'm', horizon - 1)).toBe(true);
      expect(resultsCount(coalition, 'g', 'm', horizon)).toBe(false);
    }
  });

  it('makes a formation final 14 days plus a day per level after its genesis', () => {
    const seat = (key: string, level?: number) => ({ name: key, key, ...(level ? { level } : {}) });
    const body = (seats: CoalitionGenesisBody['seats']): CoalitionGenesisBody => ({
      kind: 'coalition',
      name: 'C',
      seats,
      documents: [{ title: 'Mission statement', atoms: ['We share.'] }],
    });
    const one = newCoalition(body([seat('a'), seat('b')]), DEFAULT_RULES, 1_000);
    const two = newCoalition(body([seat('a', 1), seat('b')]), DEFAULT_RULES, 1_000);
    expect(one?.formsFinal).toBe(1_000 + 14 * 1_440 + 1_440);
    expect(two?.formsFinal).toBe(1_000 + 14 * 1_440 + 2_880);
    expect(resultsCount({ formsFinal: 5, motions: [] }, 'g', 'g', 4)).toBe(true);
    expect(resultsCount({ formsFinal: 5, motions: [] }, 'g', 'g', 5)).toBe(false);
  });
});

describe('raising a seated coalition’s level (#549)', () => {
  const seat = (key: string, level?: number) => ({ name: key, key, ...(level ? { level } : {}) });

  it('raises a coalition’s level only with a seat at or above it', () => {
    const one = { level: 1, seats: [seat('a'), seat('b')] };
    expect(raisesLevel(one, seat('c'))).toBe(false);
    expect(raisesLevel(one, seat('c', 1))).toBe(true);
    expect(raisesLevel(one, seat('c', 2))).toBe(true);
    const two = { level: 2, seats: [seat('a', 1), seat('b')] };
    expect(raisesLevel(two, seat('c'))).toBe(false);
    expect(raisesLevel(two, seat('c', 1))).toBe(false);
    expect(raisesLevel(two, seat('c', 2))).toBe(true);
  });

  it('agrees with levelOf for every seat level and coalition', () => {
    const levels = fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 2, maxLength: 5 });
    fc.assert(
      fc.property(levels, fc.integer({ min: 0, max: 2 }), (stated, added) => {
        const seats = stated.map((level, i) => seat(String(i), level));
        const level = 1 + Math.max(...stated);
        expect(raisesLevel({ level, seats }, seat('new', added))).toBe(added >= level);
      }),
    );
  });
});
