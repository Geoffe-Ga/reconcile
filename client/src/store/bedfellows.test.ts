/**
 * The Bedfellows history (#480; ADR-0080 §5): what it keeps, how it expires,
 * how marks nudge the dial, and that it writes only when asked to flush, on a
 * store faked in memory. `db.bedfellows.test.ts` covers the sealed slot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_HISTORY_PLAINTEXT } from '../crypto/history';
import { TOP } from '../bedfellows/mix';
import {
  BEDFELLOWS_CLEARED,
  type BedfellowsState,
  createBedfellowsHistory,
  decodeHistory,
  EMPTY_HISTORY,
  encodeHistory,
  expireHistory,
  flushWhenHidden,
  HISTORY_DAYS,
  type HistoryStore,
} from './bedfellows';
import { VaultLocked } from './db';

const DAY = 86_400_000;
const MINUTE = 60_000;
/** 2026-11-18, a Wednesday, at 09:30 UTC. */
const START = Date.UTC(2026, 10, 18, 9, 30);
/** The day START falls on, counted from 1970-01-01. */
const START_DAY = Math.floor(START / DAY);

/** A device clock a test moves by hand. */
function testClock(at = START) {
  let now = at;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    advanceDays(days: number) {
      now += days * DAY;
    },
  };
}

/** Random bytes that count up from `first`, so each seed drawn differs. */
function countingRandom(first = 1) {
  let next = first;
  return (length: number) => Uint8Array.from({ length }, () => next++ % 256);
}

/** A store faked in memory: `vault` says whether it has one, and `locked` whether it's open. */
function fakeStore(options: { vault?: boolean; locked?: boolean; held?: BedfellowsState } = {}) {
  const listeners = new Set<(changed: string) => void>();
  const state = {
    vault: options.vault ?? true,
    locked: options.locked ?? false,
    held: options.held ?? EMPTY_HISTORY,
    writes: [] as BedfellowsState[],
    reads: 0,
  };
  const store: HistoryStore = {
    readBedfellows() {
      state.reads += 1;
      if (!state.vault) return Promise.resolve(null);
      if (state.locked) return Promise.reject(new VaultLocked());
      return Promise.resolve(state.held);
    },
    keepBedfellows(next) {
      if (!state.vault) return Promise.resolve(false);
      if (state.locked) return Promise.reject(new VaultLocked());
      state.held = next;
      state.writes.push(next);
      return Promise.resolve(true);
    },
    clearBedfellows() {
      if (state.vault && state.locked) return Promise.reject(new VaultLocked());
      if (state.vault) {
        state.held = EMPTY_HISTORY;
        state.writes.push(EMPTY_HISTORY);
      }
      for (const listener of listeners) listener(BEDFELLOWS_CLEARED);
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { store, state, listeners };
}

const SHELF = ['e1', 'e2', 'e3', 'e4'];

describe('what the history keeps (#480)', () => {
  it('spells only ids, days, marks, the dial, the week of its last step and the seed', () => {
    const state: BedfellowsState = {
      dial: 3,
      lastStepWeek: 2915,
      seed: 12345,
      shown: [
        { id: 'e1', day: START_DAY, mark: 'too-far' },
        { id: 'e2', day: START_DAY - 1 },
        { id: 'e3', day: START_DAY, mark: 'common-ground' },
      ],
    };
    const plaintext = encodeHistory(state);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      format: 1,
      dial: 3,
      week: 2915,
      seed: 12345,
      shown: [
        ['e1', START_DAY, 'too-far'],
        ['e2', START_DAY - 1],
        ['e3', START_DAY, 'common-ground'],
      ],
    });
    expect(decodeHistory(plaintext)).toEqual(state);
  });

  it('reads an empty history back as one, with no week and no seed', () => {
    expect(decodeHistory(encodeHistory(EMPTY_HISTORY))).toEqual(EMPTY_HISTORY);
    expect(EMPTY_HISTORY).toEqual({ dial: 0, lastStepWeek: null, seed: null, shown: [] });
  });

  it.each([
    ['not JSON', 'nope'],
    ['another format', '{"format":2,"dial":0,"week":null,"seed":null,"shown":[]}'],
    [
      'a dial past the top',
      `{"format":1,"dial":${String(TOP + 1)},"week":null,"seed":null,"shown":[]}`,
    ],
    ['a fractional dial', '{"format":1,"dial":1.5,"week":null,"seed":null,"shown":[]}'],
    ['a negative week', '{"format":1,"dial":0,"week":-1,"seed":null,"shown":[]}'],
    ['a seed past 32 bits', '{"format":1,"dial":0,"week":null,"seed":4294967296,"shown":[]}'],
    ['a list that isn’t one', '{"format":1,"dial":0,"week":null,"seed":null,"shown":{}}'],
    ['an unknown mark', '{"format":1,"dial":0,"week":null,"seed":null,"shown":[["e1",1,"maybe"]]}'],
    ['an empty id', '{"format":1,"dial":0,"week":null,"seed":null,"shown":[["",1]]}'],
    ['a fractional day', '{"format":1,"dial":0,"week":null,"seed":null,"shown":[["e1",1.5]]}'],
    [
      'a record too long',
      '{"format":1,"dial":0,"week":null,"seed":null,"shown":[["e1",1,"too-far",0]]}',
    ],
    ['an entry twice', '{"format":1,"dial":0,"week":null,"seed":null,"shown":[["e1",1],["e1",2]]}'],
    [
      'a field it doesn’t know',
      '{"format":1,"dial":0,"week":null,"seed":null,"shown":[],"text":"x"}',
    ],
  ])('refuses a history with %s', (_, json) => {
    expect(decodeHistory(new TextEncoder().encode(json))).toBeNull();
  });

  it('refuses an id longer than an entry id can be', () => {
    const id = 'x'.repeat(129);
    const json = `{"format":1,"dial":0,"week":null,"seed":null,"shown":[["${id}",1]]}`;
    expect(decodeHistory(new TextEncoder().encode(json))).toBeNull();
    expect(() => encodeHistory({ ...EMPTY_HISTORY, shown: [{ id, day: 1 }] })).toThrow(RangeError);
  });

  it('forgets the oldest records first when more than the slot holds were shown', () => {
    const shown = Array.from({ length: 2000 }, (_, i) => ({
      id: `entry-${String(i).padStart(4, '0')}-${'x'.repeat(40)}`,
      day: START_DAY - 29 + Math.floor(i / 70),
    }));
    const plaintext = encodeHistory({ ...EMPTY_HISTORY, shown });
    expect(plaintext.length).toBeLessThanOrEqual(MAX_HISTORY_PLAINTEXT);
    const kept = decodeHistory(plaintext)?.shown ?? [];
    expect(kept.length).toBeGreaterThan(500);
    expect(kept.length).toBeLessThan(2000);
    // The newest record stays, and every record dropped is no newer than every one kept.
    expect(kept.map((entry) => entry.id)).toContain(shown[1999]?.id);
    const oldestKept = Math.min(...kept.map((entry) => entry.day));
    const dropped = shown.filter((entry) => !kept.some((held) => held.id === entry.id));
    expect(dropped.every((entry) => entry.day <= oldestKept)).toBe(true);
  });
});

