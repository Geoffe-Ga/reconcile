/**
 * Timers for tests of the sync loop's poller: nothing fires until the test
 * says so, so a test steps through the schedule without waiting in real time.
 */

import type { Timers } from '../store/sync';

/** The timers to hand the poller, and the test's handle on them. */
export interface ManualTimers {
  /** The timers the poller uses. */
  readonly timers: Timers;
  /** The wait of each timer still waiting, oldest first. */
  waits(): number[];
  /** Fire the oldest waiting timer; throws when none is waiting. */
  fire(): void;
}

/** Timers that only fire when the test says so. */
export function manualTimers(): ManualTimers {
  const waiting = new Map<number, { callback: () => void; ms: number }>();
  let last = 0;
  return {
    timers: {
      setTimeout: (callback, ms) => {
        last += 1;
        waiting.set(last, { callback, ms });
        return last;
      },
      clearTimeout: (handle) => {
        waiting.delete(handle);
      },
    },
    waits: () => [...waiting.values()].map((entry) => entry.ms),
    fire: () => {
      const [entry] = waiting;
      if (entry === undefined) {
        throw new Error('no timer is waiting');
      }
      waiting.delete(entry[0]);
      entry[1].callback();
    },
  };
}
