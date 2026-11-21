/**
 * What group home and a Proposal say of a group's coalitions (#114), from
 * logs signed and folded through the engine: forming, formed, declined, and
 * a group asking in.
 */
import { describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { fold, type GroupState } from '../engine/fold';
import type { HeldCoalition } from '../store/coalitions';
import { foldCoalitions, foldWithCoalitions } from '../store/coalitions';
import type { Group } from '../store/db';
import {
  COALITION_STATEMENT,
  Logs,
  NESTED_STATEMENTS,
  NestedLogs,
  testSecret,
  threeLevels,
} from '../test/coalitions';
import { authorOf } from '../test/keys';
import {
  coalitionRows,
  motionView,
  motionWords,
  reconcileView,
  sitsInFormed,
  withdrawnBy,
  withMotionWords,
} from './coalitionLines';

const R = 29_375_000;

/** The coalition's entry as a device keeps it, for `who`, with `plan`. */
function heldCoalition(
  logs: Logs,
  relayNow: number,
  who = 'kim',
  plan: Partial<Group> = {},
): HeldCoalition {
  const entry = {
    kind: 'coalition',
    groupId: deriveCoalitionEntryId(fromBase64url(testSecret('coalition'))),
    me: { author: authorOf(who), name: '' },
    outbox: [],
    log: logs.logs.coalition ?? [],
    relayNow,
    ...plan,
  } as unknown as Group;
  return { entry, state: fold(entry.log, relayNow) };
}

/** Group `log` folded with its coalition's motions, as group home folds it. */
function groupState(logs: Logs, log: string, relayNow: number, held: HeldCoalition): GroupState {
  return foldWithCoalitions({ log: logs.logs[log] ?? [], relayNow }, [held]);
}

/** Riverside (ana, ben) proposes reconciling under seat A; it passes unless `pass` is false. */
function riverside(logs: Logs, pass = true): string {
  logs.group('A', R, ['ana', 'ben'], 'Riverside');
  const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ana', proposal, pass ? 4 : 0, pass ? undefined : 'No.');
  logs.vote('A', R + 5, 'ben', proposal, pass ? 4 : 0, pass ? undefined : 'No.');
  return proposal;
}

describe('sitsInFormed (#126)', () => {
  it('is true once a coalition whose seats name the group’s seat has formed, and not before', () => {
    const logs = new Logs();
    riverside(logs);
    const none = heldCoalition(logs, R + 10);
    expect(sitsInFormed(groupState(logs, 'A', R + 10, none), [none])).toBe(false);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'kim', 'A');
    logs.join(R + 11, 'dee', 'B');
    const forming = heldCoalition(logs, R + 12);
    expect(sitsInFormed(groupState(logs, 'A', R + 12, forming), [forming])).toBe(false);
    const genesis = logs.ids.coalition ?? '';
    logs.result(R + 12, 'kim', genesis, 'A', 'pass');
    logs.result(R + 12, 'dee', genesis, 'B', 'pass');
    const formed = heldCoalition(logs, R + 13);
    expect(sitsInFormed(groupState(logs, 'A', R + 13, formed), [formed])).toBe(true);
    expect(sitsInFormed(fold(logs.logs.A ?? [], R + 13), [])).toBe(false);
  });
});

