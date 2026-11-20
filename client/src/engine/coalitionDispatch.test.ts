/**
 * A coalition's Dispatches (#124; ADR-0075 §1): they ride only on a passed
 * motion, and go out only once that pass is final, at its horizon, deadline + 1,440 at level 1 (#387),
 * whatever order the seats' results arrive in. The golden vectors in
 * `vectors/follow-dispatch.json` pin the exact cases; this checks the rule
 * over every order and every relay minute around the edge.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs } from '../test/coalitions';
import { HORIZON_STEP_MINUTES } from './coalition';
import { DAY_MINUTES, DEFAULT_RULES } from './rules';

const SEATS = ['A', 'B', 'C', 'D'] as const;
const PEOPLE = ['kim', 'zed', 'eve', 'fay'] as const;
const DISPATCH = { title: 'Banks too', text: 'The coalition keeps the banks clean as well.' };

/** What each seat reports on the motion: a pass, a fail, both (a contest), or nothing. */
const report = fc.constantFrom('pass', 'fail', 'contest', 'none');

/** A formed coalition of `size` seats with one motion carrying a Dispatch, results posted in `order`. */
function coalitionWith(size: number, reports: readonly string[], order: readonly number[]) {
  const logs = new Logs();
  const seats = SEATS.slice(0, size);
  const people = PEOPLE.slice(0, size);
  const opened = logs.formed(29_375_010, seats, people);
  const motion = logs.motion(opened, 'kim', undefined, DISPATCH);
  let at = opened + 1;
  for (const i of order) {
    const seat = seats[i] ?? 'A';
    const who = people[i] ?? 'kim';
    const value = reports[i];
    if (value === 'pass' || value === 'contest') logs.result((at += 1), who, motion, seat, 'pass');
    if (value === 'fail' || value === 'contest') logs.result((at += 1), who, motion, seat, 'fail');
  }
  const settles =
    opened + DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + HORIZON_STEP_MINUTES;
  return { logs, motion, settles };
}

const scenario = fc.integer({ min: 2, max: 4 }).chain((size) =>
  fc.record({
    size: fc.constant(size),
    reports: fc.array(report, { minLength: size, maxLength: size }),
    order: fc.shuffledSubarray([...Array(size).keys()], { minLength: size, maxLength: size }),
    offset: fc.integer({ min: -3, max: 3 }),
  }),
);

/**
 * The property's budget. Each of fast-check's 100 runs signs and then folds
 * a whole coalition, 6 to 18 events by its seats and their reports: about
 * 15 ms a run on average, and 22 ms at four seats that all pass (13 ms to
 * sign, 9 ms to fold). That's 1.4–1.6 s alone, 3.2 s in two concurrent
 * runs, and 7.3–8.2 s in four at load 11; the gate at load 15 cut it off at
 * Vitest's default 5 s. 30 s leaves room for that without hiding a hang, and
 * every one of the 100 runs still counts.
 */
const PROPERTY_BUDGET = { timeout: 30_000 };

describe('a coalition’s Dispatch (#124)', () => {
  it(
    'goes out once every seat’s pass is final, in that minute, and never otherwise',
    PROPERTY_BUDGET,
    () => {
      fc.assert(
        fc.property(scenario, ({ size, reports, order, offset }) => {
          const { logs, motion, settles } = coalitionWith(size, reports, order);
          const { state } = folded(foldLogs(logs.logs, settles + offset), 'coalition');
          const everySeatPassed = reports.every((value) => value === 'pass');
          const out = everySeatPassed && offset >= 0;
          expect(state.dispatches).toEqual(
            out
              ? [
                  {
                    id: motion,
                    by: { proposal: motion },
                    ...DISPATCH,
                    doc: state.group,
                    received: settles,
                  },
                ]
              : [],
          );
        }),
      );
    },
  );

  it('never reaches a member group, whose own Proposal for the motion carries none', () => {
    const logs = new Logs();
    logs.group('A', 29_375_000, ['ana', 'ben']);
    const reconcile = logs.reconcile('A', 29_375_003, 'ana', 'A');
    logs.vote('A', 29_375_004, 'ana', reconcile, 4);
    logs.vote('A', 29_375_005, 'ben', reconcile, 4);
    const opened = logs.formed(29_375_010, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(opened, 'kim', undefined, DISPATCH);
    logs.vote('A', opened + 1, 'ana', motion, 4);
    logs.vote('A', opened + 2, 'ben', motion, 4);
    logs.result(opened + 3, 'kim', motion, 'A', 'pass');
    logs.result(opened + 4, 'zed', motion, 'B', 'pass');
    const settles = opened + 7 * DAY_MINUTES + HORIZON_STEP_MINUTES;
    const all = foldLogs(logs.logs, settles);
    expect(folded(all, 'coalition').state.dispatches.map((d) => d.id)).toEqual([motion]);
    const group = folded(all, 'A').state;
    expect(group.proposals.find((p) => p.id === motion)?.dispatch).toBeNull();
    expect(group.dispatches).toEqual([]);
  });
});
