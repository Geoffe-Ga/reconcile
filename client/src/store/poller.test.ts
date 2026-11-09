import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_WAIT_MS, POLL_MS, createPoller } from './sync';
import type { Poller, Timers } from './sync';

/** Timers that only fire when the test says so. */
function manualTimers(): { timers: Timers; waits: () => number[]; fire: () => void } {
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

/** Let every pending promise settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('the poller', () => {
  let poller: Poller | undefined;

  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    poller?.stop();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('runs at once when started, then every 3 seconds while visible', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(true));
    poller = createPoller(run, clock.timers);

    poller.start();
    await settle();
    clock.fire();
    await settle();

    expect(POLL_MS).toBe(3000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.waits()).toEqual([3000]);
  });

  it('doubles its wait after each failure, up to 30 seconds, and resets on success', async () => {
    const clock = manualTimers();
    const outcomes = [false, false, false, false, false, true];
    poller = createPoller(() => Promise.resolve(outcomes.shift() ?? true), clock.timers);
    const waits: number[] = [];

    poller.start();
    for (let i = 0; i < 6; i += 1) {
      await settle();
      waits.push(...clock.waits());
      clock.fire();
    }
    await settle();
    waits.push(...clock.waits());

    expect(MAX_WAIT_MS).toBe(30_000);
    expect(waits).toEqual([6000, 12_000, 24_000, 30_000, 30_000, 3000, 3000]);
  });

  it('treats a run that throws as a failure', async () => {
    const clock = manualTimers();
    poller = createPoller(() => Promise.reject(new Error('down')), clock.timers);

    poller.start();
    await settle();

    expect(clock.waits()).toEqual([6000]);
  });

  it('stops polling while hidden, and runs at once when visible again', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(true));
    poller = createPoller(run, clock.timers);
    poller.start();
    await settle();

    setVisibility('hidden');
    const hiddenWaits = clock.waits();
    setVisibility('visible');
    await settle();

    expect(hiddenWaits).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.waits()).toEqual([3000]);
  });

  it('waits for the page to be visible before its first run', async () => {
    setVisibility('hidden');
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(true));
    poller = createPoller(run, clock.timers);

    poller.start();
    await settle();

    expect(run).not.toHaveBeenCalled();
    expect(clock.waits()).toEqual([]);
  });

  it('schedules nothing after a run that ends while the page is hidden', async () => {
    const clock = manualTimers();
    let finish: (ok: boolean) => void = () => undefined;
    poller = createPoller(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      clock.timers,
    );
    poller.start();

    setVisibility('hidden');
    finish(true);
    await settle();

    expect(clock.waits()).toEqual([]);
  });

  it('runs at once on focus, replacing the waiting timer', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(true));
    poller = createPoller(run, clock.timers);
    poller.start();
    await settle();

    window.dispatchEvent(new Event('focus'));
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.waits()).toEqual([3000]);
  });

  it('never runs twice at once', async () => {
    const clock = manualTimers();
    let finish: (ok: boolean) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    poller = createPoller(run, clock.timers);
    poller.start();

    window.dispatchEvent(new Event('focus'));
    poller.start();
    finish(true);
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.waits()).toEqual([3000]);
  });

  it('does nothing once stopped', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(true));
    poller = createPoller(run, clock.timers);
    poller.start();
    await settle();

    poller.stop();
    window.dispatchEvent(new Event('focus'));
    setVisibility('visible');
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.waits()).toEqual([]);
  });

  it('schedules nothing when a run in flight ends after a stop', async () => {
    const clock = manualTimers();
    let finish: (ok: boolean) => void = () => undefined;
    poller = createPoller(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      clock.timers,
    );
    poller.start();

    poller.stop();
    finish(true);
    await settle();

    expect(clock.waits()).toEqual([]);
  });
});