describe('coalitionRows', () => {
  it('waits for the card while no genesis exists, and for the group’s own vote while it’s open', () => {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben'], 'Riverside');
    logs.reconcile('A', R + 3, 'ana', 'A');
    const held = heldCoalition(logs, R + 10);

    const [row] = coalitionRows(groupState(logs, 'A', R + 10, held), authorOf('ana'), [held]);
    expect(row).toMatchObject({
      name: COALITION_STATEMENT.name,
      coalitionId: null,
      status: 'forming',
      lines: [{ kind: 'waiting', group: 'Riverside' }, { kind: 'waiting-card' }],
      members: [],
      me: { kind: 'none' },
      makesCards: false,
      mismatches: 0,
    });
  });

  it('says the group didn’t pass it, with no genesis yet', () => {
    const logs = new Logs();
    riverside(logs, false);
    const held = heldCoalition(logs, R + 10);

    const [row] = coalitionRows(groupState(logs, 'A', R + 10, held), authorOf('ana'), [held]);
    expect(row).toMatchObject({
      status: 'declined',
      lines: [{ kind: 'didnt-pass', group: 'Riverside' }],
    });
  });

  it('lists no row for a reconcile Proposal with no entry on the device', () => {
    const logs = new Logs();
    riverside(logs);
    const state = fold(logs.logs.A ?? [], R + 10);
    expect(coalitionRows(state, authorOf('ana'), [])).toEqual([]);
  });

  it('waits for each founding seat that hasn’t passed, and offers Take part to who may propose', () => {
    const logs = new Logs();
    riverside(logs);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'kim', 'A');
    logs.result(R + 12, 'kim', logs.ids.coalition ?? '', 'A', 'pass');
    const held = heldCoalition(logs, R + 20, 'cal');

    const state = groupState(logs, 'A', R + 20, held);
    const [row] = coalitionRows(state, authorOf('ana'), [held]);
    expect(row).toMatchObject({
      coalitionId: logs.ids.coalition,
      status: 'forming',
      lines: [{ kind: 'waiting', group: 'B' }],
      me: { kind: 'may-take-part' },
    });
    // Ben joined as a Collaborator, who votes but doesn't propose, so he takes no part there.
    expect(coalitionRows(state, authorOf('ben'), [held])[0]?.me).toEqual({ kind: 'none' });
  });

  it('says joining while a planned join or anything else waits to send', () => {
    const logs = new Logs();
    const proposal = riverside(logs);
    logs.coalition(R + 10, ['A', 'B']);
    const state = fold(logs.logs.A ?? [], R + 20);
    const planned = heldCoalition(logs, R + 20, 'cal', { joinAs: state.group ?? '' });
    const queued = heldCoalition(logs, R + 20, 'cal', { outbox: [Uint8Array.of(1)] });

    expect(coalitionRows(state, authorOf('ana'), [planned])[0]?.me).toEqual({ kind: 'joining' });
    expect(coalitionRows(state, authorOf('ana'), [queued])[0]?.me).toEqual({ kind: 'joining' });
    expect(coalitionRows(state, authorOf('ana'), [queued])[0]?.proposal).toBe(proposal);
  });

  it('says which founding group failed once declined, and offers no Take part', () => {
    const logs = new Logs();
    riverside(logs);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'kim', 'A');
    logs.join(R + 11, 'zed', 'B');
    const genesis = logs.ids.coalition ?? '';
    logs.result(R + 12, 'kim', genesis, 'A', 'pass');
    logs.result(R + 12, 'zed', genesis, 'B', 'fail');
    const held = heldCoalition(logs, R + 20, 'cal');

    const [row] = coalitionRows(groupState(logs, 'A', R + 20, held), authorOf('ana'), [held]);
    expect(row).toMatchObject({
      status: 'declined',
      lines: [{ kind: 'didnt-pass', group: 'B' }],
      me: { kind: 'none' },
    });
  });

  it('says not every group voted in time once still forming at formsFinal, its genesis plus 15 days (#250)', () => {
    const logs = new Logs();
    riverside(logs);
    logs.coalition(R + 10, ['A', 'B']);
    const formsFinal = R + 10 + 14 * 1440 + 1440;
    const before = heldCoalition(logs, formsFinal - 1, 'cal');
    const held = heldCoalition(logs, formsFinal, 'cal');

    const [still] = coalitionRows(groupState(logs, 'A', formsFinal - 1, before), authorOf('ana'), [
      before,
    ]);
    expect(still?.status).toBe('forming');
    const [row] = coalitionRows(groupState(logs, 'A', formsFinal, held), authorOf('ana'), [held]);
    expect(row).toMatchObject({ status: 'declined', lines: [{ kind: 'lapsed' }] });
  });

  it('lists a formed coalition’s member groups, and lets a participant make cards', () => {
    const logs = new Logs();
    riverside(logs);
    logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const held = heldCoalition(logs, R + 40);
    const state = groupState(logs, 'A', R + 40, held);

    expect(coalitionRows(state, authorOf('ana'), [held])[0]).toMatchObject({
      status: 'formed',
      lines: [],
      members: ['A', 'B'],
      me: { kind: 'in', name: 'kim' },
      makesCards: true,
    });
    const dissolved = { ...state, dissolved: { received: R + 50, wipe: false } };
    expect(coalitionRows(dissolved, authorOf('ana'), [held])[0]?.makesCards).toBe(false);
  });

  it('still lists the coalition on a removed member’s copy, and makes no cards from it (#115)', () => {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const target = { kind: 'remove', member: authorOf('ben') } as const;
    const body = { target, title: 'Remove Ben', why: 'Threats in the chat.' };
    const removal = logs.add('A', at, 'ana', { type: 'proposal', body });
    logs.vote('A', at + 1, 'ana', removal, 4);
    logs.add('A', at + 2, 'ana', { type: 'remove', body: { proposal: removal } });
    const held = heldCoalition(logs, at + 10);
    const state = groupState(logs, 'A', at + 10, held);

    expect(state.former.map((m) => m.author)).toEqual([authorOf('ben')]);
    expect(coalitionRows(state, authorOf('ben'), [held])[0]).toMatchObject({
      status: 'formed',
      members: ['A', 'B'],
      me: { kind: 'in', name: 'kim' },
      makesCards: false,
    });
    expect(coalitionRows(state, authorOf('ana'), [held])[0]?.makesCards).toBe(true);
  });

  it('counts the results recorded for the group’s seat that don’t match its vote', () => {
    const logs = new Logs();
    riverside(logs, false);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'mal', 'A');
    logs.result(R + 12, 'mal', logs.ids.coalition ?? '', 'A', 'pass');
    const held = heldCoalition(logs, R + 20, 'cal');

    const [row] = coalitionRows(groupState(logs, 'A', R + 20, held), authorOf('ana'), [held]);
    expect(row?.mismatches).toBe(1);
  });
});

