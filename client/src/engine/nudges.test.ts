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
    const proposal = log.propose('Ana');
    const deadline = deadlineOf(log.minute);

    expect(nudgesFor(log.state(), ANA)).toEqual([
      { proposal, minute: deadline - DAY_MINUTES },
      { proposal, minute: deadline },
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

  it('names each nudge by its Proposal and minute', () => {
    expect(nudgeKey({ proposal: 'p1', minute: 29_010_080 })).toBe('p1@29010080');
  });
});
