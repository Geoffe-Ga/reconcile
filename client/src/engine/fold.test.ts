import { describe, expect, it } from 'vitest';

import { can } from './capabilities';
import { createEvent, type EventInput, type ProposalBody, type VoteBody } from './event';
import { fold, type LogRecord, NOTE_MAX, TITLE_MAX, VOTE_WINDOW_MINUTES, WHY_MAX } from './fold';

const R = 29_375_000;

/** Builds a relay-ordered log of events, one seq per event. */
class TestLog {
  readonly records: LogRecord[] = [];
  group = '';

  private add(received: number, input: EventInput): string {
    const { bytes, id } = createEvent(input);
    this.records.push({ seq: this.records.length + 1, received, bytes });
    return id;
  }

  genesis(received: number, chat?: string): string {
    const body = { name: 'Riverside', founder: 'Ana', title: 'House rules', atoms: ['A0', 'A1'] };
    const withChat = chat === undefined ? body : { ...body, chat };
    const ts = received * 60_000;
    this.group = this.add(received, {
      type: 'genesis',
      group: '',
      author: 'ana',
      ts,
      body: withChat,
    });
    return this.group;
  }

  join(received: number, author: string): string {
    const ts = received * 60_000;
    return this.add(received, {
      type: 'join',
      group: this.group,
      author,
      ts,
      body: { name: author },
    });
  }

  propose(received: number, author: string, body: Partial<ProposalBody> = {}): string {
    const full = { atom: `${this.group}.0`, title: 'T', why: 'W', text: 'New', ...body };
    const ts = received * 60_000;
    return this.add(received, { type: 'proposal', group: this.group, author, ts, body: full });
  }

  vote(received: number, author: string, body: VoteBody): string {
    const ts = received * 60_000;
    return this.add(received, { type: 'vote', group: this.group, author, ts, body });
  }
}

/** A group of ana (founder), ben and cal, with one Proposal by ana at R + 10. */
function threeMembersAndAProposal(body: Partial<ProposalBody> = {}): {
  log: TestLog;
  proposal: string;
} {
  const log = new TestLog();
  log.genesis(R);
  log.join(R + 1, 'ben');
  log.join(R + 2, 'cal');
  return { log, proposal: log.propose(R + 10, 'ana', body) };
}

describe('fold constants', () => {
  it('pins the vote window and the text caps', () => {
    expect(VOTE_WINDOW_MINUTES).toBe(10_080);
    expect(TITLE_MAX).toBe(120);
    expect(WHY_MAX).toBe(2_000);
    expect(NOTE_MAX).toBe(280);
  });
});

