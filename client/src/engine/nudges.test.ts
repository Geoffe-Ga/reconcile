import { describe, expect, it } from 'vitest';

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
