/**
 * A coalition seated above refuses an admission that would raise its own
 * level (#549; ADR-0036's 2026-11-21 amendment, answering #545's question 1),
 * at the open and again when the pass becomes final.
 */
import { describe, expect, it } from 'vitest';

import { NESTED_STATEMENTS, NestedLogs } from '../test/coalitions';
import { HORIZON_STEP_MINUTES } from './coalition';
import { refusedBy, seatAbove } from './crossing';
import { fold, type GroupState } from './fold';
import { DEFAULT_RULES, defaultWindowMinutes } from './rules';

const R = 29_375_000;
const WINDOW = defaultWindowMinutes(DEFAULT_RULES, 'ordinary');

/** Eastside Housing, a coalition asking in, at level 1. */
const COALITION_SEAT = { seat: 'X', name: 'Eastside Housing', level: 1 } as const;

/** Elm Row, a group asking in, at level 0. */
const GROUP_SEAT = { seat: 'G', name: 'Elm Row' } as const;

/** C: seats A (cal) and B (dee), formed at level 1. Returns the minute after it formed. */
function formedC(logs: NestedLogs): number {
  return logs.formedIn('C', R, [['A'], ['B']], ['cal', 'dee'], NESTED_STATEMENTS.C);
}

/** C's motion to take a seat in D, each of its seats reporting `result` on it, or none. */
function intoD(logs: NestedLogs, at: number, result: 'pass' | 'fail' | null): string {
  const motion = logs.sealedInto('C', at, 'cal', 'D', NESTED_STATEMENTS.D);
  if (result !== null) {
    logs.resultIn('C', at + 1, 'cal', motion, 'A', result);
    logs.resultIn('C', at + 1, 'dee', motion, 'B', result);
  }
  return motion;
}

/** Both of C's seats pass `motion`. */
function passBoth(logs: NestedLogs, at: number, motion: string): void {
  logs.resultIn('C', at, 'cal', motion, 'A', 'pass');
  logs.resultIn('C', at, 'dee', motion, 'B', 'pass');
}

/** C's log folded at `relayNow`. */
function foldC(logs: NestedLogs, relayNow: number): GroupState {
  return fold(logs.logs.C ?? [], relayNow);
}

/** The horizon of a level-1 motion received at `at`: its deadline plus a day. */
const horizonFrom = (at: number) => at + WINDOW + HORIZON_STEP_MINUTES;

describe('an admission into a coalition seated above (#549)', () => {
  it('ignores an admit that would raise C’s level while its motion to take a seat above is open', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    const into = intoD(logs, at, null);
    const admit = logs.admitIn('C', at + 5, 'fay', COALITION_SEAT);
    const state = foldC(logs, at + 10);
    expect(state.proposals.map((p) => p.id)).toEqual([into]);
    expect(state.coalition?.motions.map((m) => m.id)).toEqual([into]);
    expect(state.ignored.map((r) => r.id)).toContain(admit);
  });

  it('ignores it once C’s seat above has passed', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    intoD(logs, at, 'pass');
    const admit = logs.admitIn('C', at + 5, 'fay', COALITION_SEAT);
    const state = foldC(logs, horizonFrom(at + 5) + 10);
    expect(state.proposals.some((p) => p.id === admit)).toBe(false);
    expect(state.coalition).toMatchObject({ level: 1, admitted: [] });
  });

  it('takes it once C’s motion above has failed, since C sits nowhere above', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    intoD(logs, at, 'fail');
    const admit = logs.admitIn('C', at + 5, 'fay', COALITION_SEAT);
    passBoth(logs, at + 6, admit);
    const state = foldC(logs, horizonFrom(at + 5));
    expect(state.coalition).toMatchObject({ level: 2, admitted: [{ motion: admit }] });
    expect(state.coalition?.refusedAdmits).toEqual([]);
  });

  it('still admits a group while C sits above, since a group raises no level', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    intoD(logs, at, 'pass');
    const admit = logs.admitIn('C', at + 5, 'fay', GROUP_SEAT);
    passBoth(logs, at + 6, admit);
    const state = foldC(logs, horizonFrom(at + 5));
    expect(state.coalition).toMatchObject({ level: 1, admitted: [{ motion: admit }] });
  });

  it('refuses at the final step an admit opened before C’s motion above: it reads as a final fail and seats nobody', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    const admit = logs.admitIn('C', at, 'fay', COALITION_SEAT);
    passBoth(logs, at + 1, admit);
    intoD(logs, at + 5, null);
    const horizon = horizonFrom(at);
    const before = foldC(logs, horizon - 1);
    expect(before.proposals.find((p) => p.id === admit)).toMatchObject({
      final: false,
      outcome: { kind: 'pass' },
    });
    const state = foldC(logs, horizon);
    expect(state.proposals.find((p) => p.id === admit)).toMatchObject({
      final: true,
      outcome: { kind: 'fail' },
    });
    expect(state.coalition).toMatchObject({ level: 1, admitted: [], refusedAdmits: [admit] });
    expect(state.coalition?.seats.map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('seats it at the final step when C’s motion above failed before then', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    const admit = logs.admitIn('C', at, 'fay', COALITION_SEAT);
    passBoth(logs, at + 1, admit);
    intoD(logs, at + 5, 'fail');
    const state = foldC(logs, horizonFrom(at));
    expect(state.proposals.find((p) => p.id === admit)).toMatchObject({
      final: true,
      outcome: { kind: 'pass' },
    });
    expect(state.coalition).toMatchObject({ level: 2, refusedAdmits: [] });
  });

  it('judges the final step by C’s level then, after an earlier admission there', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    const first = logs.admitIn('C', at, 'fay', { seat: 'Y', name: 'Hill Co-op', level: 1 });
    passBoth(logs, at + 1, first);
    const second = logs.admitIn('C', at + 2, 'gus', COALITION_SEAT);
    passBoth(logs, at + 3, second);
    // C's first admission raises it to level 2 before it opens its motion above.
    intoD(logs, horizonFrom(at) + 1, null);
    const state = foldC(logs, horizonFrom(at + 2) + 10);
    // The second admit's seat states level 1, below C's level 2 by then, so it raises nothing.
    expect(state.coalition).toMatchObject({ level: 2, refusedAdmits: [] });
    expect(state.coalition?.admitted.map((a) => a.motion)).toEqual([first, second]);
  });
});

