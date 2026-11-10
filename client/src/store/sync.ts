/**
 * The sync loop (spec §7): framework-free, so the UI only reads the store.
 *
 * While the page is visible, a pass runs every 3 seconds, and at once on focus.
 * After a failure the wait doubles, up to 30 seconds. When the browser comes
 * back online the wait resets and a pass runs at once, so an event saved
 * offline doesn't sit out the backoff. Each pass, for each group:
 *
 * 1. posts the outbox in order, each record sealed for the group's mailbox,
 *    removing an entry only once the relay accepts it;
 * 2. reads every record after the cursor, opens each blob (skipping one that
 *    won't open), and appends each event the log doesn't hold yet;
 * 3. saves the cursor, the relay's time and instance, and when it synced;
 * 4. then (#111, ./expiry.ts) posts a result for each closed Proposal that
 *    has none, after re-syncing once to be sure, and clears every ballot
 *    that has expired. Folding the log for this costs a signature check per
 *    record, so a group is checked once per relay minute: the duty waits for
 *    the minute after a close, and expiry for a minute, anyway.
 *
 * The mailbox id and seal key are derived from the group's secret on each
 * pass (spec §3); the store keeps only the secret. The cursor moves past a
 * blob that won't open, so one bad blob never stalls a group.
 *
 * A relay `instance` the group hasn't seen means a fresh relay database: the
 * cursor goes back to 0, the outbox is posted again, and the log's dedupe by
 * event id keeps any event from folding twice. Folded state comes from the
 * log alone, so an event still in the outbox is pending and never folded.
 */

import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import type { Seal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import type { Relay, RelayRecord } from '../net/relay';
import type { LogRecord } from '../engine/fold';
import type { EventIdOf, Group, Pull, Store } from './db';
import { eventIdOf } from './eventId';
import { clearExpiredBallots, foldGroup, resultsDue, signResults } from './expiry';

/** The wait between passes while they succeed. */
export const POLL_MS = 3000;

/** The longest wait after repeated failures. */
export const MAX_WAIT_MS = 30_000;

/** How long the relay keeps a group's events, in days (ADR-0057). */
export const GROUP_TTL_DAYS = 30;

/** The timer functions the poller uses; tests hand in ones they control. */
export interface Timers {
  /** Call `callback` after `ms`, returning a handle for `clearTimeout`. */
  setTimeout(callback: () => void, ms: number): number;
  /** Cancel a waiting callback. */
  clearTimeout(handle: number): void;
}

/** Something that runs a job on a schedule. */
export interface Poller {
  /** Begin: run at once if the page is visible, and listen for visibility, focus and `online`. */
  start(): void;
  /** Stop running and listening. */
  stop(): void;
}

const browserTimers: Timers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    window.clearTimeout(handle);
  },
};

/**
 * Run `run` while the page is visible: at once on start, focus or becoming
 * visible, then {@link POLL_MS} after each success, or twice the last wait
 * after a failure (a `false` result or a rejection), up to {@link MAX_WAIT_MS}.
 * The window's `online` event resets the wait to {@link POLL_MS} and, while
 * the page is visible, runs at once; a run already in flight finishes first,
 * and its result sets the next wait. Runs never overlap.
 */
export function createPoller(run: () => Promise<boolean>, timers = browserTimers): Poller {
  let started = false;
  let running = false;
  let wait = POLL_MS;
  let timer: number | null = null;

  const isVisible = (): boolean => document.visibilityState === 'visible';

  const cancel = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    cancel();
    if (started && isVisible()) {
      timer = timers.setTimeout(wake, wait);
    }
  };

  async function tick(): Promise<void> {
    if (running || !started) {
      return;
    }
    running = true;
    cancel();
    const ok = await run().catch(() => false);
    wait = ok ? POLL_MS : Math.min(wait * 2, MAX_WAIT_MS);
    running = false;
    schedule();
  }

  function wake(): void {
    void tick();
  }

  const onVisibility = (): void => {
    if (isVisible()) {
      wake();
    } else {
      cancel();
    }
  };

  /** The network is back, so the relay may be too: drop the backoff and try now. */
  const onOnline = (): void => {
    wait = POLL_MS;
    if (isVisible()) {
      wake();
    }
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', wake);
      window.addEventListener('online', onOnline);
      if (isVisible()) {
        wake();
      }
    },
    stop() {
      started = false;
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', onOnline);
    },
  };
}

/** What the sync loop works with. */
export interface SyncOptions {
  /** The device's groups. */
  store: Store;
  /** The relay (default: `/v1` on the same origin). */
  relay?: Relay;
  /**
   * The seal for blobs: `xchachaSeal` in the app. It has no default, so no
   * caller can forget it and send something the relay could read (#151).
   */
  seal: Seal;
  /** An event's id, for dedupe (default: the engine's, via `parseEvent`). */
  idOf?: EventIdOf;
  /** The device clock in milliseconds, for `lastSyncAt` and a result's `ts` (default: `Date.now`). */
  clock?: () => number;
  /** The timers the poller uses (default: the window's). */
  timers?: Timers;
}

