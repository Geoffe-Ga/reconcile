import { describe, expect, it } from 'vitest';

import { Logs } from '../test/coalitions';
import { authorOf, signedAs } from '../test/keys';
import { can, DEFAULT_JOIN_LEVEL, FOUNDER_LEVEL, LEVELS } from './capabilities';
import type { EventDraft, ProposalBody, VoteBody } from './event';
import { fold, type LogRecord, NOTE_MAX, proposalTally, TITLE_MAX, WHY_MAX } from './fold';
import { DEFAULT_RULES, defaultWindowMinutes } from './rules';
import { EMPTY_SEATS } from './stewards';

/** The creating level, for a joiner who proposes. */
const [, , CREATING] = LEVELS;

const R = 29_375_000;
/** How long an ordinary vote runs when no one chooses, in relay minutes. */
const WINDOW = defaultWindowMinutes(DEFAULT_RULES, 'ordinary');

/** Builds a relay-ordered log of events, one seq per event, each signed by its author's test key. */
class TestLog {
  readonly records: LogRecord[] = [];
  group = '';

  add(received: number, author: string, draft: EventDraft): string {
    const { record, id } = signedAs(author, draft);
    this.records.push({ seq: this.records.length + 1, received, bytes: record });
    return id;
  }

  genesis(received: number, chat?: string): string {
    const documents = [{ title: 'House rules', atoms: ['A0', 'A1'] }];
    const body = { name: 'Riverside', founder: 'Ana', documents };
    const withChat = chat === undefined ? body : { ...body, chat };
    const ts = received * 60_000;
    this.group = this.add(received, 'ana', { type: 'genesis', group: '', ts, body: withChat });
    return this.group;
  }

  join(received: number, author: string, level?: string): string {
    const ts = received * 60_000;
    const body = { name: author, ...(level === undefined ? {} : { level }) };
    return this.add(received, author, { type: 'join', group: this.group, ts, body });
  }

  level(received: number, author: string, level: string): string {
    const ts = received * 60_000;
    return this.add(received, author, { type: 'level', group: this.group, ts, body: { level } });
  }

  propose(received: number, author: string, body: Partial<ProposalBody> = {}): string {
    const full = { atom: `${this.group}.0`, title: 'T', why: 'W', text: 'New', ...body };
    const ts = received * 60_000;
    return this.add(received, author, { type: 'proposal', group: this.group, ts, body: full });
  }

  vote(received: number, author: string, body: VoteBody): string {
    const ts = received * 60_000;
    return this.add(received, author, { type: 'vote', group: this.group, ts, body });
  }

  version(received: number, author: string, proposal: string, text: string): string {
    const ts = received * 60_000;
    const body = { proposal, text };
    return this.add(received, author, { type: 'version', group: this.group, ts, body });
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
  it('pins the text caps', () => {
    expect(TITLE_MAX).toBe(120);
    expect(WHY_MAX).toBe(2_000);
    expect(NOTE_MAX).toBe(280);
  });
});

