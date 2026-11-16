import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs, seatKey } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { dueClaims, mayClaim } from './chatPosts';
import type { Motion } from './coalition';
import { motionsFor, resultMismatches, resultsToReport, seatIn } from './crossing';
import { parseRecord } from './event';
import { fold } from './fold';
import { nudgesFor } from './nudges';
import { DEFAULT_RULES } from './rules';
import { wakeFor } from './wake';

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
        chain: [],
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
    chain: [],
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

  it('opens none before the group’s genesis, nor in a coalition still forming or declined', () => {
    const { logs } = scene();
    const before = fold(logs.logs.A ?? [], R + 100, [motion('early', 0)]);
    expect(before.proposals.some((p) => p.id === 'early')).toBe(false);
    const forming = new Logs();
    forming.coalition(R, ['A', 'B']);
    const notYet = fold(forming.logs.coalition ?? [], R + 100, [motion('m', 100)]);
    expect(notYet.proposals).toEqual([]);
    expect(notYet.coalition?.motions).toEqual([]);
    const declined = new Logs();
    const at = declined.formed(R, ['A', 'B'], ['kim', 'zed']);
    declined.result(at, 'kim', declined.ids.coalition ?? '', 'A', 'fail');
    const over = fold(declined.logs.coalition ?? [], R + 100, [motion('m', 100)]);
    expect(over.coalition?.status).toBe('declined');
    expect(over.proposals).toEqual([]);
  });

  it('opens one in a formed coalition (#122), with no ballots, its seats deciding it from a snapshot', () => {
    const { logs } = scene();
    const coalition = fold(logs.logs.coalition ?? [], R + 100, [motion('m', 100)]);
    const opened = coalition.proposals.find((p) => p.id === 'm');
    expect(opened).toMatchObject({
      number: 0,
      eligible: [],
      target: { kind: 'motion', coalition: 'c', chain: [] },
    });
    expect(coalition.coalition?.motions.at(-1)).toEqual({
      id: 'm',
      deadline: R + 110 + WEEK,
      seats: [seatKey('A'), seatKey('B')],
      admit: null,
    });
    expect(coalition.atoms).toEqual(fold(logs.logs.coalition ?? [], R + 100).atoms);
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

  it('owes nothing for a pass a holder of its seat secret posts while the group still decides: only a coalition withdraws a pass (#375)', () => {
    const { logs, motion, at } = scene();
    logs.join(at + 1, 'eve', 'A');
    logs.result(at + 2, 'eve', motion, 'A', 'pass');
    const logsNow = foldLogs(logs.logs, at + 3);
    const group = folded(logsNow, 'A').state;
    const coalition = folded(logsNow, 'coalition').state;
    expect(coalition.coalition?.results.map((r) => r.result)).toContain('pass');
    expect(resultsToReport(group, coalition, seatKey('A'))).toEqual([]);
    // Once the group decides, its own result answers it.
    logs.vote('A', at + 4, 'ana', motion, 0, 'Not like this.');
    logs.vote('A', at + 5, 'ben', motion, 0, 'Not like this.');
    const decided = foldLogs(logs.logs, at + 6);
    expect(
      resultsToReport(folded(decided, 'A').state, folded(decided, 'coalition').state, seatKey('A')),
    ).toEqual([{ motion, seat: seatKey('A'), result: 'fail' }]);
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

describe('outside motions and push (#99)', () => {
  it('wakes the group for the ballot that closes a motion early, as for any Proposal', () => {
    const { logs, motion } = scene();
    logs.vote('A', R + 200, 'ana', motion, 4);
    const before = folded(foldLogs(logs.logs, R + 201), 'A').state;
    logs.vote('A', R + 201, 'ben', motion, 3);
    const last = parseRecord(logs.logs.A?.at(-1)?.bytes ?? new Uint8Array());
    expect(last === null ? false : wakeFor(before, last.event)).toBe(true);
    const first = parseRecord(logs.logs.A?.at(-2)?.bytes ?? new Uint8Array());
    const opened = folded(
      foldLogs({ ...logs.logs, A: (logs.logs.A ?? []).slice(0, -2) }, R + 199),
      'A',
    );
    expect(first === null ? true : wakeFor(opened.state, first.event)).toBe(false);
  });

  it('schedules no nudges for an outside motion: it has no proposer in the group', () => {
    const { logs, motion } = scene();
    const group = folded(foldLogs(logs.logs, R + 100), 'A').state;
    expect(group.proposals.some((p) => p.id === motion && !p.final)).toBe(true);
    for (const member of ['ana', 'ben']) expect(nudgesFor(group, authorOf(member))).toEqual([]);
  });
});

describe('outside motions beside numbers, the chat bot and Dispatches (#123, #112)', () => {
  /** `who`'s edit of A's first Atom at relay minute `received`. */
  const edit = (logs: Logs, received: number, who: string) =>
    logs.add('A', received, who, {
      type: 'proposal',
      body: { atom: `${logs.ids.A ?? ''}.0`, title: 'Later', why: 'Weekends.', text: 'Midnight.' },
    });

  it('numbers the group’s own Proposals the same with or without its outside motions, and a motion 0', () => {
    const { logs, reconcile, motion, at } = scene();
    const own = edit(logs, at + 1, 'ana');
    const withMotions = folded(foldLogs(logs.logs, at + 10), 'A').state;
    const without = fold(logs.logs.A ?? [], at + 10);
    const numbers = (state: typeof without) => state.proposals.map((p) => [p.id, p.number]);
    expect(numbers(withMotions)).toEqual([
      [reconcile, 1],
      [motion, 0],
      [own, 2],
    ]);
    expect(numbers(without)).toEqual([
      [reconcile, 1],
      [own, 2],
    ]);
  });

  it('gives a device no chat bot claim on an outside motion, while it claims the group’s own', () => {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben', 'cal']);
    const webhook = 'https://discord.com/api/webhooks/1199000000000000001/rV7-first_token';
    const target = { kind: 'rules', optIn: 'chatBot', value: { webhook } } as const;
    const rules = logs.add('A', R + 3, 'ana', {
      type: 'proposal',
      body: { target, title: 'Turn the chat bot on', why: 'We talked it over.' },
    });
    const reconcile = logs.reconcile('A', R + 7, 'ana', 'A');
    ['ana', 'ben', 'cal'].forEach((who, i) => {
      logs.vote('A', R + 4 + i, who, rules, 4);
      logs.vote('A', R + 8 + i, who, reconcile, 4);
    });
    const motion = logs.motion(logs.formed(R + 20, ['A', 'B'], ['kim', 'zed']), 'zed');
    const own = edit(logs, R + 40, 'ana');
    const state = folded(foldLogs(logs.logs, R + 41), 'A').state;
    const claimed = dueClaims(state, authorOf('ben')).map((claim) => claim.proposal);
    expect(state.optIns.chatBot).not.toBeNull();
    expect(state.proposals.some((p) => p.id === motion)).toBe(true);
    expect(claimed).toContain(own);
    expect(claimed).not.toContain(motion);
    expect(mayClaim(state, authorOf('ben'), motion, 'open')).toBe(false);
  });

  it('opens an outside motion with no Dispatch, so its pass sends the group none', () => {
    const { logs, motion } = scene();
    logs.vote('A', R + 200, 'ana', motion, 4);
    logs.vote('A', R + 201, 'ben', motion, 4);
    const state = folded(foldLogs(logs.logs, R + 300), 'A').state;
    const opened = state.proposals.find((p) => p.id === motion);
    expect(opened).toMatchObject({ final: true, dispatch: null, outcome: { kind: 'pass' } });
    expect(state.dispatches).toEqual([]);
  });
});
