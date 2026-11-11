import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { foldLogs, folded, Logs, seatKey } from '../test/coalitions';
import { coalitionOutcome, RESULT_GRACE_MINUTES } from './coalition';
import { coalitionProgress, motionDecidedAt, passesNeeded } from './coalitionProgress';
import type { GroupResultValue } from './event';
import { fold, type GroupState } from './fold';
import { DAY_MINUTES, DEFAULT_RULES } from './rules';

/** Six member groups, in seat order, and the participant who reports for each. */
const SEATS = [
  'Riverside Tenants',
  'Oak St Co-op',
  'Elm Row',
  'Hill Co-op',
  'Pine Row',
  'Mill Lane',
];
const PEOPLE = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay'];

/** A motion's window: the ordinary default, in relay minutes. */
const WINDOW = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES;

/** One seat's report on the motion, or none, or a contest: both a pass and a fail. */
type Report = GroupResultValue | 'none' | 'contest';

/**
 * A formed coalition of the first `size` seats, a motion by its first
 * participant, then each seat's report in seat order, folded at `relayNow`
 * minutes after the motion (default: just after the last report).
 */
function coalitionWith(size: number, reports: readonly Report[], after?: number) {
  const logs = new Logs();
  const seats = SEATS.slice(0, size);
  const start = logs.formed(1, seats, PEOPLE.slice(0, size));
  const motion = logs.motion(start, PEOPLE[0] ?? '');
  let at = start;
  reports.forEach((report, i) => {
    const who = PEOPLE[i] ?? '';
    const seat = seats[i] ?? '';
    if (report === 'none') return;
    if (report === 'contest') {
      logs.result((at += 1), who, motion, seat, 'pass');
      logs.result((at += 1), who, motion, seat, 'fail');
      return;
    }
    logs.result((at += 1), who, motion, seat, report);
  });
  const now = after === undefined ? at + 1 : start + after;
  const state = folded(foldLogs(logs.logs, now), 'coalition').state;
  return { state, motion, deadline: start + WINDOW };
}

/** The progress of the one motion in `state`, as the seat `mine` (by name) reads it, if any. */
function progressOf(state: GroupState, motion: string, mine?: string) {
  const progress = coalitionProgress(state, motion, mine === undefined ? undefined : seatKey(mine));
  if (progress === null) throw new Error('Expected the motion’s progress.');
  return progress;
}

describe('passesNeeded', () => {
  it('is the fewest passes coalitionOutcome passes on, at any size, with or without every seat', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 40 }), fc.boolean(), (seats, everySeat) => {
        const needed = passesNeeded(seats, everySeat);
        const at = (passes: number) =>
          coalitionOutcome({ seats, passes, fails: 0, expired: false, everySeat }).kind;
        expect(at(needed)).toBe('pass');
        expect(at(needed - 1)).toBe('open');
      }),
    );
    expect([2, 3, 4, 5, 6, 7, 9].map((n) => passesNeeded(n, false))).toEqual([2, 3, 4, 4, 4, 5, 6]);
  });
});

