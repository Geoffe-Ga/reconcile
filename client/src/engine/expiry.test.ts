import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs, seatOf } from '../test/coalitions';
import { authorOf, signedAs } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { utf8 } from '../test/bytes';
import { ballotCommit, commitEntries } from './commit';
import { parseRecord, type ResultBody } from './event';
import {
  ballotsExpireAt,
  ballotsExpired,
  EXPIRES_WITH_BALLOTS,
  expiringProposal,
  expiryKeyOf,
  needsResult,
  recordedOutcome,
  resultFor,
} from './expiry';
import { resultMismatches, resultsToReport } from './crossing';
import { closeTime, fold, type GroupState, type LogRecord, type Proposal } from './fold';
import { DEFAULT_RULES } from './rules';

/** 30 days in relay minutes. */
const THIRTY_DAYS = 43_200;

/** Ana proposes in a group of Ana and Ben; Ana scores 4 and Ben 0 with a reason, closing it early. */
function decidedLog() {
  const log = groupLog({ members: ['Ben'] });
  const proposalId = log.propose('ana');
  log.minute += 10;
  log.ballot('ana', proposalId, { [proposalId]: 4 }, undefined, 'c2FsdC1hbmEtMDAwMDAwMA');
  log.minute += 1;
  log.ballot('ben', proposalId, { [proposalId]: 0 }, 'It ends too late.');
  const closedAt = log.minute;
  return { log, proposalId, closedAt, closedSeq: log.records.length };
}

function only(proposals: readonly Proposal[]): Proposal {
  const [proposal] = proposals;
  if (proposal === undefined) throw new Error('Expected one Proposal.');
  return proposal;
}

describe('resultFor', () => {
  it('records the close and the closing ballot’s seq, the eligible count, each version’s counts, the outcome and the commitment', () => {
    const { log, proposalId, closedAt, closedSeq } = decidedLog();
    const proposal = only(log.state().proposals);
    expect(resultFor(proposal)).toEqual({
      proposal: proposalId,
      closedAt,
      closedSeq,
      eligible: 2,
      versions: [{ id: proposalId, counts: [1, 0, 0, 0, 1] }],
      outcome: { kind: 'fail' },
      commit: ballotCommit(
        commitEntries(
          [proposalId],
          [
            { voter: authorOf('ana'), scores: { [proposalId]: 4 }, salt: 'c2FsdC1hbmEtMDAwMDAwMA' },
            { voter: authorOf('ben'), scores: { [proposalId]: 0 }, salt: '' },
          ],
        ),
      ),
    });
  });

  it('never carries a note', () => {
    const { log } = decidedLog();
    expect(JSON.stringify(resultFor(only(log.state().proposals)))).not.toContain('too late');
  });

  it('is accepted by the fold once a member posts it after the close', () => {
    const { log, proposalId, closedAt } = decidedLog();
    const body = resultFor(only(log.state().proposals));
    log.minute = closedAt + 1;
    log.result('ben', body);
    const proposal = only(log.state().proposals);
    expect(proposal.result).toMatchObject({
      author: authorOf('ben'),
      closedAt,
      commit: body.commit,
    });
    expect(proposal.mismatched).toEqual([]);
    expect(proposal.id).toBe(proposalId);
  });

  it('closes a Proposal that ran to its deadline at the deadline', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana');
    const deadline = deadlineOf(START_MINUTE);
    const proposal = only(log.state(deadline).proposals);
    expect(resultFor(proposal)).toMatchObject({ proposal: proposalId, closedAt: deadline });
    expect(resultFor(proposal)).not.toHaveProperty('closedSeq');
    expect(closeTime(proposal)).toBe(deadline);
  });

  it('names the ballot that closed it early as its last, even when that voter had voted before (#289)', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana');
    const versionId = log.version('ana', proposalId, 'Quiet after 9pm.');
    log.minute += 1;
    log.ballot('ben', proposalId, { [proposalId]: 4 });
    log.ballot('ana', proposalId, { [proposalId]: 3, [versionId]: 4 });
    const open = only(log.state().proposals);
    expect(open.closedAt).toBeNull();
    log.minute += 1;
    log.ballot('ben', proposalId, { [proposalId]: 4, [versionId]: 2 });
    const closedSeq = log.records.length;
    log.minute += 1;
    log.ballot('ana', proposalId, { [proposalId]: 0, [versionId]: 0 }, 'Too late.');
    const proposal = only(log.state().proposals);
    expect(proposal.ballots.map((ballot) => ballot.seq)).toEqual([closedSeq - 1, closedSeq]);
    expect(resultFor(proposal)).toMatchObject({ closedAt: proposal.closedAt, closedSeq });
  });
});