/** The running sync loop. */
export interface Sync extends Poller {
  /** Run one pass over every group, or join the one running; true when every group synced. */
  syncOnce(): Promise<boolean>;
  /** Whether the last pass succeeded (true before the first). */
  isReachable(): boolean;
  /** Hear when {@link Sync.isReachable} changes; returns the way to stop. */
  subscribe(listener: () => void): () => void;
}

/** A sync loop over `options.store`; call `start()` to begin polling. */
export function createSync(options: SyncOptions): Sync {
  const { store, relay = createRelay(), seal, idOf = eventIdOf, clock = Date.now } = options;
  const listeners = new Set<() => void>();
  let reachable = true;
  let inFlight: Promise<boolean> | null = null;

  /** Post the group's current outbox in order; an entry leaves only once the relay accepts it. */
  async function postOutbox(groupId: string, { mailbox, key }: Channel): Promise<void> {
    const outbox = (await store.getGroup(groupId))?.outbox ?? [];
    for (const bytes of outbox) {
      await relay.putBlob(mailbox, seal.seal(mailbox, key, bytes), GROUP_TTL_DAYS);
      await store.markSent(groupId, bytes);
    }
  }

  async function syncGroup(group: Group): Promise<void> {
    const channel = channelOf(group.secret);
    await postOutbox(group.groupId, channel);
    let after = group.cursor;
    let page = await relay.getBlobs(channel.mailbox, after);
    if (group.instance !== null && page.instance !== group.instance) {
      await store.resetCursor(group.groupId, page.instance);
      await postOutbox(group.groupId, channel);
      after = 0;
      page = await relay.getBlobs(channel.mailbox, after);
    }
    const pull: Pull = {
      records: openRecords(seal, channel, page.records),
      cursor: page.records[page.records.length - 1]?.seq ?? after,
      relayNow: page.now,
      instance: page.instance,
      lastSyncAt: clock(),
    };
    await store.applyPull(group.groupId, pull, idOf);
  }

  /** The relay minute each group's results and expiry were last settled at. */
  const settled = new Map<string, number | null>();

  /**
   * Posts a result for each closed Proposal that has none (re-syncing once
   * first, in case another device just posted one), then clears expired
   * ballots (#111). Skips a group already settled in this relay minute.
   */
  async function settle(groupId: string): Promise<void> {
    let group = await store.getGroup(groupId);
    if (group === undefined || settled.get(groupId) === group.relayNow) return;
    let state = foldGroup(group);
    if (resultsDue(state, group).length > 0) {
      await syncGroup(group);
      group = (await store.getGroup(groupId)) ?? group;
      state = foldGroup(group);
      const records = signResults(state, group, resultsDue(state, group), clock());
      if (records.length > 0) {
        await store.enqueueAll(groupId, records);
        await postOutbox(groupId, channelOf(group.secret));
      }
    }
    await clearExpiredBallots(store, groupId, state);
    settled.set(groupId, group.relayNow);
  }

  async function pass(): Promise<boolean> {
    let ok = true;
    try {
      for (const group of await store.listGroups()) {
        const synced = await syncGroup(group).then(succeeded, failed);
        ok = synced && (await settle(group.groupId).then(succeeded, failed)) && ok;
      }
    } catch {
      ok = false;
    }
    if (ok !== reachable) {
      reachable = ok;
      for (const listener of listeners) {
        listener();
      }
    }
    return ok;
  }

  function syncOnce(): Promise<boolean> {
    inFlight ??= pass().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const poller = createPoller(syncOnce, options.timers);
  return {
    ...poller,
    syncOnce,
    isReachable: () => reachable,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Where a group's blobs go and the key they're sealed under, both derived from its secret. */
export interface Channel {
  /** The group's mailbox id at the relay. */
  readonly mailbox: string;
  /** The key its blobs are sealed under. */
  readonly key: Uint8Array;
}

/** The mailbox id and seal key that `secret` derives (spec §3). */
export function channelOf(secret: Uint8Array): Channel {
  return { mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) };
}

/** The relay records whose blobs open on `channel`, as log records; the rest are skipped. */
export function openRecords(
  seal: Seal,
  { mailbox, key }: Channel,
  records: readonly RelayRecord[],
): LogRecord[] {
  return records.flatMap(({ seq, received, data }) => {
    const bytes = seal.open(mailbox, key, data);
    return bytes === null ? [] : [{ seq, received, bytes }];
  });
}

const succeeded = (): boolean => true;
const failed = (): boolean => false;
