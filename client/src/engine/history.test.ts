import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, type GroupStart, type LogBuilder } from '../test/votes';
import { HORIZON_STEP_MINUTES } from './coalition';
import { parseRecord, type Score } from './event';
import { expiringProposal, resultFor } from './expiry';
import { fold, type GroupState, type LogRecord, proposalTally } from './fold';
import { changeLog, describeChange, sectionHistory } from './history';

/** Ana, Ben and Cal, each holding a vote from the log's current minute. */
function threeOfUs(start: GroupStart = {}): LogBuilder {
  return groupLog({ members: ['Ben', 'Cal'], ...start });
}

const VOTERS = ['Ana', 'Ben', 'Cal'];

/** Each of `voters` scores `proposal`'s one version `score`, a minute apart, which closes it early. */
function everyone(log: LogBuilder, proposal: string, score: Score, voters = VOTERS): void {
  for (const voter of voters) {
    log.minute += 1;
    log.vote(voter, proposal, score, score === 0 ? 'Not this.' : undefined);
  }
}

/** The Proposal `id` in `state`, failing the test when there's none. */
function proposalIn(state: GroupState, id: string) {
  const found = state.proposals.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no Proposal ${id}`);
  return found;
}

/** The text of the Atom `id` folded from `records` up to relay minute `minute`, or "" once it's gone. */
function textAt(records: readonly LogRecord[], minute: number, id: string): string {
  const upTo = records.filter((record) => record.received <= minute);
  return fold(upTo, minute).atoms.find((atom) => atom.id === id)?.text ?? '';
}

/**
 * Section 1's story: founded as "Quiet hours start at ten.", Quiet hours passes, No quiet
 * hours fails, Quiet at nine lapses, then Quiet at midnight passes on Ben's version.
 */
function sectionOneStory() {
  const log = threeOfUs();
  const founded = log.records[0]?.received ?? 0;
  const section = `${log.group}.0`;
  const quiet = log.propose('Ana', {
    title: 'Quiet hours',
    why: 'We sleep early.',
    text: 'Quiet after 10pm.\n',
  });
  everyone(log, quiet, 4);
  const quietClosed = log.minute;
  log.minute += 10;
  const none = log.propose('Ben', { title: 'No quiet hours', why: 'Adults.', text: 'Noise.\n' });
  everyone(log, none, 0);
  const noneClosed = log.minute;
  log.minute += 10;
  const nine = log.propose('Cal', { title: 'Quiet at nine', why: 'Kids.', text: 'Nine.\n' });
  const nineDeadline = deadlineOf(log.minute);
  log.minute = nineDeadline + 5;
  const midnight = log.propose('Ana', {
    title: 'Quiet at midnight',
    why: 'Summer nights.',
    text: 'Quiet after midnight.\n',
  });
  log.minute += 1;
  const bens = log.version('Ben', midnight, 'Quiet after 11pm on weekdays.\n');
  for (const [voter, mine, his] of [
    ['Ana', 2, 4],
    ['Ben', 2, 4],
    ['Cal', 3, 3],
  ] as const) {
    log.minute += 1;
    log.ballot(voter, midnight, { [midnight]: mine, [bens]: his });
  }
  const midnightClosed = log.minute;
  log.minute += 1;
  const state = log.state();
  return {
    log,
    state,
    section,
    founded,
    ids: { quiet, none, nine, midnight, bens },
    closed: { quiet: quietClosed, none: noneClosed, nine: nineDeadline, midnight: midnightClosed },
  };
}

describe('sectionHistory', () => {
  it('lists the two passes, newest first, then the founding text, and the fail and lapse apart', () => {
    const { state, section, founded, ids, closed } = sectionOneStory();
    const history = sectionHistory(state, section);
    expect(history.passed).toEqual([
      {
        proposalId: ids.midnight,
        title: 'Quiet at midnight',
        why: 'Summer nights.',
        decidedAt: closed.midnight,
        text: 'Quiet after 11pm on weekdays.\n',
        author: authorOf('ben'),
        totals: { scorers: 3, sum: 11, zeros: 0, quorum: 3 },
        groups: null,
        change: { kind: 'changed', quote: 'Quiet after 10pm.\n' },
      },
      {
        proposalId: ids.quiet,
        title: 'Quiet hours',
        why: 'We sleep early.',
        decidedAt: closed.quiet,
        text: 'Quiet after 10pm.\n',
        author: authorOf('ana'),
        totals: { scorers: 3, sum: 12, zeros: 0, quorum: 3 },
        groups: null,
        change: { kind: 'changed', quote: 'Quiet hours start at ten.' },
      },
      {
        proposalId: null,
        title: null,
        why: null,
        decidedAt: founded,
        text: 'Quiet hours start at ten.',
        author: authorOf('ana'),
        totals: null,
        groups: null,
        change: { kind: 'founded' },
      },
    ]);
    expect(history.notPassed).toEqual([
      { proposalId: ids.nine, title: 'Quiet at nine', outcome: 'lapse', decidedAt: closed.nine },
      { proposalId: ids.none, title: 'No quiet hours', outcome: 'fail', decidedAt: closed.none },
    ]);
  });

  it('gives each entry the text its section read right after that decision', () => {
    const { log, section } = sectionOneStory();
    const { passed } = sectionHistory(log.state(), section);
    expect(passed).toHaveLength(3);
    for (const entry of passed) {
      expect(entry.text).toBe(textAt(log.records, entry.decidedAt, section));
    }
  });

  it('reads nothing that isn’t final: an open Proposal is in neither list', () => {
    const log = threeOfUs();
    const section = `${log.group}.0`;
    const open = log.propose('Ana', { text: 'Open still.\n' });
    log.minute += 1;
    log.vote('Ana', open, 4);
    const history = sectionHistory(log.state(), section);
    expect(history.passed.map((entry) => entry.proposalId)).toEqual([null]);
    expect(history.notPassed).toEqual([]);
  });

  it('begins a section an add created with that add, and ends a removed one with its removal', () => {
    const log = threeOfUs();
    const first = `${log.group}.0`;
    const add = log.addSection('Ben', first, {
      title: 'Guests',
      why: 'Guests come often.',
      text: 'Guests leave by 11pm.\n',
    });
    everyone(log, add, 4);
    const added = log.minute;
    log.minute += 5;
    const removal = log.propose('Cal', {
      atomId: add,
      title: 'No guest rule',
      why: 'Too strict.',
      text: '',
    });
    everyone(log, removal, 3);
    const removed = log.minute;
    const state = log.state(log.minute + 1);
    expect(state.atoms.some((atom) => atom.id === add)).toBe(false);
    const { passed } = sectionHistory(state, add);
    expect(passed.map((entry) => [entry.proposalId, entry.decidedAt, entry.text])).toEqual([
      [removal, removed, ''],
      [add, added, 'Guests leave by 11pm.\n'],
    ]);
    expect(passed.map((entry) => entry.change)).toEqual([
      { kind: 'removed', quote: 'Guests leave by 11pm.\n' },
      { kind: 'added' },
    ]);
    expect(passed[1]?.author).toBe(authorOf('ben'));
  });

  it('begins a section a passed new Document created with that Proposal', () => {
    const log = threeOfUs();
    const budget = log.newDocument('Cal', 'Budget', {
      title: 'Start a budget',
      why: 'We spend together.',
      text: '# Budget\n\nWe share costs.\n',
    });
    everyone(log, budget, 4);
    const state = log.state(log.minute + 1);
    for (const [i, text] of ['# Budget\n', 'We share costs.\n'].entries()) {
      const { passed, notPassed } = sectionHistory(state, `${budget}.${String(i)}`);
      expect(passed).toEqual([
        expect.objectContaining({
          proposalId: budget,
          title: 'Start a budget',
          text,
          author: authorOf('cal'),
          change: { kind: 'created' },
        }),
      ]);
      expect(notPassed).toEqual([]);
    }
  });

  it('reads a cleared Proposal’s totals from its result, the same as before its ballots went (#111)', () => {
    const log = threeOfUs();
    const section = `${log.group}.1`;
    const bins = log.propose('Ana', { atom: 1, title: 'Bins', text: 'Bins go out on Monday.\n' });
    log.minute += 1;
    log.vote('Ana', bins, 4);
    log.minute += 1;
    log.vote('Ben', bins, 3);
    log.minute += 1;
    log.vote('Cal', bins, 1, 'Monday is market day.');
    log.minute += 5;
    log.result('Ben', resultFor(proposalIn(log.state(), bins)));
    const now = log.minute + 1;
    const held = fold(log.records, now);
    const kept = log.records.filter((record) => {
      const event = parseRecord(record.bytes)?.event;
      return event === undefined || event.type !== 'vote' || expiringProposal(event) !== bins;
    });
    const cleared = fold(kept, now, [], [bins]);
    expect(proposalIn(cleared, bins).ballots).toEqual([]);
    const before = sectionHistory(held, section);
    const after = sectionHistory(cleared, section);
    expect(after).toEqual(before);
    expect(after.passed[0]).toMatchObject({
      proposalId: bins,
      totals: { scorers: 3, sum: 8, zeros: 0, quorum: 3 },
    });
  });

  it('takes a cleared archive’s totals from the tallies it kept (#108)', () => {
    const { state, section, ids } = sectionOneStory();
    const tally = proposalTally(proposalIn(state, ids.quiet));
    const [won] = tally.versions;
    if (won === undefined) throw new Error('Expected a version.');
    const kept = { [ids.quiet]: { ...tally, versions: [{ ...won, scorers: 5 }] } };
    const archived = { ...state, proposals: state.proposals.map((p) => ({ ...p, ballots: [] })) };
    expect(sectionHistory(archived, section).passed[1]?.totals?.scorers).toBe(0);
    const entry = sectionHistory(archived, section, kept).passed[1];
    expect(entry?.totals).toEqual({ scorers: 5, sum: 12, zeros: 0, quorum: 3 });
    // A kept tally that somehow lacks the winning version gives no totals, never another's.
    const lacking = { [ids.quiet]: { ...tally, versions: [] } };
    expect(sectionHistory(archived, section, lacking).passed[1]?.totals).toBeNull();
  });

  it('never lists a priority vote, a steward election or a rules change, which change no section (#107)', () => {
    const log = threeOfUs();
    const section = `${log.group}.0`;
    const focus = log.ask('Ana', ['Fix the gate', 'Paint the hall']);
    log.minute += 1;
    for (const voter of VOTERS) {
      log.ballot(voter, focus, { [`${focus}.0`]: 4, [`${focus}.1`]: 2 });
      log.minute += 1;
    }
    const steward = log.steward('Ana', 1, 'Ben');
    everyone(log, steward, 4);
    const state = log.state(log.minute + 1);
    expect(state.focus?.text).toBe('Fix the gate');
    expect(sectionHistory(state, section).passed.map((entry) => entry.proposalId)).toEqual([null]);
    expect(sectionHistory(state, focus)).toEqual({ passed: [], notPassed: [] });
    expect(changeLog(state, log.group).map((row) => row.proposalId)).toEqual([null]);
  });

  it('is empty for a section the group never had', () => {
    const log = threeOfUs();
    expect(sectionHistory(log.state(), 'nope.0')).toEqual({ passed: [], notPassed: [] });
    expect(sectionHistory(fold([], null), 'nope.0')).toEqual({ passed: [], notPassed: [] });
  });
});

describe('changeLog', () => {
  /** Two Documents: an edit and an add in the first, a removal in the second, and a failed edit. */
  function twoDocuments() {
    const log = threeOfUs({
      documents: [
        { title: 'House rules', atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.'] },
        { title: 'Budget', atoms: ['We share costs.', 'Receipts go in the jar.'] },
      ],
    });
    const { group } = log;
    const edit = log.propose('Ana', { title: 'Quiet hours', text: 'Quiet after 10pm.\n' });
    everyone(log, edit, 4);
    log.minute += 5;
    const removal = log.propose('Ben', {
      atomId: `${group}:1.1`,
      title: 'No jar',
      text: '',
    });
    everyone(log, removal, 4);
    log.minute += 5;
    const add = log.addSection('Cal', `${group}.1`, { title: 'Guests' });
    everyone(log, add, 4);
    log.minute += 5;
    const failed = log.propose('Ben', { atom: 1, title: 'No bins', text: 'Never.\n' });
    everyone(log, failed, 0);
    return { log, group, edit, removal, add, failed, state: log.state(log.minute + 1) };
  }

  it('lists each final pass in the Document, newest first, ending with its founding, and none from another Document', () => {
    const { log, group, edit, add, state } = twoDocuments();
    expect(changeLog(state, group)).toEqual([
      {
        proposalId: add,
        title: 'Guests',
        decidedAt: proposalIn(state, add).closedAt,
        change: { kind: 'added' },
        section: add,
      },
      {
        proposalId: edit,
        title: 'Quiet hours',
        decidedAt: proposalIn(state, edit).closedAt,
        change: { kind: 'changed', quote: 'Quiet hours start at ten.' },
        section: `${group}.0`,
      },
      {
        proposalId: null,
        title: null,
        decidedAt: log.records[0]?.received,
        change: { kind: 'founded' },
        section: null,
      },
    ]);
  });

  it('keeps a removed section’s row, which still names the section whose history it opens', () => {
    const { group, removal, state } = twoDocuments();
    const rows = changeLog(state, `${group}:1`);
    expect(rows.map((row) => [row.proposalId, row.change, row.section])).toEqual([
      [removal, { kind: 'removed', quote: 'Receipts go in the jar.' }, `${group}:1.1`],
      [null, { kind: 'founded' }, null],
    ]);
    const removed = rows[0]?.section ?? '';
    expect(state.atoms.some((atom) => atom.id === removed)).toBe(false);
    expect(sectionHistory(state, removed).passed.map((entry) => entry.proposalId)).toEqual([
      removal,
      null,
    ]);
  });

  it('breaks a tie in decision date by relay order, the later first, as the fold applies them', () => {
    const log = threeOfUs();
    const { group } = log;
    // Two Proposals on two sections, open together, each closing in the same minute.
    const first = log.propose('Ana', { atom: 0, title: 'First', text: 'One.\n' });
    const second = log.propose('Ben', { atom: 1, title: 'Second', text: 'Two.\n' });
    log.minute += 1;
    for (const voter of VOTERS) {
      log.vote(voter, first, 4);
      log.vote(voter, second, 4);
    }
    const state = log.state(log.minute + 1);
    expect(proposalIn(state, first).closedAt).toBe(proposalIn(state, second).closedAt);
    expect(changeLog(state, group).map((row) => row.title)).toEqual(['Second', 'First', null]);
  });

  it('starts a new Document’s log with the Proposal that created it, after which its own changes follow', () => {
    const log = threeOfUs();
    const budget = log.newDocument('Cal', 'Budget', { title: 'Start a budget' });
    everyone(log, budget, 4);
    log.minute += 5;
    const edit = log.propose('Ana', { atomId: `${budget}.1`, title: 'Halves', text: 'Halves.\n' });
    everyone(log, edit, 4);
    const state = log.state(log.minute + 1);
    expect(changeLog(state, budget)).toEqual([
      expect.objectContaining({ proposalId: edit, section: `${budget}.1` }),
      {
        proposalId: budget,
        title: 'Start a budget',
        decidedAt: proposalIn(state, budget).closedAt,
        change: { kind: 'created' },
        section: null,
      },
    ]);
    expect(changeLog(state, log.group).map((row) => row.proposalId)).toEqual([null]);
  });

  it('is empty for a Document the group doesn’t have, or one that hasn’t passed', () => {
    const log = threeOfUs();
    const budget = log.newDocument('Cal', 'Budget');
    expect(changeLog(log.state(), budget)).toEqual([]);
    expect(changeLog(log.state(), 'nope')).toEqual([]);
  });
});

describe('describeChange', () => {
  const log = threeOfUs();
  const edit = log.propose('Ana', { text: 'New.\n' });
  const removal = log.propose('Ana', { atom: 1, text: '' });
  const add = log.addSection('Ana', null);
  const created = log.newDocument('Ana', 'Budget');
  const focus = log.ask('Ana', ['One', 'Two']);
  const steward = log.steward('Ana', 1, 'Ben');
  const rules = log.rules('Ana', 'chatBot', {
    webhook: 'https://discord.com/api/webhooks/1/abcdWXYZ',
  });
  const dissolve = log.proposeDissolve('Ana', false);
  const removeBen = log.proposeRemoval('Ana', 'Ben');
  const state = log.state();

  /**
   * What `describeChange` says of the Proposal `id` in `from`, as though `version` won, when its
   * section read `before` (null for none) and every other section as `held` gives.
   */
  function described(
    id: string,
    version = id,
    before: string | null = 'Before.\n',
    { from = state, held = {} }: { from?: GroupState; held?: Record<string, string> } = {},
  ) {
    const proposal = proposalIn(from, id);
    const outcome = { kind: 'pass', version, bar: proposal.outcome.bar } as const;
    const texts = new Map(Object.entries(held));
    if (before !== null) texts.set(proposal.atom, before);
    return describeChange({ ...proposal, outcome }, texts);
  }

  it('says what a pass did to its section, quoting the section as it read before', () => {
    expect(described(edit)).toEqual({ kind: 'changed', quote: 'Before.\n' });
    expect(described(removal)).toEqual({ kind: 'removed', quote: 'Before.\n' });
    expect(described(add, add, null)).toEqual({ kind: 'added' });
    expect(described(created, created, null)).toEqual({ kind: 'created' });
  });

  it('quotes nothing for a change to a section it can’t find, rather than guessing', () => {
    expect(described(edit, edit, null)).toEqual({ kind: 'changed', quote: '' });
    expect(described(removal, removal, null)).toEqual({ kind: 'removed', quote: '' });
  });

  it('describes no change for a Proposal that changes no section', () => {
    for (const id of [focus, steward, rules, dissolve, removeBen]) {
      expect(described(id, proposalIn(state, id).versions[0]?.id)).toBeNull();
    }
  });

  it('says where a move put its section: after the section it follows, quoted as it read, or to the top (#103)', () => {
    const three = threeOfUs({ atoms: ['One.', 'Two.', 'Three.'] });
    const after = three.move('Ana', `${three.group}.2`, `${three.group}.0`);
    const top = three.move('Ben', `${three.group}.1`, null);
    const from = three.state();
    const held = { [`${three.group}.0`]: 'One, as it read.' };
    expect(described(after, after, 'Three.', { from, held })).toEqual({
      kind: 'moved',
      to: { kind: 'after', quote: 'One, as it read.' },
    });
    expect(described(top, top, 'Two.', { from, held })).toEqual({
      kind: 'moved',
      to: { kind: 'top' },
    });
    // The section it follows had gone by its pass, so the fold put it last (#103).
    expect(described(after, after, 'Three.', { from })).toEqual({
      kind: 'moved',
      to: { kind: 'end' },
    });
    // A move of a section that had gone by its pass moves nothing, as the fold leaves it.
    expect(described(top, top, null, { from, held })).toBeNull();
  });
});

describe('a passed class change (#116)', () => {
  it('describes what a class Proposal gives its section, or nothing once the section had gone', () => {
    const log = threeOfUs({ atoms: ['One.', 'Two.', 'Three.'] });
    const { group } = log;
    const entrench = log.protect('Ana', `${group}.0`, 'entrenched');
    const eternal = log.protect('Ana', `${group}.1`, 'eternal');
    const state = log.state();
    const passed = (id: string, before: string | null) => {
      const proposal = proposalIn(state, id);
      const outcome = { kind: 'pass', version: id, bar: proposal.outcome.bar } as const;
      const held = new Map(before === null ? [] : [[proposal.atom, before]]);
      return describeChange({ ...proposal, outcome }, held);
    };
    expect(passed(entrench, 'One.')).toEqual({ kind: 'class-changed', to: 'entrenched' });
    expect(passed(eternal, 'Two.')).toEqual({ kind: 'class-changed', to: 'eternal' });
    expect(passed(eternal, null)).toBeNull();
  });

  /** Three sections: Quiet hours is entrenched, then made eternal; Bins is entrenched, then lifted. */
  function classes() {
    const log = threeOfUs({
      atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.', 'Guests leave by 11pm.'],
    });
    const { group } = log;
    const steps = [
      log.protect('Ana', `${group}.0`, 'entrenched', { title: 'Protect quiet hours' }),
    ];
    everyone(log, steps[0] ?? '', 4);
    log.minute += 5;
    steps.push(log.protect('Ben', `${group}.0`, 'eternal', { title: 'Quiet hours forever' }));
    everyone(log, steps[1] ?? '', 4);
    log.minute += 5;
    steps.push(log.protect('Cal', `${group}.1`, 'entrenched', { title: 'Protect bins' }));
    everyone(log, steps[2] ?? '', 4);
    log.minute += 5;
    steps.push(log.protect('Cal', `${group}.1`, 'ordinary', { title: 'Bins are ours' }));
    everyone(log, steps[3] ?? '', 4);
    const [entrench, eternal, bins, lift] = steps;
    return { group, entrench, eternal, bins, lift, state: log.state(log.minute + 1) };
  }

  it('lists each class change in its section’s history, newest first, with the text it still reads', () => {
    const { group, entrench, eternal, state } = classes();
    expect(state.atoms.map((atom) => [atom.id, atom.class])).toEqual([
      [`${group}.0`, 'eternal'],
      [`${group}.1`, 'ordinary'],
      [`${group}.2`, 'ordinary'],
    ]);
    const passed = sectionHistory(state, `${group}.0`).passed;
    expect(passed.map((entry) => [entry.proposalId, entry.change, entry.text])).toEqual([
      [eternal, { kind: 'class-changed', to: 'eternal' }, 'Quiet hours start at ten.'],
      [entrench, { kind: 'class-changed', to: 'entrenched' }, 'Quiet hours start at ten.'],
      [null, { kind: 'founded' }, 'Quiet hours start at ten.'],
    ]);
    expect(passed[0]).toMatchObject({ title: 'Quiet hours forever', author: authorOf('ben') });
  });

  it('logs each class change in its Document, newest first, naming the section it opens', () => {
    const { group, entrench, eternal, bins, lift, state } = classes();
    expect(changeLog(state, group).map((row) => [row.proposalId, row.change, row.section])).toEqual(
      [
        [lift, { kind: 'class-changed', to: 'ordinary' }, `${group}.1`],
        [bins, { kind: 'class-changed', to: 'entrenched' }, `${group}.1`],
        [eternal, { kind: 'class-changed', to: 'eternal' }, `${group}.0`],
        [entrench, { kind: 'class-changed', to: 'entrenched' }, `${group}.0`],
        [null, { kind: 'founded' }, null],
      ],
    );
  });

  it('carries no voter’s name or note, only the author of the class change', () => {
    const { group, state } = classes();
    // Quiet hours forever: Ben's class change, which Ana, Ben and Cal scored.
    const [forever] = sectionHistory(state, `${group}.0`).passed;
    const shown = JSON.stringify([forever, changeLog(state, group)]);
    expect(shown).toContain(authorOf('ben'));
    expect(shown).not.toContain(authorOf('ana'));
    expect(shown).not.toContain(authorOf('cal'));
  });
});

describe('a passed move in history and the change log (#103)', () => {
  /** Three sections: Guests moves after Quiet hours, then Bins moves to the top. */
  function moves() {
    const log = threeOfUs({
      atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.', 'Guests leave by 11pm.'],
    });
    const { group } = log;
    const guests = log.move('Ana', `${group}.2`, `${group}.0`, { title: 'Guests after quiet' });
    everyone(log, guests, 4);
    log.minute += 5;
    const bins = log.move('Ben', `${group}.1`, null, { title: 'Bins first' });
    everyone(log, bins, 4);
    return { log, group, guests, bins, state: log.state(log.minute + 1) };
  }

  it('lists a move in its section’s history, with the text it still reads, and in no other section’s', () => {
    const { group, guests, state } = moves();
    expect(state.atoms.map((atom) => atom.id)).toEqual([`${group}.1`, `${group}.0`, `${group}.2`]);
    const [moved, founded, ...rest] = sectionHistory(state, `${group}.2`).passed;
    expect(moved).toMatchObject({
      proposalId: guests,
      title: 'Guests after quiet',
      decidedAt: proposalIn(state, guests).closedAt,
      text: 'Guests leave by 11pm.',
      author: authorOf('ana'),
      change: { kind: 'moved', to: { kind: 'after', quote: 'Quiet hours start at ten.' } },
    });
    expect(moved?.totals).toEqual({ scorers: 3, sum: 12, zeros: 0, quorum: 3 });
    expect(founded?.change).toEqual({ kind: 'founded' });
    expect(rest).toEqual([]);
    // The section it follows is only its anchor: its own history holds its founding alone.
    expect(sectionHistory(state, `${group}.0`).passed.map((entry) => entry.proposalId)).toEqual([
      null,
    ]);
  });

  it('logs each move in its Document, newest first, naming the section it opens', () => {
    const { group, guests, bins, state } = moves();
    expect(changeLog(state, group).map((row) => [row.proposalId, row.change, row.section])).toEqual(
      [
        [bins, { kind: 'moved', to: { kind: 'top' } }, `${group}.1`],
        [
          guests,
          { kind: 'moved', to: { kind: 'after', quote: 'Quiet hours start at ten.' } },
          `${group}.2`,
        ],
        [null, { kind: 'founded' }, null],
      ],
    );
  });

  it('quotes the section a move follows as it read when the move passed, as a change quotes its own', () => {
    const { log, group, guests } = moves();
    log.minute += 5;
    const quiet = log.propose('Cal', {
      atom: 0,
      title: 'Quiet later',
      text: 'Quiet after 11pm.\n',
    });
    everyone(log, quiet, 4);
    const rows = changeLog(log.state(log.minute + 1), group);
    expect(rows.find((row) => row.proposalId === guests)?.change).toEqual({
      kind: 'moved',
      to: { kind: 'after', quote: 'Quiet hours start at ten.' },
    });
  });

  it('says a move whose anchor was removed before it passed put its section at the end, as the fold did', () => {
    const log = threeOfUs({ atoms: ['One.', 'Two.', 'Three.'] });
    const { group } = log;
    const move = log.move('Ana', `${group}.0`, `${group}.1`, { title: 'One after two' });
    const removal = log.propose('Ben', { atom: 1, title: 'No two', text: '' });
    everyone(log, removal, 4);
    log.minute += 5;
    everyone(log, move, 4);
    const state = log.state(log.minute + 1);
    expect(state.atoms.map((atom) => atom.id)).toEqual([`${group}.2`, `${group}.0`]);
    expect(sectionHistory(state, `${group}.0`).passed[0]?.change).toEqual({
      kind: 'moved',
      to: { kind: 'end' },
    });
  });

  it('carries no voter’s name or note, only the author of the move', () => {
    const { group, state } = moves();
    // Bins first: Ben's move, which Ana, Ben and Cal scored.
    const [binsFirst] = sectionHistory(state, `${group}.1`).passed;
    const shown = JSON.stringify([binsFirst, changeLog(state, group)]);
    expect(shown).toContain(authorOf('ben'));
    expect(shown).not.toContain(authorOf('ana'));
    expect(shown).not.toContain(authorOf('cal'));
  });
});

describe('a coalition’s section history (#100, #120; ADR-0036)', () => {
  const R = 29_375_000;
  const WEEK = 10_080;

  /**
   * Group A (whose voters carry canary names) and group B hold seats in a coalition. Zed's
   * motion rewords its statement; A's voters score it inside A, A and B each post a pass, and
   * a second motion, by Kim, fails when B posts a fail.
   */
  function coalitionStory() {
    const logs = new Logs();
    logs.group('A', R, ['canaryana', 'canaryben']);
    const reconcile = logs.reconcile('A', R + 3, 'canaryana', 'A');
    logs.vote('A', R + 4, 'canaryana', reconcile, 4);
    logs.vote('A', R + 5, 'canaryben', reconcile, 4);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed', 'We keep the river and its banks clean.');
    logs.vote('A', at + 1, 'canaryana', motion, 4, 'canary note');
    logs.vote('A', at + 2, 'canaryben', motion, 3);
    logs.result(at + 3, 'kim', motion, 'A', 'pass');
    logs.result(at + 4, 'zed', motion, 'B', 'pass');
    const settles = at + WEEK + HORIZON_STEP_MINUTES;
    const second = logs.motion(settles + 10, 'kim', 'We keep the whole valley clean.');
    logs.result(settles + 12, 'zed', second, 'B', 'fail');
    const coalition = folded(foldLogs(logs.logs, settles + 20), 'coalition').state;
    return { logs, coalition, motion, second, settles, failedAt: settles + 12 };
  }

  it('shows each motion that passed with each group’s pass, and no totals', () => {
    const { logs, coalition, motion, settles } = coalitionStory();
    const section = `${logs.ids.coalition ?? ''}.0`;
    const { passed } = sectionHistory(coalition, section);
    expect(passed).toEqual([
      {
        proposalId: motion,
        title: 'Banks too',
        why: 'The banks matter.',
        decidedAt: settles,
        text: 'We keep the river and its banks clean.',
        author: authorOf('zed'),
        totals: null,
        groups: [
          { name: 'A', result: 'pass' },
          { name: 'B', result: 'pass' },
        ],
        change: { kind: 'changed', quote: 'We keep the river clean.' },
      },
      expect.objectContaining({ proposalId: null, author: null, totals: null, groups: null }),
    ]);
  });

  it('dates a motion that failed by the result that failed it', () => {
    const { logs, coalition, second, failedAt } = coalitionStory();
    const section = `${logs.ids.coalition ?? ''}.0`;
    expect(sectionHistory(coalition, section).notPassed).toEqual([
      { proposalId: second, title: 'Banks too', outcome: 'fail', decidedAt: failedAt },
    ]);
  });

  it('dates a motion that failed for want of results when results stopped counting', () => {
    const logs = new Logs();
    const at = logs.formed(R, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    logs.result(at + 1, 'kim', motion, 'A', 'pass');
    const settles = at + WEEK + HORIZON_STEP_MINUTES;
    const coalition = folded(foldLogs(logs.logs, settles), 'coalition').state;
    expect(sectionHistory(coalition, `${logs.ids.coalition ?? ''}.0`).notPassed).toEqual([
      { proposalId: motion, title: 'Banks too', outcome: 'fail', decidedAt: settles },
    ]);
  });

  it('carries no group’s voter names, notes or counts, only each group’s pass or fail', () => {
    const { logs, coalition } = coalitionStory();
    const section = `${logs.ids.coalition ?? ''}.0`;
    const shown = JSON.stringify([
      sectionHistory(coalition, section),
      changeLog(coalition, logs.ids.coalition ?? ''),
    ]);
    expect(shown).not.toMatch(/canary/i);
    expect(shown).not.toContain(authorOf('canaryana'));
    expect(shown).not.toContain('"scorers"');
  });
});
