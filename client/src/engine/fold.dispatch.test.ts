/**
 * Dispatches in the fold (#112): the issue's own example, and properties
 * (fast-check) that hold whatever the lengths, scores and timing. The golden
 * vectors in vectors/dispatch-*.json pin the exact cases.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { vector } from '../test/vectors';
import { deadlineOf, groupLog } from '../test/votes';
import { DISPATCH_TEXT_MAX, DISPATCH_TITLE_MAX } from './dispatches';
import type { Score } from './event';
import { closeTime, fold, type GroupState, type Proposal } from './fold';

/** The one Proposal in `state`. */
function onlyProposal(state: GroupState): Proposal {
  const [proposal] = state.proposals;
  if (proposal === undefined) throw new Error('Expected a Proposal.');
  return proposal;
}

/** A character and how many times it repeats: that many code points, NFC already. */
const repeated = (max: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.constantFrom('a', 'é', '\u{1F600}', 'א'))
    .map(([count, char]) => ({ count, text: char.repeat(count) }));

describe('Dispatches in the fold (#112)', () => {
  it('sends a passing Proposal’s Dispatch at its close: A proposes with one, A and B score 4 and 3, and B’s ballot closes it', () => {
    const { records, ids, relayNow } = vector('dispatch-carried-pass');
    const P = ids.get(3);
    const G = ids.get(1);
    const closedAt = 29_400_030;
    expect(fold(records, relayNow).dispatches).toEqual([
      {
        id: P,
        by: { proposal: P },
        title: 'Updated: Mission statement',
        text: '',
        doc: G,
        received: closedAt,
      },
    ]);
    const lapse = vector('dispatch-carried-lapse');
    expect(fold(lapse.records, lapse.relayNow).dispatches).toEqual([]);
  });

  it('keeps a Co-Creator’s Dispatch exactly when its title is 1–80 code points and its text at most 500 (property)', () => {
    fc.assert(
      fc.property(
        repeated(DISPATCH_TITLE_MAX + 3),
        repeated(DISPATCH_TEXT_MAX + 3),
        (title, text) => {
          const log = groupLog();
          const id = log.dispatch('Ana', { title: title.text, text: text.text });
          const fits =
            title.count >= 1 &&
            title.count <= DISPATCH_TITLE_MAX &&
            text.count <= DISPATCH_TEXT_MAX;
          const kept = log.state().dispatches.map((dispatch) => dispatch.id);
          expect(kept).toEqual(fits ? [id] : []);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('sends a carried Dispatch exactly when the Proposal’s outcome is a final pass, at its close (property)', () => {
    const score = fc.option(fc.constantFrom<Score>(0, 1, 2, 3, 4), { nil: null });
    const scenario = fc.record({
      scores: fc.array(score, { minLength: 3, maxLength: 3 }),
      atDeadline: fc.boolean(),
    });
    fc.assert(
      fc.property(scenario, ({ scores, atDeadline }) => {
        const log = groupLog({ members: ['Ben', 'Cal'] });
        const dispatch = { title: 'Updated: House rules', text: 'Quiet hours moved.' };
        const opened = log.minute;
        const proposal = log.propose('Ana', { dispatch });
        ['Ana', 'Ben', 'Cal'].forEach((name, index) => {
          const given = scores[index] ?? null;
          if (given === null) return;
          log.minute += 1;
          log.vote(name, proposal, given, given === 0 ? 'Not this way.' : undefined);
        });
        const state = log.state(atDeadline ? deadlineOf(opened) : log.minute);
        const found = onlyProposal(state);
        const passed = found.final && found.outcome.kind === 'pass';
        const sent = { id: proposal, by: { proposal }, ...dispatch, doc: log.group };
        expect(state.dispatches).toEqual(passed ? [{ ...sent, received: closeTime(found) }] : []);
      }),
      { numRuns: 80 },
    );
  });

  it('places a carried Dispatch after every one received before its close and ahead of every one from its close on (property)', () => {
    const offsets = fc.array(fc.integer({ min: 1, max: 10_080 + 40 }), { maxLength: 6 });
    fc.assert(
      fc.property(offsets, (picked) => {
        // Four voters, so three 4s meet quorum and the vote runs to its deadline.
        const log = groupLog({ members: ['Ben', 'Cal', 'Dee'] });
        const opened = log.minute;
        const proposal = log.propose('Ana', { dispatch: { title: 'Updated', text: '' } });
        for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
        for (const offset of [...picked].sort((a, b) => a - b)) {
          log.minute = opened + offset;
          log.dispatch('Ben', { title: `At ${String(offset)}`, text: '' });
        }
        const deadline = deadlineOf(opened);
        const state = log.state(deadline + 50);
        const order = state.dispatches.map((d) => [typeof d.by === 'string', d.received] as const);
        const received = order.map(([, minute]) => minute);
        expect(received).toEqual([...received].sort((a, b) => a - b));
        const at = order.findIndex(([fromMember]) => !fromMember);
        expect(order[at]).toEqual([false, deadline]);
        expect(order.slice(0, at).every(([, minute]) => minute < deadline)).toBe(true);
        expect(order.slice(at + 1).every(([, minute]) => minute >= deadline)).toBe(true);
        expect(state.dispatches.filter((d) => d.by === authorOf('ben'))).toHaveLength(
          picked.length,
        );
      }),
      { numRuns: 40 },
    );
  });
});