describe('recordedOutcome', () => {
  it('drops the bar, which the Proposal’s class sets, and keeps a pass’s version', () => {
    const bar = DEFAULT_RULES.bars.ordinary;
    expect(recordedOutcome({ kind: 'pass', version: 'v', bar })).toEqual({
      kind: 'pass',
      version: 'v',
    });
    expect(recordedOutcome({ kind: 'fail', bar })).toEqual({ kind: 'fail' });
    expect(recordedOutcome({ kind: 'lapse', bar })).toEqual({ kind: 'lapse' });
  });
});

describe('needsResult', () => {
  it('asks for a result once the relay is past a closed Proposal’s close, and not in its minute', () => {
    const { log, closedAt } = decidedLog();
    const proposal = only(log.state().proposals);
    expect(needsResult(proposal, closedAt)).toBe(false);
    expect(needsResult(proposal, closedAt + 1)).toBe(true);
    expect(needsResult(proposal, null)).toBe(false);
  });

  it('asks for none while the vote is open, once a valid result is in, or once ballots are cleared', () => {
    const open = groupLog({ members: ['Ben'] });
    open.propose('ana');
    expect(needsResult(only(open.state().proposals), START_MINUTE + 1)).toBe(false);

    const { log, closedAt } = decidedLog();
    const body = resultFor(only(log.state().proposals));
    log.minute = closedAt + 1;
    log.result('ana', body);
    expect(needsResult(only(log.state().proposals), closedAt + 5)).toBe(false);
    expect(
      needsResult(
        only(fold(log.records, closedAt + 5, [], [body.proposal]).proposals),
        closedAt + 5,
      ),
    ).toBe(false);
  });
});

describe('ballotsExpireAt and ballotsExpired', () => {
  it('keeps the ballots until 30 days after the close, and clears them from the minute it ends', () => {
    const { log, closedAt } = decidedLog();
    log.minute = closedAt + 1;
    log.result('ana', resultFor(only(log.state().proposals)));
    const proposal = only(log.state().proposals);
    expect(ballotsExpireAt(DEFAULT_RULES, proposal)).toBe(closedAt + THIRTY_DAYS);
    expect(ballotsExpired(DEFAULT_RULES, proposal, closedAt + THIRTY_DAYS - 1)).toBe(false);
    expect(ballotsExpired(DEFAULT_RULES, proposal, closedAt + THIRTY_DAYS)).toBe(true);
    expect(ballotsExpired(DEFAULT_RULES, proposal, null)).toBe(false);
  });

  it('counts the 30 days from the decision, whatever window the proposer chose (#106)', () => {
    const log = groupLog({ members: ['Ben'] });
    log.propose('ana', { window: 10 });
    const deadline = START_MINUTE + 10 * 1_440;
    log.minute = deadline + 1;
    log.result('ben', resultFor(only(log.state(deadline).proposals)));
    const proposal = only(log.state().proposals);
    expect(proposal.result?.closedAt).toBe(deadline);
    expect(ballotsExpireAt(DEFAULT_RULES, proposal)).toBe(deadline + THIRTY_DAYS);
    expect(ballotsExpired(DEFAULT_RULES, proposal, deadline + THIRTY_DAYS - 1)).toBe(false);
    expect(ballotsExpired(DEFAULT_RULES, proposal, deadline + THIRTY_DAYS)).toBe(true);
  });

  it('never clears without a valid result, nor clears twice', () => {
    const { log, closedAt, proposalId } = decidedLog();
    expect(ballotsExpired(DEFAULT_RULES, only(log.state().proposals), closedAt + THIRTY_DAYS)).toBe(
      false,
    );
    log.minute = closedAt + 1;
    log.result('ana', resultFor(only(log.state().proposals)));
    const cleared = only(fold(log.records, closedAt + THIRTY_DAYS, [], [proposalId]).proposals);
    expect(ballotsExpired(DEFAULT_RULES, cleared, closedAt + THIRTY_DAYS)).toBe(false);
  });
});