/** A coalition of A and B, formed, and Elm Row (C), which asks in once it passes its own vote. */
function asking(cPasses = true) {
  const logs = new Logs();
  riverside(logs);
  const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
  logs.group('C', at, ['cal'], 'Elm Row');
  const proposal = logs.reconcile('C', at + 1, 'cal', 'C');
  logs.vote('C', at + 2, 'cal', proposal, cPasses ? 4 : 0, cPasses ? undefined : 'No.');
  return { logs, at: at + 3 };
}

describe('currently not passing on the group’s own line (#250)', () => {
  /**
   * Riverside (Ana, Ben, Cal)'s open reconcile Proposal, scored as `scores`
   * say, in a coalition with B unless `genesis` is false. With three voters,
   * quorum takes all three, which closes the vote, so `passing` stands in for
   * a larger group's open count that passes: the Proposal's live outcome.
   */
  function scored(
    scores: readonly (readonly [string, 0 | 4])[],
    { genesis = true, passing = false } = {},
  ) {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben', 'cal'], 'Riverside');
    const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
    scores.forEach(([who, score], i) =>
      logs.vote('A', R + 4 + i, who, proposal, score, score === 0 ? 'Not yet.' : undefined),
    );
    if (genesis) logs.coalition(R + 10, ['A', 'B']);
    const held = heldCoalition(logs, R + 20, 'cal');
    const state = groupState(logs, 'A', R + 20, held);
    const live = passing
      ? {
          ...state,
          proposals: state.proposals.map((p) =>
            p.id === proposal
              ? { ...p, outcome: { kind: 'pass' as const, version: proposal, bar: p.outcome.bar } }
              : p,
          ),
        }
      : state;
    return coalitionRows(live, authorOf('ana'), [held])[0];
  }

  it('marks the group’s own line while its open vote has a ballot and its count isn’t a pass, and never another group’s', () => {
    expect(scored([['ben', 0]])?.lines).toEqual([
      { kind: 'waiting', group: 'A', notPassing: true },
      { kind: 'waiting', group: 'B' },
    ]);
  });

  it('marks it before a genesis too, while the card waits', () => {
    expect(scored([['ben', 0]], { genesis: false })?.lines).toEqual([
      { kind: 'waiting', group: 'Riverside', notPassing: true },
      { kind: 'waiting-card' },
    ]);
  });

  it('marks nothing before anyone has scored it, nor while its count passes', () => {
    const plain = [
      { kind: 'waiting', group: 'A' },
      { kind: 'waiting', group: 'B' },
    ];
    expect(scored([])?.lines).toEqual(plain);
    expect(scored([['ben', 4]], { passing: true })?.lines).toEqual(plain);
    // One 4 of three voters isn't at quorum, so it wouldn't pass if voting ended now.
    expect(scored([['ben', 4]])?.lines[0]).toEqual({
      kind: 'waiting',
      group: 'A',
      notPassing: true,
    });
  });
});

