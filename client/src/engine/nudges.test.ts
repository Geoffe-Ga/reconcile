import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import { nudgeKey, nudgesFor } from './nudges';
import { DAY_MINUTES } from './rules';

const ANA = authorOf('ana');
const BEN = authorOf('ben');

describe('nudgesFor: the wakes a proposer’s device schedules (#99)', () => {
  it('gives my open Proposal with deadline D a wake at D − 1,440 (closing soon) and at D (its result)', () => {
    const log = groupLog({ members: ['Ben'] });
    log.minute += 10;
    const opened = log.minute;
    const proposal = log.propose('Ana');
    const deadline = deadlineOf(log.minute);

    // Each carries the minute its Proposal opened, whose week's mailbox it goes to (#110).
    expect(nudgesFor(log.state(), ANA)).toEqual([
      { proposal, opened, minute: deadline - DAY_MINUTES },
      { proposal, opened, minute: deadline },
    ]);
    expect(DAY_MINUTES).toBe(1440);
  });

  it('gives another member’s Proposal none', () => {
    const log = groupLog({ members: ['Ben'] });
    log.propose('Ben');

    expect(nudgesFor(log.state(), ANA)).toEqual([]);
    expect(nudgesFor(log.state(), BEN)).toHaveLength(2);
  });

  it('gives none once a Proposal has closed, at its deadline or early', () => {
    const log = groupLog({ members: ['Ben'] });
    const lapsed = log.propose('Ana');
    log.minute += 10;
    const decided = log.propose('Ana', { atom: 1 });
    log.vote('Ana', decided, 4);
    log.vote('Ben', decided, 4);

    expect(nudgesFor(log.state(), ANA).map((n) => n.proposal)).toEqual([lapsed, lapsed]);
    expect(nudgesFor(log.state(deadlineOf(log.minute)), ANA)).toEqual([]);
  });

  it('gives none once the group has dissolved: a Proposal still open then never closes (#108)', () => {
    const log = groupLog({ members: ['Ben'] });
    const open = log.propose('Ana');
    const motion = log.proposeDissolve('Ana', false);
    log.vote('Ana', motion, 4);
    log.vote('Ben', motion, 4);
    expect(nudgesFor(log.state(), ANA).map((n) => n.proposal)).toEqual([open, open]);
    log.minute += 1;
    log.dissolve('Ben', motion);

    expect(log.state().dissolved).not.toBeNull();
    expect(log.state().proposals.find((p) => p.id === open)?.final).toBe(false);
    expect(nudgesFor(log.state(), ANA)).toEqual([]);
  });

  it('names each nudge by its Proposal and minute', () => {
    expect(nudgeKey({ proposal: 'p1', minute: 29_010_080 })).toBe('p1@29010080');
  });
});

describe('nudgesFor: a coalition’s motion opened in the group (#284)', () => {
  const R = 29_375_000;
  const CAL = authorOf('cal');

  /** Group A (Ana, Ben) holds seat A of a coalition with seat B; Zed's motion opens in A; Cal joins A after. */
  function scene() {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben']);
    const reconcile = logs.reconcile('A', R + 3, 'ana', 'A');
    logs.vote('A', R + 4, 'ana', reconcile, 4);
    logs.vote('A', R + 5, 'ben', reconcile, 4);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    logs.add('A', at + 2, 'cal', { type: 'join', body: { name: 'Cal' } });
    return { logs, motion, at };
  }

  /** Group A as its devices fold it at `relayNow`, with the motion its seat decides. */
  const groupA = (logs: Logs, relayNow: number) => folded(foldLogs(logs.logs, relayNow), 'A').state;

  it('gives each member it is open to two nudges, its deadline’s minutes shifted by the group’s offset', () => {
    const { logs, motion, at } = scene();
    const state = groupA(logs, at + 5);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in A.');
    const offsetOf = (id: string) => (id === motion ? 17 : 0);
    const expected = [
      { proposal: motion, opened: opened.received, minute: opened.deadline - DAY_MINUTES + 17 },
      { proposal: motion, opened: opened.received, minute: opened.deadline + 17 },
    ];

    expect(nudgesFor(state, ANA, offsetOf)).toEqual(expected);
    expect(nudgesFor(state, BEN, offsetOf)).toEqual(expected);
    // Cal joined after it opened, so it isn't his to vote on, and his device nudges nothing.
    expect(nudgesFor(state, CAL, offsetOf)).toEqual([]);
  });

  it('gives none without the group’s offset, so no device ever nudges at the motion’s own minutes', () => {
    const { logs, at } = scene();
    expect(nudgesFor(groupA(logs, at + 5), ANA)).toEqual([]);
  });

  it('gives none once the group’s own vote on it has closed', () => {
    const { logs, motion, at } = scene();
    logs.vote('A', at + 3, 'ana', motion, 4);
    logs.vote('A', at + 4, 'ben', motion, 4);
    expect(nudgesFor(groupA(logs, at + 5), ANA, () => 17)).toEqual([]);
  });
});
