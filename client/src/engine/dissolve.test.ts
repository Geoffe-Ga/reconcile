/**
 * The dissolve rules the fold and the screens share (#108): who may propose
 * dissolving, which pass waits for its `dissolve`, which Proposals the
 * dissolve cut off, and when each device wipes or clears its copy.
 */
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { admissionOf, rightsAt, vouchWanted } from './admission';
import { can, holdsRights, LEVELS } from './capabilities';
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

describe('a dissolved group and earned voting rights (#101)', () => {
  const KIM = authorOf('kim');
  const WAIT_END = START_MINUTE + DEFAULT_RULES.waitDays * DAY_MINUTES;

  /** Ana, Ben and Cal hold rights; Kim joins at START_MINUTE as a newcomer Co-Creator. */
  function withNewcomer() {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING }, newcomers: ['Kim'] });
    const motion = log.proposeDissolve('ana', false);
    return { log, motion };
  }

  it('leaves a newcomer out of the dissolve vote, and takes neither their ballot nor their own motion', () => {
    const { log, motion } = withNewcomer();
    expect(mayProposeDissolve(log.state(), KIM)).toBe(false);
    log.minute += 1;
    const theirs = log.proposeDissolve('kim', true);
    log.vote('kim', motion, 0, 'Not yet.');
    const kimsBallot = log.records.length;
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    const state = log.state();
    const [only] = state.proposals;
    expect(state.proposals).toHaveLength(1);
    expect(only?.eligible).toEqual([ANA, BEN, authorOf('cal')]);
    expect(only?.ballots.map((b) => b.voter)).toEqual([ANA, BEN, authorOf('cal')]);
    expect(only?.outcome.kind).toBe('pass');
    expect(state.ignored).toEqual([
      { seq: kimsBallot - 1, id: theirs },
      { seq: kimsBallot, id: expect.any(String) as unknown },
    ]);
  });

  it('takes the dissolve from a newcomer, who reads the group', () => {
    const { log, motion } = withNewcomer();
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('kim', motion);
    expect(log.state().dissolved).toEqual({ received: log.minute, wipe: false });
  });

  it('takes no vouch after the dissolve, so a newcomer short of one stays so', () => {
    const { log, motion } = withNewcomer();
    log.vouch('ana', 'Kim');
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('ben', motion);
    const before = log.state();
    expect(vouchWanted(before, BEN, KIM)).toBe(false);
    log.minute += 1;
    const late = log.vouch('ben', 'Kim');
    const after = log.state(WAIT_END + 1);
    expect(after.vouches.map((v) => v.by)).toEqual([ANA]);
    expect(rightsAt(after, KIM)).toBeNull();
    expect(after.ignored.map((record) => record.id)).toContain(late);
    expect(admissionOf(after, KIM)?.vouchedBy).toEqual([ANA]);
  });

  it('stops a wait still running at the dissolve, so rights fixed for later never arrive', () => {
    const { log, motion } = withNewcomer();
    log.vouch('ana', 'Kim');
    log.vouch('ben', 'Kim');
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('ana', motion);
    const dissolvedAt = log.minute;
    const state = log.state(WAIT_END + 100_000);
    expect(rightsAt(state, KIM)).toBe(WAIT_END);
    expect(state.at).toBe(dissolvedAt);
    expect(holdsRights(state, KIM)).toBe(false);
    expect(can(state, KIM, 'vote')).toBe(false);
    expect(can(state, KIM, 'read')).toBe(true);
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