describe('expiringProposal and expiryKeyOf', () => {
  it('name the Proposal a ballot or a result belongs to, and nothing for any other event', () => {
    const { log, proposalId, closedAt } = decidedLog();
    log.minute = closedAt + 1;
    log.result('ana', resultFor(only(log.state().proposals)));
    log.version('ana', proposalId, 'Never expires.');
    const kinds = log.records.map((record) => expiryKeyOf(record.bytes)?.proposal ?? null);
    // genesis, join, proposal, two ballots, the result, a version
    expect(kinds).toEqual([null, null, null, proposalId, proposalId, proposalId, null]);
    const ballot = log.records[3];
    expect(expiryKeyOf(ballot?.bytes ?? new Uint8Array())?.id).toBe(
      only(log.state().proposals).ballots[0]?.id,
    );
  });

  it('name nothing for bytes that aren’t a signed event', () => {
    expect(expiryKeyOf(utf8('{"type":"vote"}'))).toBeNull();
    const vote = signedAs('ana', {
      type: 'vote',
      group: 'g',
      ts: 0,
      body: { proposal: 'p', scores: { p: 3 } },
    });
    const event = parseRecord(vote.record)?.event;
    expect(event === undefined ? undefined : expiringProposal(event)).toBe('p');
  });

  it('register no other event type until #115’s removal response, and never a version', () => {
    expect(EXPIRES_WITH_BALLOTS).toEqual([]);
  });
});

describe('a cleared steward election (#102)', () => {
  it('seats the same steward at the same close, so a suspension straight after it still stands', () => {
    const log = groupLog({ members: ['Ben', 'Cal', 'Kim'] });
    const proposal = log.steward('Ben', 1, 'Ben');
    for (const name of ['Ana', 'Ben', 'Cal', 'Kim']) log.vote(name, proposal, 4);
    const closedAt = log.minute;
    // Ben suspends Kim the minute after the close, before any result arrives.
    log.minute += 1;
    log.suspend('Ben', 'Kim', 'Threats.');
    log.minute += 1;
    log.result('Cal', resultFor(only(log.state().proposals)));
    const now = closedAt + THIRTY_DAYS;
    const held = fold(log.records, now);
    const kept = log.records.filter((record) => {
      const event = parseRecord(record.bytes)?.event;
      return event?.type !== 'vote';
    });

    const cleared = fold(kept, now, [], [proposal]);

    expect(held.suspensions).toHaveLength(1);
    expect(cleared.stewards).toEqual(held.stewards);
    expect(cleared.suspensions).toEqual(held.suspensions);
    expect(cleared.proposals[0]).toMatchObject({
      cleared: true,
      closedAt,
      outcome: { kind: 'pass' },
    });
    expect(cleared.proposals[0]?.result?.author).toBe(authorOf('cal'));
  });
});

/** `records` without any ballot on the Proposals in `cleared`: what a device keeps once they expire. */
function withoutBallots(records: readonly LogRecord[], cleared: readonly string[]): LogRecord[] {
  return records.filter((record) => {
    const event = parseRecord(record.bytes)?.event;
    return event?.type !== 'vote' || !cleared.includes(event.body.proposal);
  });
}

/** What a device must keep once ballots expire: the Document, and each Proposal's close and outcome. */
function decisions(state: GroupState) {
  return {
    atoms: state.atoms,
    dispatches: state.dispatches,
    proposals: state.proposals.map(({ id, final, closedAt, outcome }) => ({
      id,
      final,
      closedAt,
      outcome,
    })),
  };
}