describe('withdrawnBy (#250)', () => {
  /** Riverside (Ana, Ben)'s reconcile Proposal, still open, and a genesis naming A and B. */
  function open() {
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben'], 'Riverside');
    const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'zed', 'B');
    return { logs, proposal };
  }

  /** The Proposal `id` as group A folds it at `at`, with the coalition held. */
  function viewed(logs: Logs, id: string, at: number) {
    const held = heldCoalition(logs, at, 'cal');
    const state = groupState(logs, 'A', at, held);
    const proposal = state.proposals.find((p) => p.id === id);
    if (proposal === undefined) throw new Error('Expected the Proposal.');
    return withdrawnBy(proposal, [held]);
  }

  it('names the group whose fail declined the coalition, while this group’s own vote is still open', () => {
    const { logs, proposal } = open();
    logs.result(R + 12, 'zed', logs.ids.coalition ?? '', 'B', 'fail');
    expect(viewed(logs, proposal, R + 20)).toBe('B');
  });

  it('is null while the coalition forms, once this group’s vote has closed, and for any other Proposal', () => {
    const { logs, proposal } = open();
    expect(viewed(logs, proposal, R + 20)).toBeNull();
    logs.result(R + 12, 'zed', logs.ids.coalition ?? '', 'B', 'fail');
    logs.vote('A', R + 13, 'ana', proposal, 4);
    logs.vote('A', R + 14, 'ben', proposal, 4);
    expect(viewed(logs, proposal, R + 20)).toBeNull();
    const other = logs.add('A', R + 15, 'ana', {
      type: 'proposal',
      body: { atom: `${logs.ids.A ?? ''}.0`, title: 'T', why: 'W', text: 'New words.' },
    });
    expect(viewed(logs, other, R + 20)).toBeNull();
  });
});

describe('coalitionRows for a group asking in', () => {
  it('reads as forming with nothing to wait on before the admission is proposed', () => {
    const { logs, at } = asking();
    const held = heldCoalition(logs, at, 'dee');
    const [row] = coalitionRows(groupState(logs, 'C', at, held), authorOf('cal'), [held]);
    expect(row).toMatchObject({ status: 'forming', lines: [], members: [] });
  });

  it('reads as the group’s own vote while it is open, or didn’t pass', () => {
    const { logs, at } = asking(false);
    const held = heldCoalition(logs, at, 'dee');
    const [row] = coalitionRows(groupState(logs, 'C', at, held), authorOf('cal'), [held]);
    expect(row).toMatchObject({
      status: 'declined',
      lines: [{ kind: 'didnt-pass', group: 'Elm Row' }],
    });
  });

  it('waits for each current group on the admission, then says who failed it', () => {
    const { logs, at } = asking();
    const motion = logs.admit(at, 'dee', 'C', 'Elm Row');
    logs.result(at + 1, 'kim', motion, 'A', 'pass');
    const open = heldCoalition(logs, at + 2, 'dee');
    const [waiting] = coalitionRows(groupState(logs, 'C', at + 2, open), authorOf('cal'), [open]);
    expect(waiting).toMatchObject({ status: 'forming', lines: [{ kind: 'waiting', group: 'B' }] });

    logs.result(at + 3, 'zed', motion, 'B', 'fail');
    const failed = heldCoalition(logs, at + 4, 'dee');
    const [row] = coalitionRows(groupState(logs, 'C', at + 4, failed), authorOf('cal'), [failed]);
    expect(row).toMatchObject({ status: 'declined', lines: [{ kind: 'didnt-pass', group: 'B' }] });
  });

  it('offers a card for another coalition only once a wrap gives this device inner through its seat (#122, #313)', () => {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    logs.group('C', at, ['cal'], 'Elm Row');
    const proposal = logs.reconcile('C', at + 1, 'cal', 'C', { inner: false });
    logs.vote('C', at + 2, 'cal', proposal, 4);
    const seated = logs.admitted(at + 3, 'dee', 'C', 'Elm Row', [
      ['kim', 'A'],
      ['zed', 'B'],
    ]);
    logs.join(seated + 1, 'cal', 'C');
    const rowAt = (now: number) => {
      const held = heldCoalition(logs, now, 'cal');
      return coalitionRows(groupState(logs, 'C', now, held), authorOf('cal'), [held])[0];
    };

    // Seated and taking part, but no seated group has wrapped inner to Elm Row's seat yet.
    expect(rowAt(seated + 2)).toMatchObject({
      status: 'formed',
      makesCards: true,
      reconciles: false,
    });
    logs.wrap(seated + 3, 'kim', 'C');
    expect(rowAt(seated + 4)).toMatchObject({ makesCards: true, reconciles: true });
  });
});

