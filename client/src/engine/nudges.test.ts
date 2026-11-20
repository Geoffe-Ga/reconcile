import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import type { GroupState } from './fold';
import { nudgeKey, nudgesFor, REMINDER_MINUTES, reminds } from './nudges';
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

  it('gives each member it is open to three nudges, the reminder first, its deadline’s minutes shifted by the group’s offset (#250)', () => {
    const { logs, motion, at } = scene();
    const state = groupA(logs, at + 5);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in A.');
    const offsetOf = (id: string) => (id === motion ? 17 : 0);
    const expected = [
      { proposal: motion, opened: opened.received, minute: opened.deadline - 3 * DAY_MINUTES + 17 },
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

describe('the reminder for a reconcile or coalition vote (#250, the founder’s decision of 2026-11-19)', () => {
  const R = 29_375_000;

  /** Riverside (Ana, Ben, Cal) and Ana's reconcile Proposal, which Ben has scored. */
  function reconciling() {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben', 'cal']);
    const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
    logs.vote('A', R + 4, 'ben', proposal, 4);
    return { logs, proposal };
  }

  /** Group A's reconcile Proposal `id` folded at `relayNow`. */
  function proposalAt(logs: Logs, id: string, relayNow: number) {
    const found = folded(foldLogs(logs.logs, relayNow), 'A').state.proposals.find(
      (p) => p.id === id,
    );
    if (found === undefined) throw new Error('Expected the Proposal.');
    return found;
  }

  it('comes 3 days before a vote closes', () => {
    expect(REMINDER_MINUTES).toBe(4_320);
  });

  it('wakes the group 3 days before its reconcile Proposal closes, from the proposer’s device, as its other nudges do', () => {
    const { logs, proposal } = reconciling();
    const state = folded(foldLogs(logs.logs, R + 10), 'A').state;
    const { deadline, received } = proposalAt(logs, proposal, R + 10);

    expect(nudgesFor(state, ANA)).toEqual([
      { proposal, opened: received, minute: deadline - 3 * DAY_MINUTES },
      { proposal, opened: received, minute: deadline - DAY_MINUTES },
      { proposal, opened: received, minute: deadline },
    ]);
    expect(nudgesFor(state, BEN)).toEqual([]);
  });

  it('takes no reminder for an ordinary Proposal, nor for one whose window is 3 days, which opened then', () => {
    const log = groupLog({ members: ['Ben'] });
    log.propose('Ana');
    expect(nudgesFor(log.state(), ANA)).toHaveLength(2);

    const { logs, proposal } = reconciling();
    const state = folded(foldLogs(logs.logs, R + 10), 'A').state;
    const short: GroupState = {
      ...state,
      proposals: state.proposals.map((p) =>
        p.id === proposal ? { ...p, deadline: p.received + 3 * DAY_MINUTES } : p,
      ),
    };
    expect(
      nudgesFor(short, ANA).map((n) => n.minute - (short.proposals.at(-1)?.received ?? 0)),
    ).toEqual([2 * DAY_MINUTES, 3 * DAY_MINUTES]);
  });

  it('shows only to an eligible member who hasn’t scored it, from 3 days before it closes until it does', () => {
    const { logs, proposal } = reconciling();
    const { deadline } = proposalAt(logs, proposal, R + 10);
    const from = deadline - 3 * DAY_MINUTES;
    const open = proposalAt(logs, proposal, from);

    expect(reminds(open, ANA, from)).toBe(true);
    expect(reminds(open, authorOf('cal'), deadline - 1)).toBe(true);
    // Ben has scored it, and it isn't time yet a minute before.
    expect(reminds(open, BEN, from)).toBe(false);
    expect(reminds(open, ANA, from - 1)).toBe(false);
    // Nor for someone outside its eligible set, nor once it has closed.
    expect(reminds(open, authorOf('zed'), from)).toBe(false);
    expect(reminds(open, ANA, deadline)).toBe(false);
    expect(reminds(proposalAt(logs, proposal, deadline), ANA, deadline - 1)).toBe(false);
  });

  it('never shows for an ordinary Proposal', () => {
    const log = groupLog({ members: ['Ben'] });
    const id = log.propose('Ana');
    const proposal = log.state().proposals.find((p) => p.id === id);
    if (proposal === undefined) throw new Error('Expected the Proposal.');
    expect(reminds(proposal, BEN, proposal.deadline - 1)).toBe(false);
  });
});
