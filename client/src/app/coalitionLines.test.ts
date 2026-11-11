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
import { foldWithCoalitions } from '../store/coalitions';
import type { Group } from '../store/db';
import { COALITION_STATEMENT, Logs, testSecret } from '../test/coalitions';
import { authorOf } from '../test/keys';
import {
  coalitionRows,
  motionView,
  motionWords,
  reconcileView,
  withMotionWords,
} from './coalitionLines';

const R = 29_375_000;
const WEEK = 10_080;

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

  it('says not every group voted in time once results stop counting with none failed', () => {
    const logs = new Logs();
    riverside(logs);
    logs.coalition(R + 10, ['A', 'B']);
    const later = R + 10 + 14 * 1440 + WEEK + 1;
    const held = heldCoalition(logs, later, 'cal');

    const [row] = coalitionRows(groupState(logs, 'A', later, held), authorOf('ana'), [held]);
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