describe('reconcileView', () => {
  it('reads the card’s words, and names the other groups once a genesis does', () => {
    const logs = new Logs();
    const proposal = riverside(logs);
    const before = heldCoalition(logs, R + 10);
    const reconcile = fold(logs.logs.A ?? [], R + 10).proposals.find((p) => p.id === proposal);
    if (reconcile === undefined) throw new Error('Expected the reconcile Proposal.');

    expect(reconcileView(reconcile, [before])).toEqual({ ...COALITION_STATEMENT, others: null });
    expect(reconcileView(reconcile, [])?.others).toBeNull();
    logs.coalition(R + 10, ['A', 'B']);
    expect(reconcileView(reconcile, [heldCoalition(logs, R + 20)])?.others).toEqual(['B']);
  });

  it('is null for any other Proposal', () => {
    expect(reconcileView({ id: 'p', target: { kind: 'edit' } }, [])).toBeNull();
  });
});

describe('motion words', () => {
  it('reads a motion’s title, why, coalition and the group it would admit', () => {
    const { logs, at } = asking();
    const motion = logs.admit(at, 'dee', 'C', 'Elm Row');
    const held = heldCoalition(logs, at + 1);
    const state = groupState(logs, 'A', at + 1, held);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in group A.');

    expect(motionWords(opened, [held])).toEqual({
      title: 'Admit Elm Row',
      why: 'They share the river.',
      coalition: COALITION_STATEMENT.name,
      coalitionId: logs.ids.coalition,
      through: [],
      admits: 'Elm Row',
      admitsLevel: 0,
      admitsGroups: [],
      text: '',
      link: null,
      author: authorOf('dee'),
      promoted: null,
    });
    expect(motionWords(opened, [])).toBeNull();
    expect(motionWords({ id: 'x', target: { kind: 'edit' } }, [held])).toBeNull();
    const titled = withMotionWords(state, [held]);
    expect(titled.proposals.find((p) => p.id === motion)?.title).toBe('Admit Elm Row');
    expect(withMotionWords(state, [])).not.toBe(state);
  });

  it('leaves a group with no motion as it is', () => {
    const logs = new Logs();
    riverside(logs);
    const state = fold(logs.logs.A ?? [], R + 10);
    expect(withMotionWords(state, [])).toBe(state);
  });

  it('reads an edit motion as not admitting anyone', () => {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'kim');
    const held = heldCoalition(logs, at + 1);
    const opened = groupState(logs, 'A', at + 1, held).proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in group A.');
    expect(motionWords(opened, [held])?.admits).toBeNull();
  });

  it('carries an edit motion’s text and link into the group, so its ballot shows the change (#120)', () => {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'kim', 'We keep the river and its banks clean.');
    const held = heldCoalition(logs, at + 1);
    const state = withMotionWords(groupState(logs, 'A', at + 1, held), [held]);
    const opened = state.proposals.find((p) => p.id === motion);

    expect(opened).toMatchObject({
      title: 'Banks too',
      why: 'The banks matter.',
      text: 'We keep the river and its banks clean.',
      link: null,
      versions: [
        { id: motion, text: 'We keep the river and its banks clean.', author: authorOf('kim') },
      ],
    });
  });
});

