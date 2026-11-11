import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder, START_MINUTE } from '../test/votes';
import { LEVELS } from './capabilities';
import type { RemovalProposalBody } from './event';
import { fold } from './fold';
import {
  extendedBy,
  mayProposeRemoval,
  mayRemove,
  mayRespond,
  openRemovalOf,
  removalDue,
  removalTarget,
  removedFrom,
  RESPONSE_MAX,
  responseFits,
  responseTo,
} from './removal';
import { DAY_MINUTES, DEFAULT_RULES } from './rules';
import type { Suspension } from './stewards';

const [FOLLOWING, VOTING] = LEVELS;
const ANA = authorOf('ana');
const BEN = authorOf('ben');
const KIM = authorOf('kim');
/** How long a removal vote runs: a fixed 14 days (ADR-0075 §3). */
const REMOVAL_MINUTES = 14 * DAY_MINUTES;

/** Ana, Ben, Cal, Dee and Kim, all holding voting rights at START_MINUTE. */
function five(): LogBuilder {
  return groupLog({ members: ['Ben', 'Cal', 'Dee', 'Kim'] });
}

/** Five, with Ana's removal of Kim passed by four 4s, which close it early. */
function passed(): { log: LogBuilder; removal: string } {
  const log = five();
  const removal = log.proposeRemoval('Ana', 'Kim');
  for (const voter of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(voter, removal, 4);
  log.minute += 1;
  return { log, removal };
}

describe('RESPONSE_MAX', () => {
  it('is 1,000 code points (ADR-0072 §4)', () => {
    expect(RESPONSE_MAX).toBe(1_000);
  });
});

describe('removalTarget', () => {
  it('names whom a removal would remove, and nobody for any other Proposal', () => {
    expect(removalTarget({ target: { kind: 'remove', member: 'kim' } })).toBe('kim');
    expect(removalTarget({ target: { kind: 'steward', member: 'kim' } })).toBeNull();
    expect(removalTarget({ target: { kind: 'edit' } })).toBeNull();
  });
});

describe('mayProposeRemoval: who may propose removing whom (ADR-0049)', () => {
  it('lets a Co-Creator or a Collaborator propose removing another member', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Ben: VOTING } });
    const state = log.state();
    expect(mayProposeRemoval(state, ANA, KIM)).toBe(true);
    expect(mayProposeRemoval(state, BEN, KIM)).toBe(true);
  });

  it('refuses a Member and a newcomer still earning a vote', () => {
    const log = groupLog({
      members: ['Ben', 'Kim'],
      levels: { Ben: FOLLOWING },
      newcomers: ['Zed'],
    });
    const state = log.state();
    expect(mayProposeRemoval(state, BEN, KIM)).toBe(false);
    expect(mayProposeRemoval(state, authorOf('zed'), KIM)).toBe(false);
  });

  it('refuses removing yourself, or anyone who isn’t a member now', () => {
    const log = groupLog({ members: ['Ben', 'Kim'] });
    log.leave('Ben');
    const state = log.state();
    expect(mayProposeRemoval(state, ANA, ANA)).toBe(false);
    expect(mayProposeRemoval(state, ANA, BEN)).toBe(false);
    expect(mayProposeRemoval(state, ANA, authorOf('hal'))).toBe(false);
  });

  it('refuses a second removal of someone while one is open, and allows one of someone else', () => {
    const log = five();
    log.proposeRemoval('Ana', 'Kim');
    const state = log.state();
    expect(mayProposeRemoval(state, BEN, KIM)).toBe(false);
    expect(mayProposeRemoval(state, BEN, authorOf('dee'))).toBe(true);
  });

  it('allows another removal once the first has closed without a pass', () => {
    const log = five();
    const first = log.proposeRemoval('Ana', 'Kim');
    expect(openRemovalOf(log.state(), KIM)?.id).toBe(first);
    expect(mayProposeRemoval(log.state(START_MINUTE + REMOVAL_MINUTES), BEN, KIM)).toBe(true);
    expect(openRemovalOf(log.state(START_MINUTE + REMOVAL_MINUTES), KIM)).toBeUndefined();
  });

  it('refuses a removal of someone a removal has passed against, and anything from them', () => {
    const { log } = passed();
    const state = log.state();
    expect(mayProposeRemoval(state, BEN, KIM)).toBe(false);
    expect(mayProposeRemoval(state, KIM, BEN)).toBe(false);
  });

  it('refuses a suspended member, and a dissolved group', () => {
    const log = five();
    log.suspend('Ana', 'Ben');
    expect(mayProposeRemoval(log.state(), BEN, KIM)).toBe(false);
    const dissolving = groupLog({ members: ['Ben', 'Kim'] });
    const motion = dissolving.proposeDissolve('Ana', false);
    for (const voter of ['Ana', 'Ben', 'Kim']) dissolving.vote(voter, motion, 4);
    dissolving.dissolve('Ana', motion);
    expect(mayProposeRemoval(dissolving.state(), ANA, KIM)).toBe(false);
  });
});