describe('what a screen reads of the refusal (#549)', () => {
  it('names the seat above, as C’s own motion names it, while C sits or is on its way there', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    intoD(logs, at, null);
    const state = foldC(logs, at + 10);
    expect(seatAbove(state)).toMatchObject({ name: NESTED_STATEMENTS.D.name, outcome: 'open' });
    expect(refusedBy(state, { level: 1 })?.name).toBe(NESTED_STATEMENTS.D.name);
    expect(refusedBy(state, { level: 2 })?.name).toBe(NESTED_STATEMENTS.D.name);
    expect(refusedBy(state, {})).toBeUndefined();
  });

  it('names nothing once C’s motion above has failed, or before C has one', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    expect(refusedBy(foldC(logs, at), { level: 1 })).toBeUndefined();
    intoD(logs, at, 'fail');
    const state = foldC(logs, at + 10);
    expect(seatAbove(state)).toBeUndefined();
    expect(refusedBy(state, { level: 1 })).toBeUndefined();
  });

  it('names nothing for a group’s log, which admits no one', () => {
    const logs = new NestedLogs();
    logs.group('A', R, ['ana'], 'Riverside');
    logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', NESTED_STATEMENTS.C);
    const state = fold(logs.logs.A ?? [], R + 2);
    expect(seatAbove(state)).toBeDefined();
    expect(refusedBy(state, { level: 1 })).toBeUndefined();
  });

  it('agrees with the fold: a seat it names is one the fold ignores', () => {
    const logs = new NestedLogs();
    const at = formedC(logs);
    intoD(logs, at, 'pass');
    const before = foldC(logs, at + 4);
    const admit = logs.admitIn('C', at + 5, 'fay', COALITION_SEAT);
    expect(refusedBy(before, COALITION_SEAT)).toBeDefined();
    expect(foldC(logs, at + 10).proposals.some((p) => p.id === admit)).toBe(false);
  });
});

describe('the route instead (#549)', () => {
  it('lets a level-1 coalition ask into the level-2 coalition above directly, which takes it without rising, even while it sits above in turn', () => {
    const logs = new NestedLogs();
    const at = logs.formedIn('D', R, [['C', 1], ['E']], ['fay', 'hal'], NESTED_STATEMENTS.D);
    // D sits above in turn, on its way into State Renters.
    logs.sealedInto('D', at, 'fay', 'F', NESTED_STATEMENTS.F);
    const admit = logs.admitIn('D', at + 1, 'pia', COALITION_SEAT);
    logs.resultIn('D', at + 2, 'fay', admit, 'C', 'pass');
    logs.resultIn('D', at + 2, 'hal', admit, 'E', 'pass');
    const state = fold(logs.logs.D ?? [], at + 1 + WINDOW + 2 * HORIZON_STEP_MINUTES);
    expect(state.coalition).toMatchObject({
      level: 2,
      admitted: [{ motion: admit }],
      refusedAdmits: [],
    });
  });
});