describe('motionView (#120)', () => {
  /** Riverside and B in a formed coalition, kim for A and zed for B, with kim's motion. */
  function withMotion() {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'kim', 'We keep the river and its banks clean.');
    return { logs, at, motion };
  }

  it('reads the coalition, the motion, its progress for the group’s seat, and the section it rewords', () => {
    const { logs, at, motion } = withMotion();
    logs.result(at + 1, 'kim', motion, 'A', 'pass');
    const held = heldCoalition(logs, at + 2);
    const state = groupState(logs, 'A', at + 2, held);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in group A.');

    const view = motionView(opened, state, [held]);
    expect(view).toMatchObject({
      coalitionId: logs.ids.coalition,
      coalition: COALITION_STATEMENT.name,
      author: 'kim',
      section: { number: 1, text: COALITION_STATEMENT.atoms[0] },
      progress: { seats: 2, passed: 1, mine: 'pass', deciding: ['B'] },
    });
    expect(view?.motion.id).toBe(motion);
    expect(view?.state).toBe(held.state);
  });

  it('is null for any other Proposal, or a motion whose coalition this device doesn’t hold', () => {
    const { logs, at, motion } = withMotion();
    const held = heldCoalition(logs, at + 1);
    const state = groupState(logs, 'A', at + 1, held);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the motion in group A.');
    expect(motionView(opened, state, [])).toBeNull();
    const own = state.proposals.find((p) => p.target.kind === 'reconcile');
    if (own === undefined) throw new Error('Expected the reconcile Proposal.');
    expect(motionView(own, state, [held])).toBeNull();
  });

  it('has no section for a motion that admits a group', () => {
    const logs = new Logs();
    riverside(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.admit(at, 'dee', 'C', 'Elm Row');
    const held = heldCoalition(logs, at + 1);
    const state = groupState(logs, 'A', at + 1, held);
    const opened = state.proposals.find((p) => p.id === motion);
    if (opened === undefined) throw new Error('Expected the admit motion in group A.');
    expect(motionView(opened, state, [held])?.section).toBeNull();
    expect(motionView(opened, state, [held])?.author).toBe('');
  });
});

describe('nested coalitions on group home and a ballot (#122)', () => {
  const NOW = R + 100;

  /** Every coalition of {@link threeLevels} as a device holding them keeps them, by log, as `who[log]`. */
  function heldAll(logs: NestedLogs, who: Readonly<Record<string, string>>) {
    const names = ['C', 'D', 'F'] as const;
    const entries = names.map(
      (log) =>
        ({
          kind: 'coalition',
          groupId: deriveCoalitionEntryId(fromBase64url(testSecret(log))),
          me: { author: authorOf(who[log] ?? 'nobody'), name: '' },
          outbox: [],
          log: logs.logs[log] ?? [],
          relayNow: NOW,
        }) as unknown as Group,
    );
    return foldCoalitions(entries);
  }

  it('lists every coalition above the group’s, two levels up, each with its chain', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const held = heldAll(logs, { C: 'cal' });
    const state = foldWithCoalitions({ log: logs.logs.A ?? [], relayNow: NOW }, held);
    const [row] = coalitionRows(state, authorOf('ana'), held);
    expect(row?.name).toBe(NESTED_STATEMENTS.C.name);
    expect(row?.above.map((above) => [above.status, above.chain.join(' / ')])).toEqual([
      ['formed', 'Riverside / Eastside Housing / Metro Renters'],
      ['formed', 'Riverside / Eastside Housing / Metro Renters / State Renters'],
    ]);
    expect(row?.above.map((above) => above.coalitionId)).toEqual([logs.ids.D, logs.ids.F]);
    // Cal takes part in Eastside Housing, at level 1, so may make its card for another coalition.
    expect(row?.reconciles).toBe(true);
  });

  it('offers no card for another coalition from a level-3 coalition’s row', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const held = heldAll(logs, { F: 'jon' });
    const state = foldWithCoalitions({ log: logs.logs.G ?? [], relayNow: NOW }, held);
    const [row] = coalitionRows(state, authorOf('gus'), held);
    expect(row?.name).toBe(NESTED_STATEMENTS.F.name);
    expect(row?.makesCards).toBe(true);
    expect(row?.reconciles).toBe(false);
  });

  it('shows a coalition’s motion to join one above as the statement its group votes on', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const held = heldAll(logs, { C: 'cal' });
    const state = foldWithCoalitions({ log: logs.logs.A ?? [], relayNow: NOW }, held);
    const intoD = state.proposals.find(
      (p) => p.target.kind === 'motion' && reconcileView(p, held)?.name === 'Metro Renters',
    );
    if (intoD === undefined) throw new Error('Expected Eastside Housing’s motion in group A.');
    expect(intoD.target).toMatchObject({ kind: 'motion', coalition: logs.ids.C, chain: [] });
    expect(reconcileView(intoD, held)).toEqual({
      ...NESTED_STATEMENTS.D,
      others: ['E'],
    });
  });
});

