/**
 * The year's simulation (#481) models the Bedfellows history in memory,
 * since Bedfellows may not import the store. This holds the model to the
 * store's own session (#480): for any run of weekly opens, views and marks,
 * both give the same dial, the same entries remembered, and the same marks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { marked, NEW_HISTORY, opened, showed, type SimulatedHistory } from '../bedfellows/simulate';
import {
  type BedfellowsState,
  createBedfellowsHistory,
  EMPTY_HISTORY,
  type HistoryStore,
} from './bedfellows';

const DAY = 86_400_000;
const SHELF = ['e1', 'e2', 'e3', 'e4', 'e5'];

/** A store with a vault that is always open, kept in memory. */
function memoryStore(): HistoryStore {
  let held: BedfellowsState = EMPTY_HISTORY;
  return {
    readBedfellows: () => Promise.resolve(held),
    keepBedfellows: (next) => {
      held = next;
      return Promise.resolve(true);
    },
    clearBedfellows: () => {
      held = EMPTY_HISTORY;
      return Promise.resolve();
    },
    subscribe: () => () => undefined,
  };
}

/** One visit: days after the last, the entries the view showed, and the marks the reader made. */
const visit = fc.record({
  gap: fc.integer({ min: 0, max: 40 }),
  shown: fc.subarray(SHELF),
  marks: fc.array(
    fc.tuple(
      fc.constantFrom(...SHELF),
      fc.constantFrom('common-ground' as const, 'too-far' as const),
    ),
    { maxLength: 3 },
  ),
});

/** The simulated history's remembered entries and marks, as the store's view lists them. */
function asView(history: SimulatedHistory) {
  return {
    dial: history.dial,
    shown: [...history.shown.keys()].sort(),
    leaveOut: [...history.shown].flatMap(([id, r]) => (r.mark === 'too-far' ? [id] : [])).sort(),
  };
}

describe('the simulation’s history and the store’s agree (#480, #481)', () => {
  it('gives the same dial, records and marks for any run of visits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(visit, { minLength: 1, maxLength: 12 }), async (visits) => {
        let now = Date.UTC(2027, 0, 4);
        const store = createBedfellowsHistory(memoryStore(), {
          now: () => now,
          random: (n) => new Uint8Array(n),
        });
        let simulated = NEW_HISTORY;
        for (const { gap, shown, marks } of visits) {
          now += gap * DAY;
          const date = new Date(now).toISOString().slice(0, 10);
          const view = await store.open(SHELF);
          simulated = opened(simulated, date);
          expect(asView(simulated)).toEqual({
            dial: view.dial,
            shown: [...view.shown].sort(),
            leaveOut: [...view.leaveOut].sort(),
          });
          await store.showed(shown);
          simulated = showed(simulated, shown, date);
          for (const [id, mark] of marks) {
            await store.mark(id, mark);
            simulated = marked(simulated, id, mark, date);
          }
        }
        const last = await store.read();
        expect(asView(simulated)).toEqual({
          dial: last.dial,
          shown: [...last.shown].sort(),
          leaveOut: [...last.leaveOut].sort(),
        });
      }),
    );
  });
});
