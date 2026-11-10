import { describe, expect, it } from 'vitest';

import { authorOf, signedAs } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { utf8 } from '../test/bytes';
import { ballotCommit, commitEntries } from './commit';
import { parseRecord } from './event';
import {
  ballotsExpireAt,
  ballotsExpired,
  closeMinute,
  EXPIRES_WITH_BALLOTS,
  expiringProposal,
  expiryKeyOf,
  needsResult,
  recordedOutcome,
  resultFor,
} from './expiry';
import { fold, type Proposal } from './fold';
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
  return { log, proposalId, closedAt };
}

function only(proposals: readonly Proposal[]): Proposal {
  const [proposal] = proposals;
  if (proposal === undefined) throw new Error('Expected one Proposal.');
  return proposal;
}

describe('resultFor', () => {
  it('records the close, the eligible count, each version’s counts, the outcome and the commitment', () => {
    const { log, proposalId, closedAt } = decidedLog();
    const proposal = only(log.state().proposals);
    expect(resultFor(proposal)).toEqual({
      proposal: proposalId,
      closedAt,
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
    expect(closeMinute(proposal)).toBe(deadline);
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
      needsResult(only(fold(log.records, closedAt + 5, [body.proposal]).proposals), closedAt + 5),
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

  it('never clears without a valid result, nor clears twice', () => {
    const { log, closedAt, proposalId } = decidedLog();
    expect(ballotsExpired(DEFAULT_RULES, only(log.state().proposals), closedAt + THIRTY_DAYS)).toBe(
      false,
    );
    log.minute = closedAt + 1;
    log.result('ana', resultFor(only(log.state().proposals)));
    const cleared = only(fold(log.records, closedAt + THIRTY_DAYS, [proposalId]).proposals);
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
