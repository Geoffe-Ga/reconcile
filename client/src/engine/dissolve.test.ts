/**
 * The dissolve rules the fold and the screens share (#108): who may propose
 * dissolving, which pass waits for its `dissolve`, which Proposals the
 * dissolve cut off, and when each device wipes or clears its copy.
 */
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { LEVELS } from './capabilities';
import {
  clearMinute,
  closedByDissolve,
  dissolveDue,
  hasOpenDissolve,
  mayProposeDissolve,
  WIPE_DAYS,
  wipeMinute,
} from './dissolve';
import { DAY_MINUTES, DEFAULT_RULES } from './rules';

const ANA = authorOf('ana');
const BEN = authorOf('ben');
const [, VOTING] = LEVELS;

/** Ana, Ben (a Co-Creator) and Cal (a Collaborator), with a dissolve Proposal by Ana. */
function withMotion(wipe = false) {
  const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
  const motion = log.proposeDissolve('ana', wipe);
  return { log, motion };
}

describe('mayProposeDissolve', () => {
  it('lets anyone who proposes dissolve a group with no dissolve Proposal open', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    const state = log.state();
    expect(mayProposeDissolve(state, ANA)).toBe(true);
    expect(mayProposeDissolve(state, BEN)).toBe(true);
    expect(mayProposeDissolve(state, authorOf('cal'))).toBe(false);
  });

  it('refuses while a dissolve Proposal is open, up to the minute before its deadline', () => {
    const { log } = withMotion();
    const opened = log.minute;
    const deadline = opened + DEFAULT_RULES.windows.entrenched.default * DAY_MINUTES;
    expect(hasOpenDissolve(log.state(deadline - 1))).toBe(true);
    expect(mayProposeDissolve(log.state(deadline - 1), BEN)).toBe(false);
    expect(hasOpenDissolve(log.state(deadline))).toBe(false);
    expect(mayProposeDissolve(log.state(deadline), BEN)).toBe(true);
  });

  it('allows another once the first has closed early, and none once the group has dissolved', () => {
    const { log, motion } = withMotion();
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    expect(mayProposeDissolve(log.state(), BEN)).toBe(true);
    log.dissolve('cal', motion);
    expect(mayProposeDissolve(log.state(), BEN)).toBe(false);
  });
});

describe('dissolveDue', () => {
  it('names nothing while the vote is open, or when it fails', () => {
    const { log, motion } = withMotion();
    log.vote('ana', motion, 4);
    expect(dissolveDue(log.state())).toBeNull();
    log.vote('ben', motion, 4);
    log.vote('cal', motion, 0, 'Not yet.');
    expect(log.state().proposals[0]?.outcome.kind).toBe('fail');
    expect(dissolveDue(log.state())).toBeNull();
  });

  it('names a final pass until a dissolve folds, then nothing', () => {
    const { log, motion } = withMotion();
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    expect(dissolveDue(log.state())).toBe(motion);
    log.dissolve('ben', motion);
    expect(dissolveDue(log.state())).toBeNull();
  });

  it('never names a passed edit', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const edit = log.propose('ana');
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, edit, 4);
    expect(log.state().proposals[0]?.outcome.kind).toBe('pass');
    expect(dissolveDue(log.state())).toBeNull();
  });
});

describe('closedByDissolve', () => {
  it('marks only a Proposal still open when its group dissolved', () => {
    const { log, motion } = withMotion(true);
    const edit = log.propose('ana');
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    const before = log.state();
    const open = before.proposals.find((p) => p.id === edit);
    if (open === undefined) throw new Error('The edit should have opened.');
    expect(closedByDissolve(before, open)).toBe(false);
    log.dissolve('ana', motion);
    const after = log.state(log.minute + 100_000);
    const [decided, cut] = after.proposals;
    if (decided === undefined || cut === undefined) throw new Error('Both should be there.');
    expect(after.dissolved).toEqual({ received: log.minute, wipe: true });
    expect(closedByDissolve(after, decided)).toBe(false);
    expect(closedByDissolve(after, cut)).toBe(true);
  });
});

describe('when a device wipes or clears its copy', () => {
  const dissolved = { received: 30_000_001, wipe: true };

  it('wipes a week after the dissolve: 10,080 relay minutes', () => {
    expect(WIPE_DAYS).toBe(7);
    expect(wipeMinute(dissolved)).toBe(30_000_001 + 10_080);
  });

  it('clears ballots and notes ballotExpiryDays after it: 43,200 minutes by default', () => {
    expect(clearMinute(DEFAULT_RULES, dissolved)).toBe(30_000_001 + 43_200);
    expect(clearMinute({ ballotExpiryDays: 7 }, dissolved)).toBe(30_000_001 + 10_080);
  });
});
