/**
 * The coalition home's model (#120), from logs signed and folded through the
 * engine: its member groups, Documents, open and decided motions, what waits
 * to send, and who may propose there.
 */
import { describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { foldCoalitions, type HeldCoalition } from '../store/coalitions';
import type { Group } from '../store/db';
import { COALITION_STATEMENT, Logs, NestedLogs, testSecret, threeLevels } from '../test/coalitions';
import { authorOf, testKeys } from '../test/keys';
import {
  coalitionById,
  coalitionHome,
  type DeviceGroup,
  documentAtoms,
  sectionIsOpen,
  standingIn,
} from './coalitionHome';

const R = 29_375_000;
const WEEK = 7 * DAY_MINUTES;

/** The coalition's entry as `who`'s device keeps it, with `plan`. */
function heldBy(logs: Logs, relayNow: number, who: string, plan: Partial<Group> = {}) {
  const entry = {
    kind: 'coalition',
    groupId: deriveCoalitionEntryId(fromBase64url(testSecret('coalition'))),
    me: { author: authorOf(who), name: who },
    outbox: [],
    log: logs.logs.coalition ?? [],
    relayNow,
    ...plan,
  } as unknown as Group;
  return { entry, state: fold(entry.log, relayNow) } satisfies HeldCoalition;
}

/** Group `log` on this device, as `me`. */
function deviceGroup(logs: Logs, log: string, relayNow: number, me: string): DeviceGroup {
  const state = fold(logs.logs[log] ?? [], relayNow);
  return { groupId: state.group ?? '', me: authorOf(me), state, leaving: false };
}

/**
 * Riverside (ana, ben) and Oak St (cy) each propose reconciling under their
 * seat, and the coalition forms with kim for Riverside and zed for Oak St.
 */
function formed(logs: Logs): number {
  logs.group('A', R, ['ana', 'ben'], 'Riverside');
  logs.reconcile('A', R + 3, 'ana', 'Riverside');
  logs.group('B', R, ['cy'], 'Oak St');
  logs.reconcile('B', R + 3, 'cy', 'Oak St');
  return logs.formed(R + 10, ['Riverside', 'Oak St'], ['kim', 'zed']);
}

describe('coalitionHome', () => {
  it('is null before the genesis is back', () => {
    const logs = new Logs();
    logs.group('A', R, ['ana'], 'Riverside');
    expect(coalitionHome(heldBy(logs, R + 1, 'kim'), [])).toBeNull();
  });

  it('names the coalition, its member groups, marking this device’s, and its Document', () => {
    const logs = new Logs();
    const at = formed(logs);
    const held = heldBy(logs, at, 'kim');
    const home = coalitionHome(held, [deviceGroup(logs, 'A', at, 'ana')]);

    expect(home).toMatchObject({
      coalitionId: logs.ids.coalition,
      entryId: held.entry.groupId,
      name: COALITION_STATEMENT.name,
      members: [
        { name: 'Riverside', mine: true },
        { name: 'Oak St', mine: false },
      ],
      documents: [{ id: logs.ids.coalition, title: COALITION_STATEMENT.title }],
      open: [],
      decided: [],
      pending: [],
    });
  });

  it('lists open motions closing soonest first, and decided ones latest first', () => {
    const logs = new Logs();
    const at = formed(logs);
    const genesis = logs.ids.coalition ?? '';
    // Two Atoms would need a longer statement; one motion fails, then a second opens on the same Atom.
    const failed = logs.motion(at, 'kim', 'We keep the banks clean too.');
    logs.result(at + 1, 'zed', failed, 'Oak St', 'fail');
    const open = logs.motion(at + 2, 'kim', 'We keep the river and the paths clean.');
    const riverside = deviceGroup(logs, 'A', at + 3, 'ana');
    const home = coalitionHome(heldBy(logs, at + 3, 'kim'), [riverside]);

    expect(home?.open.map((m) => m.id)).toEqual([open]);
    expect(home?.open[0]).toMatchObject({
      title: 'Banks too',
      groupId: riverside.groupId,
      progress: { seats: 2, passed: 0, deciding: ['Riverside', 'Oak St'] },
    });
    expect(home?.decided.map((m) => m.id)).toEqual([failed]);
    // A group on this device outside the coalition opens no vote: Riverside's does.
    logs.group('C', R, ['ana'], 'Elm Row');
    const elm = deviceGroup(logs, 'C', at + 3, 'ana');
    const both = coalitionHome(heldBy(logs, at + 3, 'kim'), [elm, riverside]);
    expect(both?.open[0]?.groupId).toBe(riverside.groupId);
    expect(coalitionHome(heldBy(logs, at + 3, 'kim'), [elm])?.open[0]?.groupId).toBeNull();
    expect(home?.decided[0]).toMatchObject({ decidedAt: at + 1, progress: { outcome: 'fail' } });
    expect(genesis).not.toBe('');
  });

  it('dates a pass when it became final, a week after its deadline', () => {
    const logs = new Logs();
    const at = formed(logs);
    const motion = logs.motion(at, 'kim');
    logs.result(at + 1, 'kim', motion, 'Riverside', 'pass');
    logs.result(at + 2, 'zed', motion, 'Oak St', 'pass');
    const later = at + WEEK + RESULT_GRACE_MINUTES;
    const home = coalitionHome(heldBy(logs, later, 'kim'), []);

    expect(home?.open).toEqual([]);
    expect(home?.decided[0]).toMatchObject({
      id: motion,
      decidedAt: at + WEEK + RESULT_GRACE_MINUTES,
      closedAt: null,
      groupId: null,
      progress: { outcome: 'pass', final: true },
    });
  });

  it('lists a motion this device proposed while it waits for the relay', () => {
    const logs = new Logs();
    const at = formed(logs);
    const body = {
      atom: `${logs.ids.coalition ?? ''}.0`,
      title: 'Paths too',
      why: 'Yes.',
      text: 'x',
    };
    const draft = { type: 'proposal', group: logs.ids.coalition ?? '', ts: 0, body } as const;
    const signed = signEvent(testKeys('kim').secretKey, draft);
    const home = coalitionHome(heldBy(logs, at, 'kim', { outbox: [signed.record] }), []);

    expect(home?.pending).toEqual([{ id: signed.id, title: 'Paths too' }]);
    expect(home?.standing).toEqual({ kind: 'reads' });
  });

  it('finds a coalition on this device by its genesis id', () => {
    const logs = new Logs();
    const at = formed(logs);
    const held = heldBy(logs, at, 'kim');
    expect(coalitionById([held], logs.ids.coalition ?? '')).toBe(held);
    expect(coalitionById([held], 'nope')).toBeUndefined();
  });
});

describe('standingIn', () => {
  it('lets a participant propose while they can propose in the group whose seat they hold', () => {
    const logs = new Logs();
    const at = formed(logs);
    const riverside = deviceGroup(logs, 'A', at, 'ana');
    expect(standingIn(heldBy(logs, at, 'kim'), [riverside])).toEqual({
      kind: 'proposes',
      groupId: riverside.groupId,
    });
  });

  it('only reads for a participant who can’t propose in that group, or is leaving it', () => {
    const logs = new Logs();
    const at = formed(logs);
    const ben = deviceGroup(logs, 'A', at, 'ben');
    expect(standingIn(heldBy(logs, at, 'kim'), [ben])).toEqual({ kind: 'reads' });
    const leaving = { ...deviceGroup(logs, 'A', at, 'ana'), leaving: true };
    expect(standingIn(heldBy(logs, at, 'kim'), [leaving])).toEqual({ kind: 'reads' });
    expect(standingIn(heldBy(logs, at, 'kim'), [])).toEqual({ kind: 'reads' });
  });

  it('offers Take part to someone in a member group who can propose, and nobody else', () => {
    const logs = new Logs();
    const at = formed(logs);
    const ana = deviceGroup(logs, 'A', at, 'ana');
    expect(standingIn(heldBy(logs, at, 'cal'), [ana])).toEqual({
      kind: 'take-part',
      groupId: ana.groupId,
    });
    // Ben votes but doesn't propose: no Take part, as on group home (#114).
    expect(standingIn(heldBy(logs, at, 'cal'), [deviceGroup(logs, 'A', at, 'ben')])).toEqual({
      kind: 'reads',
    });
  });

  it('offers no Take part before the coalition has formed', () => {
    const logs = new Logs();
    logs.group('A', R, ['ana'], 'Riverside');
    logs.reconcile('A', R + 3, 'ana', 'Riverside');
    logs.coalition(R + 10, ['Riverside', 'Oak St']);
    const ana = deviceGroup(logs, 'A', R + 11, 'ana');
    expect(standingIn(heldBy(logs, R + 11, 'cal'), [ana])).toEqual({ kind: 'reads' });
  });

  it('says joining while a join is planned or waits to send', () => {
    const logs = new Logs();
    const at = formed(logs);
    const ana = deviceGroup(logs, 'A', at, 'ana');
    expect(standingIn(heldBy(logs, at, 'cal', { joinAs: ana.groupId }), [ana])).toEqual({
      kind: 'joining',
    });
    const join = signEvent(testKeys('cal').secretKey, {
      type: 'join',
      group: logs.ids.coalition ?? '',
      ts: 0,
      body: { name: 'Cal', seat: 'x', proof: 'y' },
    });
    const waiting = heldBy(logs, at, 'cal', { outbox: [join.record, Uint8Array.of(1)] });
    expect(standingIn(waiting, [ana])).toEqual({ kind: 'joining' });
  });
});

describe('the coalition’s Document', () => {
  it('reads its sections by Document, and which of them has a motion open', () => {
    const logs = new Logs();
    const at = formed(logs);
    const genesis = logs.ids.coalition ?? '';
    const before = heldBy(logs, at, 'kim').state;
    expect(documentAtoms(before, genesis).map((a) => a.text)).toEqual([
      ...COALITION_STATEMENT.atoms,
    ]);
    expect(documentAtoms(before, 'another')).toEqual([]);
    expect(sectionIsOpen(before, `${genesis}.0`)).toBe(false);

    logs.motion(at, 'kim');
    expect(sectionIsOpen(heldBy(logs, at + 1, 'kim').state, `${genesis}.0`)).toBe(true);
  });
});

describe('a coalition’s home when a member is a coalition (#122)', () => {
  it('marks the member coalition, and opens a motion in a group beneath it on this device', () => {
    const logs = new NestedLogs();
    const motion = threeLevels(logs);
    const now = R + 100;
    const entry = (log: string, who: string) =>
      ({
        kind: 'coalition',
        groupId: deriveCoalitionEntryId(fromBase64url(testSecret(log))),
        me: { author: authorOf(who), name: who },
        outbox: [],
        log: logs.logs[log] ?? [],
        relayNow: now,
      }) as unknown as Group;
    const [c, d] = foldCoalitions([entry('C', 'cal'), entry('D', 'nobody')]);
    if (c === undefined || d === undefined) throw new Error('Expected C and D.');
    const groups: DeviceGroup[] = [
      deviceGroup(logs, 'A', now, 'ana'),
      {
        groupId: c.entry.groupId,
        me: authorOf('cal'),
        state: c.state,
        leaving: false,
        kind: 'coalition',
      },
    ];
    const view = coalitionHome(d, groups);
    expect(view?.members).toEqual([
      { name: 'C', mine: true, coalition: true },
      { name: 'E', mine: false, coalition: false },
    ]);
    // Its motion opens as the vote of group A, beneath Eastside Housing, never of the coalition.
    expect(view?.open.find((item) => item.id === motion)?.groupId).toBe(logs.ids.A);
    // Cal takes part in Eastside Housing, so may take part in Metro Renters through its seat.
    expect(standingIn(d, groups)).toEqual({ kind: 'take-part', groupId: c.entry.groupId });
  });
});
