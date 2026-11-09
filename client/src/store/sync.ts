/**
 * The sync loop (spec §7): framework-free, so the UI only reads the store.
 *
 * While the page is visible, a pass runs every 3 seconds, and at once on focus.
 * After a failure the wait doubles, up to 30 seconds. Each pass, for each group:
 *
 * 1. posts the outbox in order, removing an entry only once the relay accepts it;
 * 2. reads every record after the cursor, opens each blob (skipping one that
 *    won't open), and appends each event the log doesn't hold yet;
 * 3. saves the cursor, the relay's time and instance, and when it synced.
 *
 * A relay `instance` the group hasn't seen means a fresh relay database: the
 * cursor goes back to 0, the outbox is posted again, and the log's dedupe by
 * event id keeps any event from folding twice. Folded state comes from the
 * log alone, so an event still in the outbox is pending and never folded.
 */

import { stubSeal } from '../crypto/stubSeal';
import type { Seal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import type { Relay, RelayRecord } from '../net/relay';
import type { EventIdOf, Group, LogRecord, Pull, Store } from './db';

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
  /** Begin: run at once if the page is visible, and listen for visibility and focus. */
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
 * Runs never overlap.
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

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', wake);
      if (isVisible()) {
        wake();
      }
    },
    stop() {
      started = false;
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', wake);
    },
  };
}

/** What the sync loop works with. */
export interface SyncOptions {
  /** The device's groups. */
  store: Store;
  /** The relay (default: `/v1` on the same origin). */
  relay?: Relay;
  /** The seal for blobs (default: the stub, until #71). */
  seal?: Seal;
  /** An event's id, for dedupe. */
  idOf: EventIdOf;
  /** The device clock in milliseconds, for `lastSyncAt` (default: `Date.now`). */
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
  const { store, relay = createRelay(), seal = stubSeal, idOf, clock = Date.now } = options;
  const listeners = new Set<() => void>();
  let reachable = true;
  let inFlight: Promise<boolean> | null = null;

  /** Post the group's current outbox in order; an entry leaves only once the relay accepts it. */
  async function postOutbox({ groupId, mailbox, secret }: Group): Promise<void> {
    const outbox = (await store.getGroup(groupId))?.outbox ?? [];
    for (const bytes of outbox) {
      await relay.putBlob(mailbox, seal.seal(mailbox, secret, bytes), GROUP_TTL_DAYS);
      await store.markSent(groupId, bytes);
    }
  }

  /** The records that open, as log records. */
  function openAll(group: Group, records: RelayRecord[]): LogRecord[] {
    return records.flatMap(({ seq, received, data }) => {
      const bytes = seal.open(group.mailbox, group.secret, data);
      return bytes === null ? [] : [{ seq, received, bytes }];
    });
  }

  async function syncGroup(group: Group): Promise<void> {
    await postOutbox(group);
    let after = group.cursor;
    let page = await relay.getBlobs(group.mailbox, after);
    if (group.instance !== null && page.instance !== group.instance) {
      await store.resetCursor(group.groupId, page.instance);
      await postOutbox(group);
      after = 0;
      page = await relay.getBlobs(group.mailbox, after);
    }
    const pull: Pull = {
      records: openAll(group, page.records),
      cursor: page.records[page.records.length - 1]?.seq ?? after,
      relayNow: page.now,
      instance: page.instance,
      lastSyncAt: clock(),
    };
    await store.applyPull(group.groupId, pull, idOf);
  }

  async function pass(): Promise<boolean> {
    let ok = true;
    try {
      for (const group of await store.listGroups()) {
        ok = (await syncGroup(group).then(succeeded, failed)) && ok;
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

const succeeded = (): boolean => true;
const failed = (): boolean => false;
