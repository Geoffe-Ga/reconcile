/**
 * Dispatches rising through coalitions (#126; ADR-0037, ADR-0071, ADR-0075
 * §1): how far a Dispatch goes for each ceiling, and properties (fast-check)
 * of what crosses each line. The golden vectors in vectors/promote-*.json
 * pin the exact cases.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NESTED_STATEMENTS, NestedLogs, seatKey, threeLevels } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { LEVELS } from './capabilities';
import { MAX_LEVEL, motionHorizon, promotionFits, withinCeiling } from './coalition';
import { promotionsOwed, resultsToReport } from './crossing';
import { type Ceiling, CEILINGS, type PromoteProposalBody } from './event';
import type { GroupState } from './fold';

const R = 29_375_000;

/** The creating level, so each joiner may vote at once. */
const [, , CREATING] = LEVELS;

const WORDS = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };

/** The state of `log` in `states`, failing the test when there is none. */
function stateOf(states: Record<string, GroupState>, log: string): GroupState {
  const state = states[log];
  if (state === undefined) throw new Error(`no log is named "${log}"`);
  return state;
}

/** The deadline of the Proposal `id` in `state`, failing the test when there is none. */
function deadlineOf(state: GroupState, id: string): number {
  const proposal = state.proposals.find((p) => p.id === id);
  if (proposal === undefined) throw new Error(`no Proposal ${id}`);
  return proposal.deadline;
}

/**
 * The coalitions above group A, nearest first (#122's three levels): each
 * name, the lower log whose seat it is, the participant bound to that seat,
 * and the other seat's participant.
 */
const LINES = [
  { log: 'C', lower: 'A', bound: 'cal', other: ['dee', 'B'] },
  { log: 'D', lower: 'C', bound: 'fay', other: ['hal', 'E'] },
  { log: 'F', lower: 'D', bound: 'ivy', other: ['jon', 'G'] },
] as const;

/**
 * A puts a Dispatch with `ceiling` to its vote and passes it; then, line by
 * line, the participant bound to the lower seat posts whatever record the
 * lower log owes, the lower seat's result on it is what its own fold says,
 * and the other seat passes it. The next line's record goes up once that
 * pass is final, at the motion's horizon there (#387). Returns the
 * coalitions a record reached.
 */
function rise(ceiling: Ceiling): string[] {
  const logs = new NestedLogs();
  threeLevels(logs);
  const p = logs.dispatchVote('A', R + 30, 'ana', ceiling, WORDS);
  logs.vote('A', R + 31, 'ana', p, 4);
  const reached: string[] = [];
  let at = R + 32;
  for (const { log, lower, bound, other } of LINES) {
    const states = logs.foldAll((at += 1));
    const below = stateOf(states, lower);
    const [record] = promotionsOwed(below, stateOf(states, log), seatKey(lower));
    if (record === undefined) break;
    const motion = logs.promoteIn(log, (at += 1), bound, record);
    const after = logs.foldAll(at);
    const owed = resultsToReport(stateOf(after, lower), stateOf(after, log), seatKey(lower));
    expect(owed, `${lower} → ${log}`).toContainEqual({
      motion,
      seat: seatKey(lower),
      result: 'pass',
    });
    logs.resultIn(log, (at += 1), bound, motion, lower, 'pass');
    logs.resultIn(log, at, other[0], motion, other[1], 'pass');
    reached.push(log);
    const decided = stateOf(logs.foldAll(at), log);
    at = motionHorizon(decided.coalition, { id: motion, deadline: deadlineOf(decided, motion) });
  }
  return reached;
}

describe('how far a Dispatch rises (#126)', () => {
  it.each([
    [1, ['C']],
    [2, ['C', 'D']],
    ['coalitions', ['C', 'D', 'F']],
  ] as const)(
    'with ceiling %s, reaches %j, and nothing past it: F, at level 3, has nothing above',
    (ceiling, reached) => {
      expect(rise(ceiling)).toEqual(reached);
    },
  );

  it('keeps every level within the ceiling and within level 3', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_LEVEL + 2 }),
        fc.constantFrom(...CEILINGS),
        fc.integer({ min: 0, max: MAX_LEVEL }),
        (level, ceiling, below) => {
          const fits = promotionFits({ level, ceiling }, { level: below });
          const lowest = below === 0 ? 1 : 2;
          const expected =
            level >= lowest &&
            level <= below + 1 &&
            level <= MAX_LEVEL &&
            withinCeiling(level, ceiling);
          expect(fits).toBe(expected);
        },
      ),
    );
  });
});