describe('responses (ADR-0049, ADR-0072 §4)', () => {
  it('fits 1 to 1,000 code points that aren’t blank, counting code points, not UTF-16 units', () => {
    expect(responseFits('x')).toBe(true);
    expect(responseFits(`${'a'.repeat(999)}🌿`)).toBe(true);
    expect(responseFits(`${'a'.repeat(1_000)}🌿`)).toBe(false);
    expect(responseFits('')).toBe(false);
    expect(responseFits(' \n\t ')).toBe(false);
  });

  it('lets the member a removal names respond once, while it is open, suspended or not', () => {
    const log = five();
    log.suspend('Ana', 'Kim');
    const removal = log.proposeRemoval('Ben', 'Kim');
    expect(mayRespond(log.state(), KIM, removal)).toBe(true);
    expect(mayRespond(log.state(), BEN, removal)).toBe(false);
    const id = log.respond('Kim', removal, 'I wasn’t there.');
    const state = log.state();
    expect(responseTo(state, removal)).toMatchObject({ id, by: KIM, text: 'I wasn’t there.' });
    expect(mayRespond(state, KIM, removal)).toBe(false);
  });

  it('refuses a response once the vote has closed, on an edit, or on a Proposal that doesn’t exist', () => {
    const log = five();
    const edit = log.propose('Ana');
    const removal = log.proposeRemoval('Ana', 'Kim');
    expect(mayRespond(log.state(START_MINUTE + REMOVAL_MINUTES), KIM, removal)).toBe(false);
    expect(mayRespond(log.state(), KIM, edit)).toBe(false);
    expect(mayRespond(log.state(), KIM, 'no-such-proposal')).toBe(false);
    expect(responseTo(log.state(), removal)).toBeUndefined();
  });

  it('refuses a response from someone who has left, though the removal of them is still open', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    log.leave('Kim');
    expect(mayRespond(log.state(), KIM, removal)).toBe(false);
  });
});

