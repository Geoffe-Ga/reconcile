import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs, seatKey } from '../test/coalitions';
import { authorOf } from '../test/keys';
import type { Motion } from './coalition';
import { motionsFor, resultMismatches, resultsToReport, seatIn } from './crossing';
import { fold } from './fold';
import { DEFAULT_RULES } from './rules';

const R = 29_375_000;
const WEEK = 10_080;

/** Group A (ana, ben) passes its reconcile Proposal for seat A; a coalition of A and B forms; zed moves. */
function scene() {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'ben']);
  const reconcile = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ana', reconcile, 4);
  logs.vote('A', R + 5, 'ben', reconcile, 4);
  const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
  const motion = logs.motion(at, 'zed');
  return { logs, reconcile, motion, at };
}

describe('seatIn', () => {
  it('names the seat a group’s reconcile Proposal holds in the coalition, or none', () => {
    const { logs } = scene();
    const logsNow = foldLogs(logs.logs, R + 100);
    expect(folded(logsNow, 'A').seat).toBe(seatKey('A'));
    expect(seatIn(fold([], null), folded(logsNow, 'coalition').state)).toBeNull();
    expect(seatIn(folded(logsNow, 'A').state, fold([], null))).toBeNull();
  });
});

describe('motionsFor', () => {
  it('gives each motion its seat decides, with the coalition’s place, class, window, deadline and bar', () => {
    const { logs, motion, at } = scene();
    const coalition = fold(logs.logs.coalition ?? [], R + 100);
    const record = logs.logs.coalition?.at(-1);
    expect(motionsFor(coalition, seatKey('A'))).toEqual([
      {
        id: motion,
        coalition: logs.ids.coalition,
        seq: record?.seq,
        received: at,
        class: 'ordinary',
        window: 7,
        deadline: at + WEEK,
        bar: DEFAULT_RULES.bars.ordinary,
      },
    ]);
  });

  it('gives nothing to a seat the coalition doesn’t hold, nor from a group’s own state', () => {
    const { logs } = scene();
    const coalition = fold(logs.logs.coalition ?? [], R + 100);
    const group = fold(logs.logs.A ?? [], R + 100);
    expect(motionsFor(coalition, seatKey('C'))).toEqual([]);
    expect(motionsFor(group, seatKey('A'))).toEqual([]);
    expect(motionsFor(fold([], null), seatKey('A'))).toEqual([]);
  });
});

describe("fold's outside motions", () => {
  const records = () => scene().logs.logs.A ?? [];

  /** A motion of the coalition "c", at relay seq `seq`, for 7 days at `bar`. */
  const motion = (
    id: string,
    seq: number,
    bar: Motion['bar'] = DEFAULT_RULES.bars.ordinary,
  ): Motion => ({
    id,
    coalition: 'c',
    seq,
    received: R + 10 + seq,
    class: 'ordinary',
    window: 7,
    deadline: R + 10 + seq + WEEK,
    bar,
  });

  it('opens each once, in relay seq order, whatever order and repeats it is given in', () => {
    const outside = [motion('m2', 20), motion('m1', 10), motion('m2', 20)];
    const state = fold(records(), R + 100, outside);
    const opened = state.proposals.filter((p) => p.target.kind === 'motion');
    expect(opened.map((p) => p.id)).toEqual(['m1', 'm2']);
    expect(opened[0]).toMatchObject({ title: '', why: '', text: '', atom: '', author: '' });
  });

  it('tallies a motion’s ballots at the bar the coalition set, not the group’s', () => {
    const logs = scene().logs;
    const bar: Motion['bar'] = DEFAULT_RULES.bars.entrenched;
    const entrenched = motion('m', 10, bar);
    for (const [voter, score] of [
      ['ana', 2],
      ['ben', 3],
    ] as const) {
      logs.add('A', R + 30, voter, { type: 'vote', body: { proposal: 'm', scores: { m: score } } });
    }
    const state = fold(logs.logs.A ?? [], R + 100, [entrenched]);
    const opened = state.proposals.find((p) => p.id === 'm');
    expect(opened?.final).toBe(true);
    expect(opened?.outcome).toEqual({ kind: 'fail', bar: DEFAULT_RULES.bars.entrenched });
  });

  it('opens none before the group’s genesis, and none in a coalition’s own log', () => {
    const { logs } = scene();
    const before = fold(logs.logs.A ?? [], R + 100, [motion('early', 0)]);
    expect(before.proposals.some((p) => p.id === 'early')).toBe(false);
    const coalition = fold(logs.logs.coalition ?? [], R + 100, [motion('m', 100)]);
    expect(coalition.proposals.some((p) => p.id === 'm')).toBe(false);
  });

  it('leaves a group with no outside motions exactly as it folds without any', () => {
    expect(fold(records(), R + 100, [])).toEqual(fold(records(), R + 100));
  });
});

describe('resultsToReport', () => {
  it('owes nothing to a declined coalition, to a seat it doesn’t hold, or from a group', () => {
    const { logs, at } = scene();
    const logsNow = foldLogs(logs.logs, R + 100);
    const group = folded(logsNow, 'A').state;
    const coalition = folded(logsNow, 'coalition').state;
    expect(resultsToReport(group, coalition, seatKey('C'))).toEqual([]);
    expect(resultsToReport(group, group, seatKey('A'))).toEqual([]);
    logs.join(at + 2, 'eve', 'A');
    logs.result(at + 3, 'eve', logs.ids.coalition ?? '', 'A', 'fail');
    const declined = foldLogs(logs.logs, R + 100);
    const after = folded(declined, 'coalition').state;
    expect(after.coalition?.status).toBe('declined');
    expect(resultsToReport(folded(declined, 'A').state, after, seatKey('A'))).toEqual([]);
  });

  it('carries only the motion, the seat and the result, never a group key or name', () => {
    const { logs, motion } = scene();
    logs.vote('A', R + 200, 'ana', motion, 0, 'Not like this.');
    logs.vote('A', R + 201, 'ben', motion, 1);
    const logsNow = foldLogs(logs.logs, R + 300);
    const group = folded(logsNow, 'A').state;
    const report = resultsToReport(group, folded(logsNow, 'coalition').state, seatKey('A'));
    expect(report).toEqual([{ motion, seat: seatKey('A'), result: 'fail' }]);
    const text = JSON.stringify(report);
    for (const secret of [authorOf('ana'), authorOf('ben'), 'Riverside', 'Not like this.']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('resultMismatches', () => {
  it('lists nothing recorded for other seats, nor a result the group hasn’t decided yet', () => {
    const { logs, motion, at } = scene();
    logs.result(at + 1, 'zed', motion, 'B', 'fail');
    logs.result(at + 2, 'kim', motion, 'A', 'pass');
    const logsNow = foldLogs(logs.logs, R + 100);
    const group = folded(logsNow, 'A').state;
    const coalition = folded(logsNow, 'coalition').state;
    expect(resultMismatches(group, coalition, seatKey('A'))).toEqual([]);
    expect(resultMismatches(group, fold([], null), seatKey('A'))).toEqual([]);
  });
});