describe('cleared sections (#75)', () => {
  it('takes out a removed section and puts in an added one as the ballots did, and a later Proposal on the removed one stays ignored', () => {
    const log = groupLog({ members: ['Ben'], atoms: ['Quiet after 10pm.', 'Bins out on Sunday.'] });
    const removal = log.propose('ana', { atom: 1, text: '' });
    log.vote('ana', removal, 4);
    log.vote('ben', removal, 3);
    const add = log.addSection('ben', `${log.group}.0`, { text: 'Bikes go in the shed.' });
    log.vote('ana', add, 4);
    log.vote('ben', add, 4);
    log.minute += 1;
    const [removed, added] = log.state().proposals;
    log.result('ben', resultFor(removed ?? never()));
    log.result('ana', resultFor(added ?? never()));
    // Too late: the section is gone, so the fold ignores a Proposal on it either way.
    const late = log.propose('ben', { atom: 1, text: 'Bins out on Monday.' });
    const now = log.minute + THIRTY_DAYS;
    const held = fold(log.records, now);

    const cleared = fold(withoutBallots(log.records, [removal, add]), now, [], [removal, add]);

    expect(held.atoms.map((atom) => atom.text)).toEqual([
      'Quiet after 10pm.',
      'Bikes go in the shed.',
    ]);
    expect(held.proposals.some((p) => p.id === late)).toBe(false);
    expect(decisions(cleared)).toEqual(decisions(held));
    expect(cleared.proposals.map((p) => p.cleared)).toEqual([true, true]);
  });
});

describe('a cleared Proposal carrying a Dispatch (#112)', () => {
  it('sends its Dispatch at its close, as the ballots did', () => {
    const log = groupLog({ members: ['Ben'] });
    const dispatch = { title: 'Updated: House rules', text: 'Quiet hours start later.' };
    const proposal = log.propose('ana', { dispatch });
    log.vote('ana', proposal, 4);
    log.vote('ben', proposal, 4);
    log.minute += 1;
    log.result('ben', resultFor(only(log.state().proposals)));
    const now = log.minute + THIRTY_DAYS;
    const held = fold(log.records, now);

    const cleared = fold(withoutBallots(log.records, [proposal]), now, [], [proposal]);

    expect(held.dispatches).toHaveLength(1);
    expect(decisions(cleared)).toEqual(decisions(held));
  });
});

describe('cleared ballots across group lines (#100)', () => {
  const R = 29_375_000;

  /**
   * Group A (ana, ben) passes its reconcile Proposal; the coalition of A and
   * B forms; zed's motion opens in A, which passes it; kim, A's participant,
   * reports a fail for it, which A's own vote doesn't say; ana posts A's
   * results for both Proposals.
   */
  function crossed() {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben']);
    const reconcile = logs.reconcile('A', R + 3, 'ana', 'A');
    logs.vote('A', R + 4, 'ana', reconcile, 4);
    logs.vote('A', R + 5, 'ben', reconcile, 4);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    logs.vote('A', at + 2, 'ana', motion, 4);
    logs.vote('A', at + 3, 'ben', motion, 3);
    const owed = folded(foldLogs(logs.logs, at + 4), 'A').state;
    for (const id of [reconcile, motion]) {
      const proposal = owed.proposals.find((p) => p.id === id) ?? never();
      logs.add('A', at + 4, 'ana', { type: 'result', body: resultFor(proposal) });
    }
    logs.result(at + 5, 'kim', motion, 'A', 'fail');
    return { logs, reconcile, motion, now: at + 3 + THIRTY_DAYS };
  }

  it('reports and flags the same results for A’s seat once A has cleared both votes', () => {
    const { logs, reconcile, motion, now } = crossed();
    const held = foldLogs(logs.logs, now);
    const ids = [reconcile, motion];
    const kept = { ...logs.logs, A: withoutBallots(logs.logs.A ?? [], ids) };

    const cleared = foldLogs(kept, now, { A: ids });

    const before = folded(held, 'A').state;
    const after = folded(cleared, 'A').state;
    expect(after.proposals.filter((p) => p.cleared).map((p) => p.id)).toEqual(ids);
    expect(decisions(after)).toEqual(decisions(before));
    expect(after.coalitions).toEqual(before.coalitions);
    const coalition = folded(cleared, 'coalition').state;
    const seat = seatOf(cleared, 'A');
    expect(resultsToReport(after, coalition, seat)).toEqual(
      resultsToReport(before, folded(held, 'coalition').state, seat),
    );
    const mismatches = resultMismatches(after, coalition, seat);
    expect(mismatches.map((r) => [r.motion, r.result])).toEqual([[motion, 'fail']]);
    expect(mismatches).toEqual(resultMismatches(before, folded(held, 'coalition').state, seat));
  });
});