describe('after the pass: remove (#115)', () => {
  it('is due once the pass is final, and any member but the one it names may post it', () => {
    const { log, removal } = passed();
    const state = log.state();
    expect(removalDue(state)).toBe(removal);
    expect(mayRemove(state, BEN, removal)).toBe(true);
    expect(mayRemove(state, KIM, removal)).toBe(false);
    expect(mayRemove(state, authorOf('hal'), removal)).toBe(false);
    expect(removedFrom(state, KIM)).toBeUndefined();
  });

  it('is not due while the vote is open, nor for a removal that failed', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    expect(removalDue(log.state())).toBeNull();
    expect(mayRemove(log.state(), BEN, removal)).toBe(false);
    for (const [voter, score] of [
      ['Ana', 0],
      ['Ben', 0],
      ['Cal', 4],
      ['Dee', 4],
    ] as const) {
      log.vote(voter, removal, score, 'Talk first.');
    }
    expect(removalDue(log.state())).toBeNull();
  });

  it('is not due once a remove has folded, and names the removal that took them out', () => {
    const { log, removal } = passed();
    const id = log.remove('Ben', removal);
    const state = log.state();
    expect(removalDue(state)).toBeNull();
    expect(mayRemove(state, authorOf('cal'), removal)).toBe(false);
    expect(removedFrom(state, KIM)).toMatchObject({ proposal: removal, removed: { id, by: BEN } });
    expect(removedFrom(state, BEN)).toBeUndefined();
  });

  it('is not due once the member it names has left on their own', () => {
    const { log, removal } = passed();
    log.leave('Kim');
    expect(removalDue(log.state())).toBeNull();
    expect(mayRemove(log.state(), BEN, removal)).toBe(false);
  });

  it('refuses a remove from a suspended member', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const voter of ['Ana', 'Ben', 'Cal']) log.vote(voter, removal, 4);
    log.minute = START_MINUTE + 13 * DAY_MINUTES;
    log.suspend('Ana', 'Dee');
    const after = log.state(START_MINUTE + REMOVAL_MINUTES);
    expect(removalDue(after)).toBe(removal);
    expect(mayRemove(after, authorOf('dee'), removal)).toBe(false);
    expect(mayRemove(after, BEN, removal)).toBe(true);
  });

  it('is never due in a dissolved group, though a removal passed before it', () => {
    const log = groupLog({ members: ['Ben', 'Cal', 'Kim'] });
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const voter of ['Ana', 'Ben', 'Cal']) log.vote(voter, removal, 4);
    const motion = log.proposeDissolve('Ana', false);
    for (const voter of ['Ana', 'Ben', 'Cal']) log.vote(voter, motion, 4);
    log.minute += 1;
    log.dissolve('Ana', motion);
    const state = log.state();
    expect(state.removals).toHaveLength(1);
    expect(removalDue(state)).toBeNull();
    expect(mayRemove(state, BEN, removal)).toBe(false);
  });
});

describe('extendedBy: a suspension a removal vote extends (ADR-0059)', () => {
  const suspension: Suspension = {
    id: 's',
    seq: 1,
    received: 1_000,
    by: 'ana',
    member: 'kim',
    reason: null,
    until: 1_000 + 7 * DAY_MINUTES,
    removal: null,
  };

  it('lasts until the vote’s deadline while it is open, and names it', () => {
    const proposal = { id: 'r', deadline: 50_000, closedAt: null };
    expect(extendedBy(suspension, DEFAULT_RULES, proposal)).toEqual({
      ...suspension,
      until: 50_000,
      removal: 'r',
    });
  });

  it('ends at the vote’s early close once that is past its own 7 days', () => {
    const proposal = { id: 'r', deadline: 50_000, closedAt: 20_000 };
    expect(extendedBy(suspension, DEFAULT_RULES, proposal).until).toBe(20_000);
  });

  it('never ends before its own 7 days, from its receipt, whatever it held', () => {
    const proposal = { id: 'r', deadline: 50_000, closedAt: 2_000 };
    const held = { ...suspension, until: 50_000 };
    expect(extendedBy(held, DEFAULT_RULES, proposal).until).toBe(1_000 + 7 * DAY_MINUTES);
  });
});

describe('the removal bar in the fold (ADR-0075 §3)', () => {
  /** A group of 21: Ana and 20 others, every one holding voting rights at START_MINUTE. */
  function twentyOne(): LogBuilder {
    const members = Array.from({ length: 20 }, (_, i) => `M${String(i)}`);
    return groupLog({ members });
  }

  it('passes a removal that 20 score with one 0, where a dissolve with the same ballots fails', () => {
    const log = twentyOne();
    const removal = log.proposeRemoval('Ana', 'M19');
    const voters = ['Ana', ...Array.from({ length: 19 }, (_, i) => `M${String(i)}`)];
    voters.forEach((voter, i) => {
      log.vote(voter, removal, i === 0 ? 0 : 4, 'Talk first.');
    });
    const motion = log.proposeDissolve('Ana', false);
    voters.forEach((voter, i) => {
      log.vote(voter, motion, i === 0 ? 0 : 4, 'Not yet.');
    });
    const state = log.state(START_MINUTE + 15 * DAY_MINUTES);
    const [kept, dissolve] = state.proposals;
    expect(kept).toMatchObject({
      class: 'removal',
      eligible: voters.map((v) => authorOf(v.toLowerCase())),
    });
    expect(kept?.outcome.kind).toBe('pass');
    expect(dissolve).toMatchObject({ class: 'entrenched' });
    expect(dissolve?.outcome.kind).toBe('fail');
    expect(fold(log.records, START_MINUTE + 15 * DAY_MINUTES).removals).toHaveLength(1);
  });
});

