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
 * 4. runs the chat bot for it (#119, ./chatBot.ts), which claims and posts
 *    only while the group has its bot on and hasn't dissolved. Nothing the
 *    bot does, or fails to do, changes whether the pass succeeded.
 *
 * The mailbox id and seal key are derived from the group's secret on each
 * pass (spec §3); the store keeps only the secret. The cursor moves past a
 * blob that won't open, so one bad blob never stalls a group.
 *
 * A group this device is leaving (#77) goes once the relay returns a seq for
 * its leave: the pass purges it from the store and reads nothing more for it.
 * Until then it stays, leaving, through failures and reloads.
 *
 * A dissolved group (#108) is archived once its `dissolve` folds, and from
 * then on a pass sends nothing for it and reads nothing: no request names its
 * mailbox again, and its chat bot posts nothing. After a pass that brought
 * new records or a new relay minute, `settleDissolve` (./archive.ts)
 * archives the group, or posts this member's `dissolve` when a dissolve
 * Proposal's pass has become final.
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
import { settleDissolve } from './archive';
import type { ChatBot } from './chatBot';
import { type EventIdOf, type Group, type Pull, sameBytes, type Store } from './db';
import { eventIdOf } from './eventId';

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
  /** The device clock in milliseconds, for `lastSyncAt` (default: `Date.now`). */
  clock?: () => number;
  /** The timers the poller uses (default: the window's). */
  timers?: Timers;
  /** The chat bot, run after each group syncs (#119); without one, nothing posts. */
  chatBot?: ChatBot;
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
  const { chatBot } = options;
  const listeners = new Set<() => void>();
  let reachable = true;
  let inFlight: Promise<boolean> | null = null;

  /**
   * Post the group's current outbox in order; an entry leaves only once the
   * relay accepts it. Once the relay has returned a seq for the group's leave,
   * the group is purged, and this returns true.
   */
  async function postOutbox(groupId: string, { mailbox, key }: Channel): Promise<boolean> {
    const current = await store.getGroup(groupId);
    for (const bytes of current?.outbox ?? []) {
      await relay.putBlob(mailbox, seal.seal(mailbox, key, bytes), GROUP_TTL_DAYS);
      if (current?.leaving !== undefined && sameBytes(bytes, current.leaving)) {
        await store.purgeGroup(groupId);
        return true;
      }
      await store.markSent(groupId, bytes);
    }
    return false;
  }

  async function syncGroup(group: Group): Promise<void> {
    // A read-only archive sends and reads nothing, so no request names its mailbox (#108).
    if (group.archived !== undefined) return;
    const channel = channelOf(group.secret);
    if (await postOutbox(group.groupId, channel)) return;
    let after = group.cursor;
    let page = await relay.getBlobs(channel.mailbox, after);
    if (group.instance !== null && page.instance !== group.instance) {
      await store.resetCursor(group.groupId, page.instance);
      if (await postOutbox(group.groupId, channel)) return;
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
    await afterPull(group, pull);
  }

  /**
   * Once a pull is saved: settle a dissolve (#108), then run the chat bot
   * (#119), which posts and claims nothing once a `dissolve` has folded.
   */
  async function afterPull(group: Group, pull: Pull): Promise<void> {
    // Only something new can finish a dissolve vote or bring a dissolve: a record, or a later minute.
    if (pull.records.length > 0 || pull.relayNow !== group.relayNow) {
      await settleDissolve(store, group.groupId, clock);
    }
    await chatBot?.run(group.groupId).catch(() => undefined);
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