/** A record body as JSON: every key and value it carries. */
function serialized(body: PromoteProposalBody): string {
  return JSON.stringify(body);
}

/** Every key at every depth of a JSON value, sorted, as "path.key". */
function keysOf(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value)
    .flatMap(([key, inner]) => [`${path}${key}`, ...keysOf(inner, `${path}${key}.`)])
    .sort();
}

/** A one-line canary: text no record may carry, whatever it is. */
const canary = fc.stringMatching(/^[a-z]{6,12}$/).map((word) => `canary-${word}`);

describe('what a promotion record carries across a line (#126)', () => {
  it('holds exactly the Dispatch’s id, title and text, its ceiling, level and seat, and nothing of the group below (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          ceiling: fc.constantFrom(...CEILINGS),
          proposalTitle: canary,
          why: canary,
          notes: fc.array(canary, { minLength: 2, maxLength: 2 }),
          names: fc.array(canary, { minLength: 2, maxLength: 2 }),
        }),
        ({ ceiling, proposalTitle, why, notes, names }) => {
          const logs = new NestedLogs();
          const { C } = NESTED_STATEMENTS;
          logs.group('A', R, ['ana'], 'Riverside');
          const into = logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', C);
          logs.vote('A', R + 2, 'ana', into, 4);
          names.forEach((name, i) => {
            const who = i === 0 ? 'gus' : 'ivy';
            logs.add('A', R + 3, who, { type: 'join', body: { name, level: CREATING } });
          });
          logs.formedIn('C', R + 4, [['A'], ['B']], ['cal', 'dee'], C);
          const p = logs.dispatchVote('A', R + 10, 'ana', ceiling, WORDS, {
            title: proposalTitle,
            why,
          });
          logs.vote('A', R + 11, 'ana', p, 4);
          logs.vote('A', R + 11, 'gus', p, 3, notes[0]);
          logs.vote('A', R + 12, 'ivy', p, 2, notes[1]);
          const states = logs.foldAll(R + 13);
          const owed = promotionsOwed(stateOf(states, 'A'), stateOf(states, 'C'), seatKey('A'));
          expect(owed).toHaveLength(1);
          const [record] = owed;
          if (record === undefined) return;
          expect(keysOf(record)).toEqual([
            'target',
            'target.ceiling',
            'target.dispatch',
            'target.dispatch.id',
            'target.dispatch.text',
            'target.dispatch.title',
            'target.from',
            'target.kind',
            'target.level',
            'title',
            'why',
          ]);
          const from = seatKey('A');
          expect(record).toEqual({
            target: { kind: 'promote', dispatch: { id: p, ...WORDS }, ceiling, level: 1, from },
            title: WORDS.title,
            why: '',
          });
          const text = serialized(record);
          for (const secret of [proposalTitle, why, ...notes, ...names]) {
            expect(text).not.toContain(secret);
          }
          for (const voter of ['ana', 'gus', 'ivy']) expect(text).not.toContain(authorOf(voter));
        },
      ),
      { numRuns: 25 },
    );
  });

  it('gets pass from its seat only when it says exactly what the seat passed, whatever is altered (property)', () => {
    const altered = fc.record({
      id: fc.boolean(),
      title: fc.boolean(),
      text: fc.boolean(),
      ceiling: fc.boolean(),
    });
    fc.assert(
      fc.property(altered, (change) => {
        const run = new NestedLogs();
        threeLevels(run);
        const q = run.dispatchVote('A', R + 30, 'ana', 2, WORDS);
        run.vote('A', R + 31, 'ana', q, 4);
        const id = change.id ? `${q}x` : q;
        const title = change.title ? `${WORDS.title}!` : WORDS.title;
        const text = change.text ? `${WORDS.text} Bring water.` : WORDS.text;
        const ceiling: Ceiling = change.ceiling ? 'coalitions' : 2;
        const words = { title, text };
        const body: PromoteProposalBody = {
          target: {
            kind: 'promote',
            dispatch: { id, ...words },
            ceiling,
            level: 1,
            from: seatKey('A'),
          },
          title,
          why: '',
        };
        const motion = run.promoteIn('C', R + 32, 'cal', body);
        const states = run.foldAll(R + 33);
        const [result] = resultsToReport(stateOf(states, 'A'), stateOf(states, 'C'), seatKey('A'))
          .filter((owed) => owed.motion === motion)
          .map((owed) => owed.result);
        const same = !Object.values(change).includes(true);
        expect(result).toBe(same ? 'pass' : 'fail');
      }),
      { numRuns: 30 },
    );
  });
});