describe('a removal beside Dispatches (#112)', () => {
  it('ignores a Dispatch from the Co-Creator a passed removal names, and takes one from the others', () => {
    const { log } = passed();
    log.dispatch('Kim', { title: 'Still here', text: 'Read this.' });
    log.dispatch('Ben', { title: 'Bins move to Monday', text: '' });
    const state = log.state();
    expect(state.dispatches.map((dispatch) => dispatch.title)).toEqual(['Bins move to Monday']);
  });

  it('sends a Dispatch a removal carries once it passes, pointing to no Document', () => {
    const log = five();
    const dispatch = { title: 'A vote removed Kim', text: 'The house rules still stand.' };
    const id = log.proposeRemoval('Ana', 'Kim', { dispatch });
    for (const voter of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(voter, id, 4);
    log.minute += 1;
    const [sent] = log.state().dispatches;
    expect(sent).toMatchObject({ id, by: { proposal: id }, ...dispatch, doc: null });
  });
});

describe('a removal beside coalitions (#100)', () => {
  const R = 29_375_000;
  const CAL = authorOf('cal');
  const removalOf = (member: string): RemovalProposalBody => ({
    target: { kind: 'remove', member },
    title: 'Remove them',
    why: 'They broke the agreement.',
  });

  /**
   * Group A (ana, ben, cal) passes its reconcile Proposal for seat A, and Ana
   * proposes removing Cal; `scores` are the removal's ballots. A coalition of
   * A and B then forms, and zed moves.
   */
  function scene(scores: Readonly<Record<string, 0 | 1 | 2 | 3 | 4>>) {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben', 'cal']);
    const reconcile = logs.reconcile('A', R + 3, 'ana', 'A');
    for (const voter of ['ana', 'ben', 'cal']) logs.vote('A', R + 4, voter, reconcile, 4);
    const removal = logs.add('A', R + 5, 'ana', { type: 'proposal', body: removalOf(CAL) });
    for (const [voter, score] of Object.entries(scores))
      logs.vote('A', R + 6, voter, removal, score);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    return { logs, removal, motion };
  }

  const motionIn = (logs: Logs, id: string) =>
    folded(foldLogs(logs.logs, R + 100), 'A').state.proposals.find((p) => p.id === id);

  it('leaves the person a passed removal names out of a motion the group opens', () => {
    const { logs, motion } = scene({ ana: 4, ben: 4 });
    expect(motionIn(logs, motion)?.eligible).toEqual([authorOf('ana'), authorOf('ben')]);
  });

  it('keeps the person a removal only names, while it is open, in a motion’s eligible set', () => {
    const { logs, motion } = scene({ ana: 4 });
    expect(motionIn(logs, motion)?.eligible).toEqual([authorOf('ana'), authorOf('ben'), CAL]);
  });

  it('ignores a removal, a response and a remove in a coalition’s own log', () => {
    const logs = new Logs();
    const at = logs.formed(R, ['A', 'B'], ['kim', 'zed']);
    const proposal = logs.add('coalition', at, 'zed', {
      type: 'proposal',
      body: removalOf(KIM),
    });
    const response = logs.add('coalition', at + 1, 'kim', {
      type: 'removal-response',
      body: { proposal, text: 'I disagree.' },
    });
    const remove = logs.add('coalition', at + 2, 'zed', { type: 'remove', body: { proposal } });
    const state = fold(logs.logs.coalition ?? [], at + 3);
    expect(state.ignored.map((r) => r.id)).toEqual([proposal, response, remove]);
    expect(state.proposals).toEqual([]);
    expect(state.members.map((m) => m.author)).toContain(KIM);
  });
});
