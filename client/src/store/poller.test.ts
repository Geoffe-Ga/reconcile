import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { manualTimers } from '../test/timers';
import { MAX_WAIT_MS, POLL_MS, createPoller } from './sync';
import type { Poller } from './sync';

/** Let every pending promise settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The listeners `target` gains and loses, as `[type, listener]`, sorted by type. */
function listenerSpies(target: EventTarget): {
  added: () => [string, unknown][];
  removed: () => [string, unknown][];
} {
  const add = vi.spyOn(target, 'addEventListener');
  const remove = vi.spyOn(target, 'removeEventListener');
  const byType = (calls: Parameters<EventTarget['addEventListener']>[]): [string, unknown][] =>
    calls
      .map(([type, listener]): [string, unknown] => [type, listener])
      .sort(([a], [b]) => a.localeCompare(b));
  return { added: () => byType(add.mock.calls), removed: () => byType(remove.mock.calls) };
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
    vi.restoreAllMocks();
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

  it('runs at once when the browser comes back online, with the backoff reset', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(false));
    poller = createPoller(run, clock.timers);
    poller.start();
    await settle();
    clock.fire();
    await settle();
    const backedOff = clock.waits();

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(backedOff).toEqual([12_000]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(clock.waits()).toEqual([6000]);
  });

  it('waits to be visible when it comes back online while hidden, with the backoff reset', async () => {
    const clock = manualTimers();
    const run = vi.fn(() => Promise.resolve(false));
    poller = createPoller(run, clock.timers);
    poller.start();
    await settle();
    clock.fire();
    await settle();
    setVisibility('hidden');

    window.dispatchEvent(new Event('online'));
    await settle();
    const whileHidden = run.mock.calls.length;
    setVisibility('visible');
    await settle();

    expect(whileHidden).toBe(2);
    expect(run).toHaveBeenCalledTimes(3);
    expect(clock.waits()).toEqual([6000]);
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
    window.dispatchEvent(new Event('online'));
    setVisibility('visible');
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.waits()).toEqual([]);
  });

  it('listens for focus, coming online and visibility, and stops listening once stopped', () => {
    const onWindow = listenerSpies(window);
    const onDocument = listenerSpies(document);
    poller = createPoller(() => Promise.resolve(true), manualTimers().timers);

    poller.start();
    poller.stop();

    expect(onWindow.added().map(([type]) => type)).toEqual(['focus', 'online']);
    expect(onDocument.added().map(([type]) => type)).toEqual(['visibilitychange']);
    expect(onWindow.removed()).toEqual(onWindow.added());
    expect(onDocument.removed()).toEqual(onDocument.added());
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