describe('fold', () => {
  it('folds an empty log to an empty group', () => {
    expect(fold([], null)).toEqual({
      group: null,
      rules: DEFAULT_RULES,
      optIns: { chatBot: null, frontDoor: false },
      name: '',
      chat: null,
      documents: [],
      members: [],
      former: [],
      atoms: [],
      proposals: [],
      at: 0,
      stewards: EMPTY_SEATS,
      suspensions: [],
      removals: [],
      responses: [],
      narrowings: [],
      vouches: [],
      chatPosts: [],
      doorInvites: [],
      doorClosure: null,
      exposedDoors: [],
      chatThreads: [],
      dispatches: [],
      epoch: 0,
      rotations: [],
      rotationDue: false,
      dissolved: null,
      recoveryShares: [],
      recoveryAlerts: [],
      recoveryCancels: [],
      coalitions: [],
      coalition: null,
      focus: null,
      founding: null,
      ignored: [],
    });
  });

  it('keeps where the Documents began: the genesis’s receipt, its founder and every founded Atom’s founding text (#104)', () => {
    const log = new TestLog();
    const documents = [
      { title: 'House rules', atoms: ['A0', 'A1'] },
      { title: 'Budget', atoms: ['B0'] },
    ];
    const body = { name: 'Riverside', founder: 'Ana', documents };
    const group = log.add(R, 'ana', { type: 'genesis', group: '', ts: 0, body });
    log.group = group;
    log.join(R + 1, 'ben');
    const edit = log.propose(R + 10, 'ana', { atom: `${group}.0`, text: 'Changed' });
    log.vote(R + 11, 'ana', { proposal: edit, scores: { [edit]: 4 } });
    log.vote(R + 12, 'ben', { proposal: edit, scores: { [edit]: 4 } });
    const removal = log.propose(R + 20, 'ana', { atom: `${group}:1.0`, text: '' });
    log.vote(R + 21, 'ana', { proposal: removal, scores: { [removal]: 4 } });
    log.vote(R + 22, 'ben', { proposal: removal, scores: { [removal]: 4 } });
    const state = fold(log.records, R + 30);
    expect(state.atoms.map((atom) => atom.text)).toEqual(['Changed', 'A1']);
    expect(state.founding).toEqual({
      received: R,
      author: authorOf('ana'),
      atoms: [
        { id: `${group}.0`, documentId: group, text: 'A0' },
        { id: `${group}.1`, documentId: group, text: 'A1' },
        { id: `${group}:1.0`, documentId: `${group}:1`, text: 'B0' },
      ],
    });
  });

  it('names no founder for a coalition, whose genesis author isn’t a participant (#100, #104)', () => {
    const logs = new Logs();
    const coalition = logs.coalition(R, ['Riverside', 'Oak St']);
    const { founding } = fold(logs.logs.coalition ?? [], R);
    expect(founding).toEqual({
      received: R,
      author: null,
      atoms: [{ id: `${coalition}.0`, documentId: coalition, text: 'We keep the river clean.' }],
    });
  });

  it('keeps no founding for a genesis it ignores (#104)', () => {
    const log = new TestLog();
    const body = { name: 'Riverside', founder: 'Ana', documents: [] };
    log.add(R, 'ana', { type: 'genesis', group: '', ts: 0, body });
    expect(fold(log.records, R).founding).toBeNull();
  });

  it('stands at relayNow, or at the latest receipt when there is none yet (#102)', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 5, 'ben');
    expect(fold(log.records, R + 99).at).toBe(R + 99);
    expect(fold(log.records, null).at).toBe(R + 5);
    expect(fold([...log.records].reverse(), null).at).toBe(R + 5);
  });

  it('seats the founder in seat 1 at genesis, with no term, and leaves seat 2 empty (#102)', () => {
    const log = new TestLog();
    log.genesis(R);
    expect(fold(log.records, R).stewards).toEqual([
      { seat: 1, holder: authorOf('ana'), termEnd: null, elected: false },
      { seat: 2, holder: null, termEnd: null, elected: false },
    ]);
  });

  it('carries a steward Proposal’s fields: its target, no text, one version, ordinary (#102)', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben', CREATING);
    log.join(R + 2, 'cal');
    const target = { kind: 'steward' as const, seat: 1, member: authorOf('ben') };
    const body = { target, title: 'Ben for steward', why: 'Calm.', link: 'https://chat.example/s' };
    const id = log.add(R + 10, 'ben', { type: 'proposal', group: log.group, ts: 0, body });
    expect(fold(log.records, R + 10).proposals).toEqual([
      {
        id,
        seq: 4,
        received: R + 10,
        number: 1,
        author: authorOf('ben'),
        atom: '',
        target: { ...target, holder: authorOf('ana') },
        title: 'Ben for steward',
        why: 'Calm.',
        text: '',
        link: 'https://chat.example/s',
        class: 'ordinary',
        window: 7,
        deadline: R + 10 + 10_080,
        eligible: ['ana', 'ben', 'cal'].map(authorOf),
        versions: [{ id, author: authorOf('ben'), text: '' }],
        ballots: [],
        closedAt: null,
        final: false,
        outcome: { kind: 'lapse', bar: DEFAULT_RULES.bars.ordinary },
        dispatch: null,
        result: null,
        cleared: false,
        mismatched: [],
      },
    ]);
  });

  it('carries a suspension’s fields, its reason kept as written (#102)', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'kim');
    const body = { member: authorOf('kim'), reason: '  <b>Threats</b> in chat  ' };
    const id = log.add(R + 10, 'ana', { type: 'suspend', group: log.group, ts: 0, body });
    expect(fold(log.records, R + 10).suspensions).toEqual([
      {
        id,
        seq: 3,
        received: R + 10,
        by: authorOf('ana'),
        member: authorOf('kim'),
        reason: '  <b>Threats</b> in chat  ',
        until: R + 10 + 10_080,
        removal: null,
      },
    ]);
  });

  it('records a genesis without a chat link as null', () => {
    const log = new TestLog();
    log.genesis(R);
    expect(fold(log.records, R).chat).toBeNull();
  });

  it('makes the founder a Co-Creator and a joiner who names no level a Collaborator', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben');
    const state = fold(log.records, R + 1);
    expect(state.members.map((m) => m.level)).toEqual([FOUNDER_LEVEL, DEFAULT_JOIN_LEVEL]);
    expect(can(state, authorOf('ana'), 'propose')).toBe(true);
    expect(can(state, authorOf('ben'), 'vote')).toBe(true);
    expect(can(state, authorOf('ben'), 'propose')).toBe(false);
    expect(can(state, authorOf('cal'), 'read')).toBe(false);
  });

  it.each(LEVELS)('admits a joiner at the level %s they name', (level) => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben', level);
    expect(fold(log.records, R + 1).members[1]).toEqual({
      author: authorOf('ben'),
      name: 'ben',
      level,
      seq: 2,
      received: R + 1,
      invitedBy: null,
      rightsAt: R + 1,
      kx: null,
    });
  });

  it('moves a member to each level they choose, in order, keeping their name and seq', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben');
    const [follow, , create] = LEVELS;
    log.level(R + 2, 'ben', create);
    log.level(R + 3, 'ben', follow);
    const state = fold(log.records, R + 3);
    expect(state.members[1]).toEqual({
      author: authorOf('ben'),
      name: 'ben',
      level: follow,
      seq: 2,
      received: R + 1,
      invitedBy: null,
      rightsAt: R + 1,
      kx: null,
    });
    expect(state.ignored).toEqual([]);
    expect(can(state, authorOf('ben'), 'vote')).toBe(false);
  });

  it('leaves the other members alone when one changes level', () => {
    const log = new TestLog();
    log.genesis(R);
    log.join(R + 1, 'ben');
    log.join(R + 2, 'cal');
    log.level(R + 3, 'cal', 'admin');
    const [follow] = LEVELS;
    log.level(R + 4, 'ben', follow);
    const state = fold(log.records, R + 4);
    expect(state.members.map((m) => m.level)).toEqual([FOUNDER_LEVEL, follow, DEFAULT_JOIN_LEVEL]);
    expect(state.ignored.map((record) => record.seq)).toEqual([4]);
  });

  it('snapshots who would vote when a Proposal opens, and keeps that set after a level change', () => {
    const log = new TestLog();
    log.genesis(R);
    const [follow] = LEVELS;
    log.join(R + 1, 'ben', follow);
    log.join(R + 2, 'cal');
    const proposal = log.propose(R + 10, 'ana');
    log.level(R + 11, 'ben', DEFAULT_JOIN_LEVEL);
    log.level(R + 12, 'cal', follow);
    const state = fold(log.records, R + 12);
    expect(state.proposals.find((p) => p.id === proposal)?.eligible).toEqual([
      authorOf('ana'),
      authorOf('cal'),
    ]);
  });

  it('carries a Proposal’s fields, its class, its window, its one version and its deadline', () => {
    const { log, proposal } = threeMembersAndAProposal({ link: 'https://chat.example/p' });
    expect(fold(log.records, R + 10).proposals).toEqual([
      {
        id: proposal,
        seq: 4,
        received: R + 10,
        number: 1,
        author: authorOf('ana'),
        atom: `${log.group}.0`,
        target: { kind: 'edit' },
        title: 'T',
        why: 'W',
        text: 'New',
        link: 'https://chat.example/p',
        class: 'ordinary',
        window: 7,
        deadline: R + 10 + 10_080,
        eligible: ['ana', 'ben', 'cal'].map(authorOf),
        versions: [{ id: proposal, author: authorOf('ana'), text: 'New' }],
        ballots: [],
        closedAt: null,
        final: false,
        outcome: { kind: 'lapse', bar: DEFAULT_RULES.bars.ordinary },
        dispatch: null,
        result: null,
        cleared: false,
        mismatched: [],
      },
    ]);
  });

  it('records a Proposal without a link as null', () => {
    const { log } = threeMembersAndAProposal();
    expect(fold(log.records, R + 10).proposals[0]?.link).toBeNull();
  });

  it('carries each ballot’s id, place in the log, voter, scores, note and salt', () => {
    const { log, proposal } = threeMembersAndAProposal();
    const salt = 'AQIDBAUGBwgJCgsMDQ4PEA';
    const ballot = log.vote(R + 20, 'ben', { proposal, scores: { [proposal]: 0 }, note: 'No.' });
    const salted = log.vote(R + 21, 'cal', { proposal, scores: { [proposal]: 3 }, salt });
    expect(fold(log.records, R + 21).proposals[0]?.ballots).toEqual([
      {
        id: ballot,
        seq: 5,
        received: R + 20,
        voter: authorOf('ben'),
        scores: { [proposal]: 0 },
        note: 'No.',
        salt: '',
      },
      {
        id: salted,
        seq: 6,
        received: R + 21,
        voter: authorOf('cal'),
        scores: { [proposal]: 3 },
        note: null,
        salt,
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
    expect(state.proposals[0]?.ballots.map((b) => b.voter)).toEqual([authorOf('ben')]);
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
    const deadline = R + 10 + WINDOW;
    log.vote(deadline - 1, 'ben', { proposal, scores: { [proposal]: 4 } });
    log.vote(deadline, 'cal', { proposal, scores: { [proposal]: 4 } });
    const state = fold(log.records, deadline);
    expect(state.proposals[0]?.ballots.map((b) => b.voter)).toEqual([authorOf('ben')]);
    expect(state.ignored.map((i) => i.seq)).toEqual([6]);
  });

  it('leaves the records it was given untouched', () => {
    const { log, proposal } = threeMembersAndAProposal();
    log.vote(R + 20, 'ana', { proposal, scores: { [proposal]: 4 } });
    const copy = log.records.map((r) => ({ ...r, bytes: r.bytes.slice() }));
    fold(log.records, R + 20 + WINDOW);
    expect(log.records).toEqual(copy);
  });
});

describe('proposalTally', () => {
  it('tallies each version’s latest scores, in ballot order, as the fold settles the outcome', () => {
    const { log, proposal } = threeMembersAndAProposal();
    const second = log.version(R + 11, 'ana', proposal, 'Other');
    log.vote(R + 20, 'ana', { proposal, scores: { [proposal]: 4, [second]: 1 } });
    log.vote(R + 21, 'ben', { proposal, scores: { [proposal]: 0, [second]: 3 }, note: 'No.' });
    log.vote(R + 22, 'ben', { proposal, scores: { [proposal]: 2, [second]: 3 } });
    const open = fold(log.records, R + 30).proposals[0];
    if (open === undefined) throw new Error('Expected the Proposal.');
    const detail = proposalTally(open);
    expect(detail.bar).toEqual(DEFAULT_RULES.bars.ordinary);
    expect(
      detail.versions.map(({ id, scorers, sum, zeros, quorum }) => ({
        id,
        scorers,
        sum,
        zeros,
        quorum,
      })),
    ).toEqual([
      { id: proposal, scorers: 2, sum: 6, zeros: 0, quorum: 3 },
      { id: second, scorers: 2, sum: 4, zeros: 0, quorum: 3 },
    ]);
    expect(detail.outcome).toEqual(open.outcome);
    expect(detail.outcome).toEqual({ kind: 'lapse', bar: DEFAULT_RULES.bars.ordinary });
  });
});