describe('expiry (#480)', () => {
  const day0 = (day: number) => ({ ...EMPTY_HISTORY, shown: [{ id: 'e1', day }] });

  it('keeps a record 30 days less a minute after its first day starts, and forgets it at 30 days', () => {
    expect(HISTORY_DAYS).toBe(30);
    const start = START_DAY * DAY;
    expect(expireHistory(day0(START_DAY), start + 30 * DAY - MINUTE).shown).toHaveLength(1);
    expect(expireHistory(day0(START_DAY), start + 30 * DAY).shown).toEqual([]);
  });

  it('forgets a record whose entry left the shelf at once, and keeps those still on it', () => {
    const state = {
      ...EMPTY_HISTORY,
      shown: [
        { id: 'e1', day: START_DAY },
        { id: 'gone', day: START_DAY, mark: 'too-far' as const },
      ],
    };
    expect(expireHistory(state, START, new Set(['e1'])).shown).toEqual([
      { id: 'e1', day: START_DAY },
    ]);
  });

  it('hands back the same state when nothing expired, so a sweep can tell it has nothing to write', () => {
    const state = day0(START_DAY);
    expect(expireHistory(state, START, new Set(['e1']))).toBe(state);
  });
});

describe('the session’s history (#480)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does as the issue’s example says: a mark leaves the entry out, and 31 days forget it', async () => {
    const clock = testClock();
    const { store } = fakeStore();
    const history = createBedfellowsHistory(store, { now: clock.now, random: countingRandom() });
    await history.mark('e1', 'too-far');
    expect((await history.read()).leaveOut).toContain('e1');
    clock.advanceDays(31);
    await history.sweep(SHELF);
    expect((await history.read()).shown).toEqual([]);
  });

  it('records each entry once, on the day it was first shown, and reads them back as shown', async () => {
    const clock = testClock();
    const { store } = fakeStore();
    const history = createBedfellowsHistory(store, { now: clock.now, random: countingRandom() });
    await history.showed(['e1', 'e2']);
    clock.advanceDays(2);
    await history.showed(['e2', 'e3']);
    await history.flush();
    const view = await history.read();
    expect(view.shown).toEqual(['e1', 'e2', 'e3']);
    const { state } = await persisted(history, store);
    expect(state.shown).toEqual([
      { id: 'e1', day: START_DAY },
      { id: 'e2', day: START_DAY },
      { id: 'e3', day: START_DAY + 2 },
    ]);
  });

  it('nudges the dial out for common ground and in for too far, one step each, never past an end', async () => {
    const { store } = fakeStore({ held: { ...EMPTY_HISTORY, dial: 2, seed: 9 } });
    const history = createBedfellowsHistory(store, { now: testClock().now });
    await history.mark('e1', 'common-ground');
    expect((await history.read()).dial).toBe(3);
    await history.mark('e2', 'too-far');
    await history.mark('e3', 'too-far');
    expect((await history.read()).dial).toBe(1);
    await history.setDial(TOP);
    await history.mark('e4', 'common-ground');
    expect((await history.read()).dial).toBe(TOP);
    await history.resetDial();
    await history.mark('e1', 'too-far');
    expect((await history.read()).dial).toBe(0);
  });

  it('takes a mark back without moving the dial, and a taken-back too far is shown again', async () => {
    const { store } = fakeStore({ held: { ...EMPTY_HISTORY, dial: 4, seed: 9 } });
    const history = createBedfellowsHistory(store, { now: testClock().now });
    await history.mark('e1', 'too-far');
    expect((await history.read()).leaveOut).toEqual(['e1']);
    await history.mark('e1', null);
    const view = await history.read();
    expect(view.leaveOut).toEqual([]);
    expect(view.marks.size).toBe(0);
    expect(view.dial).toBe(3);
    expect(view.shown).toEqual(['e1']);
  });

  it('marks the same way twice with one nudge, and keeps common ground out of leaveOut', async () => {
    const { store } = fakeStore({ held: { ...EMPTY_HISTORY, dial: 4, seed: 9 } });
    const history = createBedfellowsHistory(store, { now: testClock().now });
    await history.mark('e1', 'common-ground');
    await history.mark('e1', 'common-ground');
    const view = await history.read();
    expect(view.dial).toBe(5);
    expect(view.leaveOut).toEqual([]);
    expect(view.marks.get('e1')).toBe('common-ground');
  });

  it('writes nothing on a tap: only a flush writes, once, and only when something changed', async () => {
    const { store, state } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.open(SHELF);
    await history.showed(['e1', 'e2']);
    await history.mark('e1', 'common-ground');
    await history.setDial(5);
    expect(state.writes).toEqual([]);
    await history.flush();
    expect(state.writes).toHaveLength(1);
    await history.flush();
    expect(state.writes).toHaveLength(1);
    await history.mark('e2', 'too-far');
    await history.flush();
    expect(state.writes).toHaveLength(2);
  });

  it('reads the store once a session, and keeps what it read', async () => {
    const held: BedfellowsState = {
      dial: 2,
      lastStepWeek: 0,
      seed: 77,
      shown: [{ id: 'e1', day: START_DAY, mark: 'too-far' }],
    };
    const { store, state } = fakeStore({ held });
    const history = createBedfellowsHistory(store, { now: testClock().now });
    const view = await history.read();
    await history.read();
    expect(state.reads).toBe(1);
    expect(view).toEqual({
      dial: 2,
      seed: 77,
      shown: ['e1'],
      leaveOut: ['e1'],
      marks: new Map([['e1', 'too-far']]),
    });
  });

  it('starts a device’s first view at dial 0 with a random seed, and steps once per week opened', async () => {
    const clock = testClock();
    const { store } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: clock.now,
      random: () => Uint8Array.of(0, 0, 1, 2),
    });
    let view = await history.open(SHELF);
    expect(view.dial).toBe(0);
    expect(view.seed).toBe(258);
    clock.advanceDays(1);
    expect((await history.open(SHELF)).dial).toBe(0);
    clock.advanceDays(7);
    expect((await history.open(SHELF)).dial).toBe(1);
    expect((await history.open(SHELF)).dial).toBe(1);
    // Weeks away count as one step: the pace is per week of use.
    clock.advanceDays(70);
    view = await history.open(SHELF);
    expect(view.dial).toBe(2);
    expect(view.seed).toBe(258);
  });

  it('sweeps by the shelf and by age each time it opens', async () => {
    const clock = testClock();
    const held: BedfellowsState = {
      ...EMPTY_HISTORY,
      seed: 1,
      shown: [
        { id: 'e1', day: START_DAY - 30 },
        { id: 'e2', day: START_DAY - 29 },
        { id: 'gone', day: START_DAY },
      ],
    };
    const { store } = fakeStore({ held });
    const history = createBedfellowsHistory(store, { now: clock.now });
    expect((await history.open(SHELF)).shown).toEqual(['e2']);
  });

  it('with no vault, keeps everything in memory for the session and writes nothing', async () => {
    const { store, state } = fakeStore({ vault: false });
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.open(SHELF);
    await history.mark('e1', 'common-ground');
    await history.flush();
    expect(state.writes).toEqual([]);
    const view = await history.read();
    expect(view.dial).toBe(1);
    expect(view.marks.get('e1')).toBe('common-ground');
    // A new page knows none of it.
    const next = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(9),
    });
    expect((await next.read()).marks.size).toBe(0);
  });

  it('while the vault is locked, refuses a write and keeps the change in memory, not in the clear', async () => {
    const { store, state } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.open(SHELF);
    await history.mark('e1', 'too-far');
    state.locked = true;
    await expect(history.flush()).rejects.toBeInstanceOf(VaultLocked);
    expect(state.writes).toEqual([]);
    state.locked = false;
    await history.flush();
    expect(state.writes).toHaveLength(1);
    expect(state.held.shown).toEqual([{ id: 'e1', day: START_DAY, mark: 'too-far' }]);
  });

  it('opens nothing on a locked device', async () => {
    const { store } = fakeStore({ locked: true });
    const history = createBedfellowsHistory(store, { now: testClock().now });
    await expect(history.open(SHELF)).rejects.toBeInstanceOf(VaultLocked);
  });

  it('clears every record, the dial and the seed, and the next view starts at 0 with a new seed', async () => {
    const { store, state } = fakeStore({
      held: { dial: 5, lastStepWeek: 1, seed: 1, shown: [{ id: 'e1', day: START_DAY }] },
    });
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(40),
    });
    await history.mark('e2', 'too-far');
    await history.clear();
    expect(state.held).toEqual(EMPTY_HISTORY);
    const view = await history.open(SHELF);
    expect(view).toMatchObject({ dial: 0, shown: [], leaveOut: [] });
    expect(view.seed).not.toBe(1);
    // The cleared changes aren't written back by a later flush.
    await history.flush();
    expect(state.held.shown).toEqual([]);
  });

  it('forgets what it holds when the store says the history was cleared elsewhere', async () => {
    const { store, state, listeners } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.mark('e1', 'too-far');
    await store.clearBedfellows();
    expect((await history.read()).leaveOut).toEqual([]);
    await history.flush();
    expect(state.held).toMatchObject({ dial: 0, shown: [] });
    history.close();
    expect(listeners.size).toBe(0);
  });

  it('ignores what the store says of anything else', async () => {
    const { store, listeners } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.mark('e1', 'too-far');
    for (const listener of listeners) listener('relay-backup');
    expect((await history.read()).leaveOut).toEqual(['e1']);
  });
});