describe('a coalition asking into one seated above, refused at the final step (#549)', () => {
  const WEST = { name: 'Westside Renters', title: 'Shared ground', atoms: ['We rent.'] };
  const EAST = NESTED_STATEMENTS.C;
  const WINDOW_AND_DAY = 7 * 1_440 + 1_440;

  /**
   * Pine Row (pat) and seat Q form Westside Renters (W), which asks into
   * Eastside Housing (C), formed of seats A and B; C's seats pass the admit
   * motion, then C opens its motion to take a seat in Metro Renters.
   */
  function refusedLate() {
    const logs = new NestedLogs();
    logs.group('P', R, ['pat'], 'Pine Row');
    const intoW = logs.reconcileInto('P', R + 1, 'pat', 'W', 'P', WEST);
    logs.vote('P', R + 2, 'pat', intoW, 4);
    const formed = logs.formedIn('W', R + 3, [['P'], ['Q']], ['pia', 'quinn'], WEST);
    const intoC = logs.sealedInto('W', formed, 'pia', 'C', EAST);
    logs.resultIn('W', formed + 1, 'pia', intoC, 'P', 'pass');
    logs.resultIn('W', formed + 1, 'quinn', intoC, 'Q', 'pass');
    const at = logs.formedIn('C', R, [['A'], ['B']], ['cal', 'dee'], EAST);
    const admit = logs.admitIn('C', formed + 2, 'pia', { seat: 'W', name: WEST.name, level: 1 });
    logs.resultIn('C', formed + 3, 'cal', admit, 'A', 'pass');
    logs.resultIn('C', formed + 3, 'dee', admit, 'B', 'pass');
    logs.sealedInto('C', at + 20, 'cal', 'D', NESTED_STATEMENTS.D);
    return { logs, now: formed + 2 + WINDOW_AND_DAY };
  }

  /** W and C as Pat's device keeps them, at `now`. */
  function heldBoth(logs: NestedLogs, now: number) {
    const entries = (['W', 'C'] as const).map(
      (log) =>
        ({
          kind: 'coalition',
          groupId: deriveCoalitionEntryId(fromBase64url(testSecret(log))),
          me: { author: authorOf(log === 'W' ? 'pat' : 'nobody'), name: '' },
          outbox: [],
          log: logs.logs[log] ?? [],
          relayNow: now,
        }) as unknown as Group,
    );
    return foldCoalitions(entries);
  }

  it('says, under Westside Renters, why Eastside Housing refused it and the route instead', () => {
    const { logs, now } = refusedLate();
    const held = heldBoth(logs, now);
    const state = foldWithCoalitions({ log: logs.logs.P ?? [], relayNow: now }, held);
    const [row] = coalitionRows(state, authorOf('pat'), held);
    expect(row?.name).toBe(WEST.name);
    expect(row?.above).toEqual([
      expect.objectContaining({
        name: EAST.name,
        status: 'declined',
        lines: [
          {
            kind: 'refused',
            coalition: EAST.name,
            above: NESTED_STATEMENTS.D.name,
            asking: WEST.name,
          },
        ],
      }),
    ]);
  });

  it('waits on Eastside Housing’s seats while the admission is open, before the refusal', () => {
    const { logs, now } = refusedLate();
    const held = heldBoth(logs, now - 1);
    const state = foldWithCoalitions({ log: logs.logs.P ?? [], relayNow: now - 1 }, held);
    const [row] = coalitionRows(state, authorOf('pat'), held);
    expect(row?.above).toEqual([
      expect.objectContaining({ name: EAST.name, status: 'forming', lines: [] }),
    ]);
  });
});