describe('coalitionProgress', () => {
  it('reads the issue’s example: two of three passed, and the third still deciding', () => {
    const { state, motion } = coalitionWith(3, ['pass', 'none', 'pass']);

    expect(progressOf(state, motion, 'Riverside Tenants')).toEqual({
      seats: 3,
      passed: 2,
      failed: 0,
      needed: 3,
      deciding: ['Oak St Co-op'],
      mine: 'pass',
      groups: [
        { name: 'Riverside Tenants', result: 'pass' },
        { name: 'Oak St Co-op', result: null },
        { name: 'Elm Row', result: 'pass' },
      ],
      final: false,
      settles: expect.any(Number) as number,
    });
  });

  it('reads two groups at every stage: open, one in, passed, final, and failed', () => {
    const open = coalitionWith(2, []);
    const opened = progressOf(open.state, open.motion);
    expect(opened).toMatchObject({ seats: 2, passed: 0, failed: 0, needed: 2, final: false });
    expect(opened.deciding).toEqual(['Riverside Tenants', 'Oak St Co-op']);
    expect(opened.mine).toBeUndefined();
    expect(opened.outcome).toBeUndefined();
    expect(opened.settles).toBe(open.deadline + RESULT_GRACE_MINUTES);

    const one = coalitionWith(2, ['pass']);
    expect(progressOf(one.state, one.motion, 'Riverside Tenants')).toMatchObject({
      passed: 1,
      deciding: ['Oak St Co-op'],
      mine: 'pass',
    });
    expect(progressOf(one.state, one.motion, 'Oak St Co-op').mine).toBeUndefined();

    const both = coalitionWith(2, ['pass', 'pass']);
    const passed = progressOf(both.state, both.motion);
    expect(passed).toMatchObject({ passed: 2, deciding: [], outcome: 'pass', final: false });

    const final = coalitionWith(2, ['pass', 'pass'], WINDOW + RESULT_GRACE_MINUTES);
    expect(progressOf(final.state, final.motion)).toMatchObject({ outcome: 'pass', final: true });

    const failed = coalitionWith(2, ['pass', 'fail']);
    expect(progressOf(failed.state, failed.motion, 'Oak St Co-op')).toMatchObject({
      passed: 1,
      failed: 1,
      mine: 'fail',
      outcome: 'fail',
      final: true,
    });
  });

  it('turns a pass final only once results stop counting, a minute at a time', () => {
    const before = coalitionWith(2, ['pass', 'pass'], WINDOW + RESULT_GRACE_MINUTES - 1);
    expect(progressOf(before.state, before.motion).final).toBe(false);
    const at = coalitionWith(2, ['pass', 'pass'], WINDOW + RESULT_GRACE_MINUTES);
    expect(progressOf(at.state, at.motion).final).toBe(true);
  });

  it('reads three groups at every stage', () => {
    const stages: [Report[], Partial<ReturnType<typeof progressOf>>][] = [
      [[], { passed: 0, failed: 0, deciding: SEATS.slice(0, 3) }],
      [['pass'], { passed: 1, deciding: ['Oak St Co-op', 'Elm Row'] }],
      [['pass', 'pass'], { passed: 2, deciding: ['Elm Row'] }],
      [['pass', 'pass', 'pass'], { passed: 3, deciding: [], outcome: 'pass' }],
      [['pass', 'fail'], { passed: 1, failed: 1, deciding: ['Elm Row'], outcome: 'fail' }],
    ];
    for (const [reports, expected] of stages) {
      const { state, motion } = coalitionWith(3, reports);
      const progress = progressOf(state, motion);
      expect(progress).toMatchObject({ seats: 3, needed: 3, ...expected });
      if (expected.outcome === undefined) expect(progress.outcome).toBeUndefined();
    }
  });

  it('needs two-thirds from five groups: 4 of 5, and a second fail fails it', () => {
    const stages: [Report[], Partial<ReturnType<typeof progressOf>>][] = [
      [[], { passed: 0, failed: 0 }],
      [['pass', 'pass', 'pass', 'fail'], { passed: 3, failed: 1, deciding: ['Pine Row'] }],
      [['pass', 'pass', 'pass', 'fail', 'pass'], { passed: 4, failed: 1, outcome: 'pass' }],
      [['pass', 'pass', 'pass', 'pass'], { passed: 4, deciding: ['Pine Row'], outcome: 'pass' }],
      [['fail', 'none', 'fail'], { passed: 0, failed: 2, outcome: 'fail' }],
    ];
    for (const [reports, expected] of stages) {
      const { state, motion } = coalitionWith(5, reports);
      const progress = progressOf(state, motion);
      expect(progress).toMatchObject({ seats: 5, needed: 4, ...expected });
      if (expected.outcome === undefined) expect(progress.outcome).toBeUndefined();
    }
  });

  it('counts a missing group as a fail once results stop counting', () => {
    const { state, motion } = coalitionWith(
      5,
      ['pass', 'pass', 'pass'],
      WINDOW + RESULT_GRACE_MINUTES,
    );
    expect(progressOf(state, motion)).toMatchObject({
      passed: 3,
      failed: 0,
      deciding: ['Hill Co-op', 'Pine Row'],
      outcome: 'fail',
      final: true,
    });
  });

  it('counts a contested group once, as a fail', () => {
    const { state, motion } = coalitionWith(5, ['contest', 'pass']);
    expect(progressOf(state, motion, 'Riverside Tenants')).toMatchObject({
      passed: 1,
      failed: 1,
      mine: 'fail',
      groups: expect.arrayContaining([{ name: 'Riverside Tenants', result: 'fail' }]) as unknown,
    });
  });

  it('needs every group to admit one, however many there are (#114)', () => {
    const logs = new Logs();
    const seats = SEATS.slice(0, 5);
    const start = logs.formed(1, seats, PEOPLE.slice(0, 5));
    const motion = logs.admit(start, 'gus', 'Mill Lane', 'Mill Lane');
    logs.result(start + 1, 'ana', motion, 'Riverside Tenants', 'pass');
    const { state } = folded(foldLogs(logs.logs, start + 2), 'coalition');

    expect(progressOf(state, motion)).toMatchObject({ seats: 5, needed: 5, passed: 1 });
  });

  it('is null for a motion the coalition doesn’t hold, and for a group’s own state', () => {
    const { state } = coalitionWith(2, []);
    expect(coalitionProgress(state, 'nope')).toBeNull();
    const logs = new Logs();
    logs.group('A', 1, ['ana']);
    const { state: group } = folded(foldLogs(logs.logs, 2), 'A');
    expect(coalitionProgress(group, 'nope')).toBeNull();
  });

  it('decides as coalitionOutcome does, whatever each group reports and whenever it’s read', () => {
    const report = fc.constantFrom<Report>('pass', 'fail', 'none', 'contest');
    const runs = fc
      .integer({ min: 2, max: 6 })
      .chain((size) =>
        fc.tuple(
          fc.constant(size),
          fc.array(report, { minLength: size, maxLength: size }),
          fc.boolean(),
        ),
      );
    fc.assert(
      fc.property(runs, ([size, reports, late]) => {
        const after = late ? WINDOW + RESULT_GRACE_MINUTES : undefined;
        const { state, motion } = coalitionWith(size, reports, after);
        const progress = progressOf(state, motion);
        const fails = reports.filter((r) => r === 'fail' || r === 'contest').length;
        const passes = reports.filter((r) => r === 'pass').length;
        const { kind } = coalitionOutcome({ seats: size, passes, fails, expired: late });
        expect(progress.outcome ?? 'open').toBe(kind);
        expect(progress.passed).toBe(passes);
        expect(progress.failed).toBe(fails);
        expect(progress.passed + progress.failed + progress.deciding.length).toBe(size);
      }),
      { numRuns: 40 },
    );
  }, 30_000);

  it('only moves forward as distinct groups report, in any order', () => {
    const runs = fc.integer({ min: 2, max: 6 }).chain((size) =>
      fc.tuple(
        fc.shuffledSubarray([...Array(size).keys()], { minLength: size, maxLength: size }),
        fc.array(fc.constantFrom<GroupResultValue>('pass', 'fail'), {
          minLength: size,
          maxLength: size,
        }),
      ),
    );
    fc.assert(
      fc.property(runs, ([order, results]) => {
        const size = order.length;
        let before = progressOf(...steps(size, []));
        for (let n = 1; n <= size; n += 1) {
          const reports = Array.from({ length: size }, (_, seat): Report => {
            const place = order.indexOf(seat);
            return place < n ? (results[seat] ?? 'pass') : 'none';
          });
          const after = progressOf(...steps(size, reports));
          expect(after.passed + after.failed).toBe(before.passed + before.failed + 1);
          expect(after.deciding.length).toBe(before.deciding.length - 1);
          if (before.outcome !== undefined) expect(after.outcome).toBe(before.outcome);
          before = after;
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);
});

describe('motionDecidedAt', () => {
  it('dates a pass when it became final, its deadline plus 10,080 minutes', () => {
    const { state, motion, deadline } = coalitionWith(
      2,
      ['pass', 'pass'],
      WINDOW + RESULT_GRACE_MINUTES,
    );
    expect(motionDecidedAt(state, motion)).toBe(deadline + RESULT_GRACE_MINUTES);
  });

  it('dates a fail by the receipt of the result that failed it, not a later one', () => {
    const logs = new Logs();
    const start = logs.formed(1, SEATS.slice(0, 3), PEOPLE.slice(0, 3));
    const motion = logs.motion(start, 'ana');
    logs.result(start + 5, 'ana', motion, 'Riverside Tenants', 'pass');
    logs.result(start + 9, 'ben', motion, 'Oak St Co-op', 'fail');
    logs.result(start + 12, 'cy', motion, 'Elm Row', 'fail');
    const { state } = folded(foldLogs(logs.logs, start + 20), 'coalition');
    expect(motionDecidedAt(state, motion)).toBe(start + 9);
  });

  it('dates a fail from 5 groups by the result that left too few to pass', () => {
    // Each report lands a minute after the last, from the motion's minute on.
    const { state, motion, deadline } = coalitionWith(5, ['fail', 'pass', 'fail', 'pass', 'pass']);
    // Two fails of five leave three, short of two-thirds: the second fail, the third report, decides it.
    expect(motionDecidedAt(state, motion)).toBe(deadline - WINDOW + 3);
  });

  it('dates a fail by expiry, with results missing, when results stopped counting', () => {
    const { state, motion, deadline } = coalitionWith(
      2,
      ['pass', 'none'],
      WINDOW + RESULT_GRACE_MINUTES,
    );
    expect(progressOf(state, motion).outcome).toBe('fail');
    expect(motionDecidedAt(state, motion)).toBe(deadline + RESULT_GRACE_MINUTES);
  });

  it('is null for a motion the coalition doesn’t hold, and for a group’s own state', () => {
    const { state } = coalitionWith(2, []);
    expect(motionDecidedAt(state, 'nope')).toBeNull();
    expect(motionDecidedAt(fold([], null), 'nope')).toBeNull();
  });
});

/** {@link progressOf}'s first two arguments for a coalition of `size` with `reports`. */
function steps(size: number, reports: readonly Report[]): [GroupState, string] {
  const { state, motion } = coalitionWith(size, reports);
  return [state, motion];
}