describe('flushing when the view closes or the app is hidden (#480)', () => {
  it('flushes once each time the page is hidden or goes away, and stops when asked', async () => {
    const { store, state } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.mark('e1', 'common-ground');
    const target = new EventTarget();
    let visibility: DocumentVisibilityState = 'visible';
    const stop = flushWhenHidden(history, { target, visibility: () => visibility });
    target.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(state.writes).toHaveLength(0);
    visibility = 'hidden';
    target.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => {
      expect(state.writes).toHaveLength(1);
    });
    await history.mark('e2', 'too-far');
    target.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => {
      expect(state.writes).toHaveLength(2);
    });
    stop();
    await history.mark('e3', 'too-far');
    target.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(state.writes).toHaveLength(2);
  });

  it('listens on the window by default, where the page’s pagehide and visibilitychange arrive', async () => {
    const { store, state } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.mark('e1', 'common-ground');
    const stop = flushWhenHidden(history);
    // jsdom's page stays visible, so a visibility change alone writes nothing.
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await Promise.resolve();
    expect(state.writes).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => {
      expect(state.writes).toHaveLength(1);
    });
    stop();
  });

  it('keeps a refused flush in memory and says nothing', async () => {
    const { store, state } = fakeStore();
    const history = createBedfellowsHistory(store, {
      now: testClock().now,
      random: countingRandom(),
    });
    await history.mark('e1', 'common-ground');
    state.locked = true;
    const target = new EventTarget();
    flushWhenHidden(history, { target, visibility: () => 'hidden' });
    target.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.writes).toEqual([]);
  });
});

/** What `store` keeps once `history` flushed. */
async function persisted(history: { flush(): Promise<void> }, store: HistoryStore) {
  await history.flush();
  const state = await store.readBedfellows();
  if (state === null) throw new Error('Expected a vault.');
  return { state };
}