function never(): never {
  throw new Error('Expected a Proposal.');
}

describe('the closing ballot’s place (#289)', () => {
  /** decidedLog with `body` posted as Ben's result the minute after the close. */
  function withResult(body: (held: Proposal) => ResultBody) {
    const decided = decidedLog();
    const { log, closedAt } = decided;
    const posted = body(only(log.state().proposals));
    log.minute = closedAt + 1;
    log.result('ben', posted);
    return { ...decided, posted };
  }

  /** The Proposal as a device that has cleared it folds it, its ballots gone. */
  function clearedProposal(records: readonly LogRecord[], proposalId: string): Proposal {
    const now = (records.at(-1)?.received ?? 0) + THIRTY_DAYS;
    return only(fold(withoutBallots(records, [proposalId]), now, [], [proposalId]).proposals);
  }

  it('is checked against the ballots held: the closing ballot’s seq counts and any other is flagged', () => {
    const named = withResult((held) => resultFor(held));
    expect(only(named.log.state().proposals)).toMatchObject({
      result: { closedAt: named.closedAt },
      mismatched: [],
    });
    expect(named.posted.closedSeq).toBe(named.closedSeq);

    const other = withResult((held) => ({ ...resultFor(held), closedSeq: named.closedSeq - 1 }));
    expect(only(other.log.state().proposals)).toMatchObject({
      result: null,
      mismatched: [authorOf('ben')],
    });
  });

  it('may be left out, as every result from before #289 does, and the result still counts', () => {
    const before = withResult((held) => {
      const { proposal, closedAt, eligible, versions, outcome, commit } = resultFor(held);
      return { proposal, closedAt, eligible, versions, outcome, commit };
    });
    expect(before.posted).not.toHaveProperty('closedSeq');
    expect(only(before.log.state().proposals)).toMatchObject({
      result: { closedAt: before.closedAt },
      mismatched: [],
    });
  });

  it('is flagged on a Proposal that closed at its deadline, which has no closing ballot', () => {
    const log = groupLog({ members: ['Ben'] });
    log.propose('ana');
    const deadline = deadlineOf(START_MINUTE);
    const body = resultFor(only(log.state(deadline).proposals));
    log.minute = deadline + 1;
    log.result('ben', { ...body, closedSeq: 3 });
    expect(only(log.state().proposals)).toMatchObject({
      result: null,
      mismatched: [authorOf('ben')],
    });
    log.result('ana', body);
    expect(only(log.state().proposals)).toMatchObject({ result: { author: authorOf('ana') } });
  });

  it('isn’t named for a deadline close, and a cleared result that names one there isn’t its record', () => {
    const log = groupLog({ members: ['Ben', 'Cal', 'Kim'] });
    const proposalId = log.propose('ana');
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposalId, 4);
    const deadline = deadlineOf(START_MINUTE);
    const held = only(log.state(deadline).proposals);
    expect(held).toMatchObject({ closedAt: null, final: true, outcome: { kind: 'pass' } });
    const body = resultFor(held);
    expect(body).not.toHaveProperty('closedSeq');
    log.minute = deadline + 1;
    // The last ballot's seq, between the Proposal's and the result's, on a close that wasn't early.
    log.result('ben', { ...body, closedSeq: log.records.length });
    expect(only(log.state().proposals)).toMatchObject({
      result: null,
      mismatched: [authorOf('ben')],
    });
    expect(clearedProposal(log.records, proposalId)).toMatchObject({
      closedAt: null,
      result: null,
      outcome: { kind: 'lapse' },
    });
  });

  it('when a result names none, as before #289, keeps a cleared Proposal open until its close’s minute', () => {
    const log = groupLog({ members: ['Ben'] });
    const first = log.propose('ana');
    log.minute += 1;
    log.vote('ana', first, 4);
    const second = log.propose('ana', { text: 'Quiet after midnight.' });
    log.minute += 1;
    log.vote('ben', first, 4);
    const held = only(log.state().proposals);
    const { proposal, closedAt, eligible, versions, outcome, commit } = resultFor(held);
    log.minute += 1;
    log.result('ana', { proposal, closedAt, eligible, versions, outcome, commit });

    const state = fold(withoutBallots(log.records, [first]), log.minute, [], [first]);

    expect(state.proposals.map((p) => [p.id, p.closedAt])).toEqual([[first, closedAt]]);
    expect(state.ignored.map((record) => record.id)).toEqual([second]);
  });

  it('is read ahead on a cleared device only between the Proposal’s seq and the result’s own', () => {
    // decidedLog's Proposal is seq 3, its ballots 4 and 5, and the result 6.
    const closesAt = (closedSeq: number) => {
      const { log, proposalId } = withResult((held) => ({ ...resultFor(held), closedSeq }));
      return clearedProposal(log.records, proposalId).closedAt;
    };
    const { closedAt } = decidedLog();
    expect(closesAt(3)).toBeNull();
    expect(closesAt(4)).toBe(closedAt);
    expect(closesAt(5)).toBe(closedAt);
    expect(closesAt(6)).toBeNull();
  });

  it('closes a cleared Proposal right after it, so the record at that seq still finds it open', () => {
    const log = groupLog({ members: ['Ben'] });
    const first = log.propose('ana');
    log.minute += 1;
    log.vote('ana', first, 4);
    log.minute += 1;
    const second = log.propose('ana', { text: 'Quiet after midnight.' });
    const atSecond = log.records.length;
    log.vote('ben', first, 4);
    const third = log.propose('ben', { text: 'Quiet after 9pm.' });
    const held = only(log.state().proposals.filter((p) => p.id === first));
    log.minute += 1;
    // A result that names the second Proposal's seq as the closing ballot's.
    log.result('ana', { ...resultFor(held), closedSeq: atSecond });

    const state = fold(withoutBallots(log.records, [first]), log.minute, [], [first]);

    expect(state.proposals.map((p) => p.id)).toEqual([first, third]);
    expect(state.ignored.map((record) => record.id)).toEqual([second]);
  });

  it('puts a version in the close’s minute on a cleared ballot by place alone, even one the result lists', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana');
    log.minute += 1;
    const before = log.version('ana', proposalId, 'Quiet after 9pm.');
    log.ballot('ana', proposalId, { [proposalId]: 4, [before]: 3 });
    log.ballot('ben', proposalId, { [proposalId]: 4, [before]: 4 });
    const after = log.version('ben', proposalId, 'Quiet after 8pm.');
    const held = only(log.state().proposals);
    expect(held.versions.map((v) => v.id)).toEqual([proposalId, before]);
    const honest = resultFor(held);
    const listed = {
      ...honest,
      versions: [...honest.versions, { id: after, counts: [0, 0, 0, 0, 2] as const }],
    };

    const kept = withResultBody(log, honest);
    const lying = withResultBody(log, listed);

    expect(clearedProposal(kept.records, proposalId)).toMatchObject({
      versions: [{ id: proposalId }, { id: before }],
      closedAt: held.closedAt,
      outcome: { kind: 'pass', version: proposalId },
    });
    // The later version finds it closed, so the result lists a version it doesn't have and isn't
    // its record: with none, the Proposal has no early close, as #111 has it, and stays open.
    expect(clearedProposal(lying.records, proposalId)).toMatchObject({
      versions: [{ id: proposalId }, { id: before }, { id: after }],
      closedAt: null,
      result: null,
    });
  });

  it('gives a cleared Proposal decided at its deadline no early close', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana');
    const deadline = deadlineOf(START_MINUTE);
    log.minute = deadline + 1;
    log.result('ben', resultFor(only(log.state(deadline).proposals)));
    expect(clearedProposal(log.records, proposalId)).toMatchObject({
      closedAt: null,
      final: true,
      outcome: { kind: 'lapse' },
    });
  });
});

/** A copy of `log`'s records with `body` posted as Ana's result the minute after the last. */
function withResultBody(log: ReturnType<typeof groupLog>, body: ResultBody) {
  const at = (log.records.at(-1)?.received ?? 0) + 1;
  const { record } = signedAs('ana', { type: 'result', group: log.group, ts: 0, body });
  return {
    records: [...log.records, { seq: log.records.length + 1, received: at, bytes: record }],
  };
}