describe('fold', () => {
  it('folds an empty log to an empty group', () => {
    expect(fold([], null)).toEqual({
      group: null,
      name: '',
      chat: null,
      title: '',
      members: [],
      atoms: [],
      proposals: [],
      ignored: [],
    });
  });

  it('records a genesis without a chat link as null', () => {
    const log = new TestLog();
    log.genesis(R);
    expect(fold(log.records, R).chat).toBeNull();
  });

  it('makes every member hold the MVP level, so can() lets them act', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben');
    const state = fold(log.records, R + 1);
    expect(can(state, 'ana', 'propose')).toBe(true);
    expect(can(state, 'ben', 'vote')).toBe(true);
    expect(can(state, 'cal', 'read')).toBe(false);
  });

  it('carries a Proposal’s fields, its one version and its deadline', () => {
    const { log, proposal } = threeMembersAndAProposal({ link: 'https://chat.example/p' });
    expect(fold(log.records, R + 10).proposals).toEqual([
      {
        id: proposal,
        seq: 4,
        received: R + 10,
        author: 'ana',
        atom: `${log.group}.0`,
        title: 'T',
        why: 'W',
        text: 'New',
        link: 'https://chat.example/p',
        deadline: R + 10 + 10_080,
        eligible: ['ana', 'ben', 'cal'],
        versions: [{ id: proposal, author: 'ana', text: 'New' }],
        ballots: [],
        closedAt: null,
        final: false,
        outcome: { kind: 'lapse' },
      },
    ]);
  });

  it('records a Proposal without a link as null', () => {
    const { log } = threeMembersAndAProposal();
    expect(fold(log.records, R + 10).proposals[0]?.link).toBeNull();
  });

  it('carries each ballot’s id, place in the log, voter, scores and note', () => {
    const { log, proposal } = threeMembersAndAProposal();
    const ballot = log.vote(R + 20, 'ben', { proposal, scores: { [proposal]: 0 }, note: 'No.' });
    expect(fold(log.records, R + 20).proposals[0]?.ballots).toEqual([
      {
        id: ballot,
        seq: 5,
        received: R + 20,
        voter: 'ben',
        scores: { [proposal]: 0 },
        note: 'No.',
      },
    ]);
  });

  it('accepts a justification of exactly 2,000 code points and ignores one more', () => {
    const { log } = threeMembersAndAProposal({ why: '\u{1F600}'.repeat(2_000) });
    log.propose(R + 11, 'ana', { why: 'w'.repeat(2_001) });
    const state = fold(log.records, R + 11);
    expect(state.proposals.map((p) => p.seq)).toEqual([4]);
    expect(state.ignored.map((i) => i.seq)).toEqual([5]);
  });

  it('accepts a 120 code point title of astral characters', () => {
    const { log } = threeMembersAndAProposal({ title: '\u{1F600}'.repeat(120) });
    expect(fold(log.records, R + 10).proposals).toHaveLength(1);
  });

  it('accepts a note of exactly 280 code points and ignores one more', () => {
    const { log, proposal } = threeMembersAndAProposal();
    log.vote(R + 20, 'ben', { proposal, scores: { [proposal]: 3 }, note: '\u{1F600}'.repeat(280) });
    log.vote(R + 21, 'cal', { proposal, scores: { [proposal]: 3 }, note: 'n'.repeat(281) });
    const state = fold(log.records, R + 21);
    expect(state.proposals[0]?.ballots.map((b) => b.voter)).toEqual(['ben']);
    expect(state.ignored.map((i) => i.seq)).toEqual([6]);
  });

  it('accepts a 0 with a one-character reason', () => {
    const { log, proposal } = threeMembersAndAProposal();
    log.vote(R + 20, 'ben', { proposal, scores: { [proposal]: 0 }, note: ' x ' });
    expect(fold(log.records, R + 20).proposals[0]?.ballots).toHaveLength(1);
  });

  it('never closes by deadline without relay time, but an early close is still final', () => {
    const { log, proposal } = threeMembersAndAProposal();
    log.vote(R + 20, 'ana', { proposal, scores: { [proposal]: 4 } });
    log.vote(R + 21, 'ben', { proposal, scores: { [proposal]: 4 } });
    log.vote(R + 22, 'cal', { proposal, scores: { [proposal]: 4 } });
    const open = fold(log.records.slice(0, 5), null).proposals[0];
    expect(open?.final).toBe(false);
    const closed = fold(log.records, null).proposals[0];
    expect(closed?.closedAt).toBe(R + 22);
    expect(closed?.final).toBe(true);
    expect(fold(log.records, null).atoms[0]?.text).toBe('New');
  });

  it('accepts a ballot one minute before the deadline and ignores one at the deadline', () => {
    const { log, proposal } = threeMembersAndAProposal();
    const deadline = R + 10 + VOTE_WINDOW_MINUTES;
    log.vote(deadline - 1, 'ben', { proposal, scores: { [proposal]: 4 } });
    log.vote(deadline, 'cal', { proposal, scores: { [proposal]: 4 } });
    const state = fold(log.records, deadline);
    expect(state.proposals[0]?.ballots.map((b) => b.voter)).toEqual(['ben']);
    expect(state.ignored.map((i) => i.seq)).toEqual([6]);
  });

  it('leaves the records it was given untouched', () => {
    const { log, proposal } = threeMembersAndAProposal();
    log.vote(R + 20, 'ana', { proposal, scores: { [proposal]: 4 } });
    const copy = log.records.map((r) => ({ ...r, bytes: r.bytes.slice() }));
    fold(log.records, R + 20 + VOTE_WINDOW_MINUTES);
    expect(log.records).toEqual(copy);
  });
});
