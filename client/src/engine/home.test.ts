import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { publicKeyNamed, vector as goldenVector, type VectorLog } from '../test/vectors';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { LEVELS } from './capabilities';
import { fold as foldRecords } from './fold';
import { homeLists } from './home';

const [FOLLOWING] = LEVELS;

/** Folds a golden vector's records at its own relay `now`. */
const fold = (log: VectorLog) => foldRecords(log.records, log.relayNow);

const two = goldenVector('two-open-proposals');
const vector = (name: string): VectorLog => goldenVector(name);
const relayNow = two.relayNow ?? 0;
/** P2 opens on the Monday and P1 on the Tuesday, so P2 closes first. */
const P2 = two.ids.get(4);
const P1 = two.ids.get(5);
const B = publicKeyNamed('ben');
const C = publicKeyNamed('cal');

const ids = (proposals: readonly { readonly id: string }[]) => proposals.map((p) => p.id);

describe('homeLists', () => {
  it('puts what you haven’t scored first, closing soonest, then the rest by closing date', () => {
    // home.test.ts: P2 closes Mon and P1 closes Tue; B has scored P1 only
    const s = fold(vector('two-open-proposals'));
    expect(homeLists(s, B, relayNow).needsYourVote.map((p) => p.id)).toEqual([P2]);
    expect(homeLists(s, B, relayNow).otherOpen.map((p) => p.id)).toEqual([P1]);
    // C joined after both opened, so neither is in C's needsYourVote
    expect(homeLists(s, C, relayNow).needsYourVote).toEqual([]);
  });

  it('orders by closing date, not by when each Proposal opened', () => {
    const s = fold(vector('two-open-proposals'));
    const dee = publicKeyNamed('dee');
    expect(ids(homeLists(s, dee, relayNow).needsYourVote)).toEqual([P2, P1]);
    expect(ids(homeLists(s, C, relayNow).otherOpen)).toEqual([P2, P1]);
    expect(homeLists(s, C, relayNow).decided).toEqual([]);
  });

  it('keeps a Proposal there while a version you haven’t scored is on its ballot', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ana');
    log.vote('ben', p, 3);
    log.version('cal', p, 'Quiet after midnight.');
    const s = log.state();
    expect(ids(homeLists(s, authorOf('ben'), log.minute).needsYourVote)).toEqual([p]);
    const v = s.proposals[0]?.versions[1]?.id ?? '';
    log.ballot('ben', p, { [p]: 3, [v]: 2 });
    const scored = log.state();
    expect(homeLists(scored, authorOf('ben'), log.minute).needsYourVote).toEqual([]);
    expect(ids(homeLists(scored, authorOf('ben'), log.minute).otherOpen)).toEqual([p]);
  });

  it('never lists there a Proposal you can’t vote on now, though you were eligible', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ana');
    log.level('ben', FOLLOWING);
    const s = log.state();
    expect(s.proposals[0]?.eligible).toContain(authorOf('ben'));
    expect(homeLists(s, authorOf('ben'), log.minute).needsYourVote).toEqual([]);
    expect(ids(homeLists(s, authorOf('ben'), log.minute).otherOpen)).toEqual([p]);
  });

  it('never lists there a Proposal after you have left, though the relay hasn’t closed it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ana');
    log.leave('ben');
    const s = log.state();
    expect(homeLists(s, authorOf('ben'), log.minute).needsYourVote).toEqual([]);
    expect(ids(homeLists(s, authorOf('ben'), log.minute).otherOpen)).toEqual([p]);
  });

  it('moves a Proposal out once relay time reaches its deadline, before the fold has closed it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ana');
    const deadline = deadlineOf(START_MINUTE);
    // Folded at the last relay `now`, it's still open; the device's estimate has moved on.
    const s = log.state(deadline - 1);
    expect(ids(homeLists(s, authorOf('ben'), deadline - 1).needsYourVote)).toEqual([p]);
    expect(homeLists(s, authorOf('ben'), deadline).needsYourVote).toEqual([]);
    expect(ids(homeLists(s, authorOf('ben'), deadline).otherOpen)).toEqual([p]);
    expect(homeLists(s, authorOf('ben'), deadline).decided).toEqual([]);
  });

  it('breaks a tie in closing date by relay order', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const first = log.propose('ana', { atom: 0 });
    const second = log.propose('ana', { atom: 1 });
    const s = log.state();
    expect(s.proposals.map((p) => p.deadline)).toEqual([
      deadlineOf(START_MINUTE),
      deadlineOf(START_MINUTE),
    ]);
    expect(ids(homeLists(s, authorOf('ben'), log.minute).needsYourVote)).toEqual([first, second]);
  });

  it('lists decided Proposals newest close first, and by later relay order within a minute', () => {
    const log = groupLog({ members: ['Ben'] });
    const lapsed = log.propose('ana', { atom: 1 });
    const early = log.propose('ana', { atom: 0 });
    log.minute += 10;
    log.vote('ana', early, 4);
    log.vote('ben', early, 4);
    const sameMinute = log.propose('ana', { atom: 0, title: 'Again' });
    log.vote('ana', sameMinute, 0, 'No.');
    log.vote('ben', sameMinute, 0, 'No.');
    const s = log.state(deadlineOf(START_MINUTE));
    expect(ids(homeLists(s, authorOf('ana'), deadlineOf(START_MINUTE)).decided)).toEqual([
      lapsed,
      sameMinute,
      early,
    ]);
    expect(homeLists(s, authorOf('ana'), deadlineOf(START_MINUTE)).needsYourVote).toEqual([]);
    expect(homeLists(s, authorOf('ana'), deadlineOf(START_MINUTE)).otherOpen).toEqual([]);
  });
});

describe('homeLists in a dissolved group (#108)', () => {
  it('lists nothing under Needs your vote, and keeps a Proposal open at the dissolve with the open ones', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.propose('ana');
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('ana', motion);
    const s = log.state(log.minute + 5);
    const lists = homeLists(s, authorOf('ben'), log.minute + 5);
    expect(lists.needsYourVote).toEqual([]);
    expect(ids(lists.otherOpen)).toEqual([open]);
    expect(ids(lists.open)).toEqual([open]);
    expect(ids(lists.decided)).toEqual([motion]);
  });
});
