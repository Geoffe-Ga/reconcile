/**
 * The sync loop (spec §7): framework-free, so the UI only reads the store.
 *
 * While the page is visible, a pass runs every 3 seconds, and at once on focus.
 * After a failure the wait doubles, up to 30 seconds. When the browser comes
 * back online the wait resets and a pass runs at once, so an event saved
 * offline doesn't sit out the backoff. Each pass, for each group:
 *
 * 1. posts the outbox in order, each record sealed for the group's mailbox,
 *    removing an entry only once the relay accepts it. A Proposal, or a
 *    ballot after which this device's fold closes one early, goes with
 *    `wake=1` (#99, `engine/wake.ts`), whether or not this device's own push
 *    is on: the wake is for the others' phones;
 * 2. reads every record after the cursor, opens each blob (skipping one that
 *    won't open), and appends each event the log doesn't hold yet;
 * 3. saves the cursor, the relay's time and instance, and when it synced;
 * 4. runs the chat bot for it (#119, ./chatBot.ts), which claims and posts
 *    only while the group has its bot on and hasn't dissolved, and never once
 *    the loop is halted (#78). Nothing the bot does, or fails to do, changes
 *    whether the pass succeeded;
 * 5. posts the push nudges due for this device's own open Proposals (#99,
 *    ./push.ts), each once, which likewise never fails the pass. A read-only
 *    archive (#108) posts none.
 *
 * After a pass in which every group synced, and unless the loop is halted,
 * three things follow, in this order:
 *
 * 1. the key changes due (#98, below), so what comes next sees each group at
 *    the epoch it moved to;
 * 2. push upkeep, which keeps each group with push on registered at the
 *    relay (#99), under the mailboxes of its current key, so a phone is
 *    under a new mailbox as soon as the pass that moved it. A read-only
 *    archive gets no upkeep: its registration is left to expire at the
 *    relay, so no request names its mailbox again;
 * 3. `afterPass`: in the app, the relay backup's daily refresh (#97,
 *    ./relayBackup.ts), last because it may send the largest request of the
 *    day, and so that its snapshot holds each group after its key change.
 *    It waits while a key change this device should write is still due
 *    (`refreshRelayBackup`). Nothing it does changes whether the pass
 *    succeeded.
 *
 * The mailbox id and seal key are derived from the group's secret on each
 * pass (spec §3); the store keeps only the secret. The cursor moves past a
 * blob that won't open, so one bad blob never stalls a group.
 *
 * A group this device is leaving (#77) goes once the relay returns a seq for
 * its leave: the pass fires a `keepalive` DELETE of its push registration,
 * without waiting (#99), purges it from the store and reads nothing more for it.
 * Until then it stays, leaving, through failures and reloads.
 *
 * A dissolved group (#108) is archived once its `dissolve` folds, and from
 * then on a pass sends nothing for it and reads nothing: no request names its
 * mailbox again, and its chat bot posts nothing. After a pass that brought
 * new records or a new relay minute, `settleDissolve` (./archive.ts)
 * archives the group, or posts this member's `dissolve` when a dissolve
 * Proposal's pass has become final. `settleRemoval` (./removal.ts) does the
 * same for a removal (#115): it archives the group once a `remove` naming
 * this member folds, forgetting its push registration first, or posts this
 * member's `remove` when a removal's pass has become final.
 *
 * Erase halts the loop for good before it closes the store (#78): no new pass
 * starts, a pass already running stops before its next group, and `halt`
 * resolves once it has, so no request starts after that. The group that pass
 * finishes still settles its dissolve, which touches only the store, but its
 * chat bot doesn't run.
 *
 * A relay `instance` the group hasn't seen means a fresh relay database: the
 * cursor goes back to 0, the outbox is posted again, and the log's dedupe by
 * event id keeps any event from folding twice. Folded state comes from the
 * log alone, so an event still in the outbox is pending and never folded.
 *
 * A group's key changes when someone leaves or is removed (#98, #115, `epochs.ts`). Each record
 * read is tagged with the epoch of the mailbox it came from. While a key
 * change is due, the outbox sends only `key-rotate` and `leave`. After a pass
 * in which every group synced, a device that sees a key change due syncs that
 * group once more and, if none has landed, posts one to the outgoing epoch's
 * mailbox. A pull that brings a canonical key change this member's wrap opens
 * moves the group to the new mailbox, in the same store change, and that
 * mailbox is read at once. A member with no encryption key posts one. A
 * dissolve ends all of this (#108): the fold makes no key change due once a
 * group has dissolved, and an archive neither writes one nor posts a key.
 */

import { newKxKey } from '../crypto/box';
import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import type { Seal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import type { Relay, RelayRecord } from '../net/relay';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { wakeForRecord } from '../engine/wake';
import { settleDissolve } from './archive';
import { settleRemoval } from './removal';
import type { ChatBot } from './chatBot';
import { type EventIdOf, type Group, type Pull, sameBytes, type Store } from './db';
import {
  advanceFor,
  epochOf,
  hasDuty,
  isFrozen,
  keyRotateRecord,
  kxRecord,
  needsKx,
  passesFreeze,
} from './epochs';
import { eventIdOf } from './eventId';
import type { PushUpkeep } from './push';

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
  /** Push's nudges, upkeep and Leave's forget (#99); without it, nothing is registered or nudged. */
  push?: PushUpkeep;
  /**
   * Run after each pass in which every group synced, unless halted, once the
   * pass's key changes (#98) and push upkeep (#99) are done: the relay
   * backup's daily refresh (#97). Its failures never fail the pass.
   */
  afterPass?: () => Promise<void>;
}

/** The running sync loop. */
export interface Sync extends Poller {
  /** Run one pass over every group, or join the one running; true when every group synced. */
  syncOnce(): Promise<boolean>;
  /** Whether the last pass succeeded (true before the first). */
  isReachable(): boolean;
  /** Hear when {@link Sync.isReachable} changes; returns the way to stop. */
  subscribe(listener: () => void): () => void;
  /**
   * Stop for good (#78): no pass starts again, even on `start`, and a pass
   * already running stops before its next group, running no chat bot for the
   * group it finishes. Resolves once it has.
   */
  halt(): Promise<void>;
}

/** A sync loop over `options.store`; call `start()` to begin polling. */
export function createSync(options: SyncOptions): Sync {
  const { store, relay = createRelay(), seal, idOf = eventIdOf, clock = Date.now } = options;
  const { chatBot, push, afterPass } = options;
  const listeners = new Set<() => void>();
  let reachable = true;
  let halted = false;
  let inFlight: Promise<boolean> | null = null;

  /**
   * Post the group's current outbox in order; an entry leaves only once the
   * relay accepts it. While `frozen` (#98), every entry but a `key-rotate` or
   * `leave` stays queued, in its place. Once the relay has returned a seq for
   * the group's leave, the group is purged, and this returns true.
   */
  async function postOutbox(groupId: string, { mailbox, key }: Channel, frozen: boolean) {
    const current = await store.getGroup(groupId);
    if (current === undefined) return false;
    let before: GroupState | null = null;
    for (const bytes of current.outbox) {
      if (frozen && !passesFreeze(bytes)) continue;
      before ??= fold(current.log, current.relayNow);
      const wake = wakeForRecord(before, bytes);
      await relay.putBlob(mailbox, seal.seal(mailbox, key, bytes), GROUP_TTL_DAYS, { wake });
      if (current.leaving !== undefined && sameBytes(bytes, current.leaving)) {
        push?.forget(current);
        await store.purgeGroup(groupId);
        return true;
      }
      await store.markSent(groupId, bytes);
    }
    return false;
  }

  /**
   * Posts the outbox to the group's current mailbox and reads it once:
   * `left` once the group's leave is posted and the group purged, `moved`
   * when the pull took the group to its next epoch (#98), else `stayed`.
   */
  async function syncMailbox(group: Group): Promise<'left' | 'moved' | 'stayed'> {
    const channel = channelOf(group.secret);
    const frozen = isFrozen(fold(group.log, group.relayNow), group);
    if (await postOutbox(group.groupId, channel, frozen)) return 'left';
    let after = group.cursor;
    let page = await relay.getBlobs(channel.mailbox, after);
    if (group.instance !== null && page.instance !== group.instance) {
      await store.resetCursor(group.groupId, page.instance);
      if (await postOutbox(group.groupId, channel, frozen)) return 'left';
      after = 0;
      page = await relay.getBlobs(channel.mailbox, after);
    }
    const records = openRecords(seal, channel, page.records, epochOf(group));
    const advance = advanceFor(group, records, page.now);
    const pull: Pull = {
      records,
      cursor: page.records[page.records.length - 1]?.seq ?? after,
      relayNow: page.now,
      instance: page.instance,
      lastSyncAt: clock(),
      ...(advance === null ? {} : { advance }),
    };
    await store.applyPull(group.groupId, pull, idOf);
    await settleAfter(group, pull);
    return advance === null ? 'stayed' : 'moved';
  }

  /**
   * Once a pull is saved, settles a dissolve (#108) and a removal (#115) when
   * it brought something that could finish a vote or bring its event: a
   * record, or a later minute. A removal of this member forgets the group's
   * push registration before it archives the group (#99).
   */
  async function settleAfter(group: Group, pull: Pull): Promise<void> {
    if (pull.records.length > 0 || pull.relayNow !== group.relayNow) {
      await settleDissolve(store, group.groupId, clock);
      await settleRemoval(store, group.groupId, clock, (removed) => push?.forget(removed));
    }
  }

  /**
   * Syncs the group's mailbox, and each new one a key change moves it to at
   * once, then posts this member's encryption key if the fold has none
   * (#98), then runs the chat bot (#119), which posts and claims nothing once
   * a `dissolve` has folded, then posts push nudges (#99). Neither runs once
   * the loop is halted (Erase, #78). False when the group is gone.
   *
   * A read-only archive sends and reads nothing, so no request names its
   * mailbox (#108).
   */
  async function syncGroup(group: Group): Promise<boolean> {
    if (group.archived !== undefined) return true;
    let current = group;
    for (;;) {
      const outcome = await syncMailbox(current);
      const fresh = outcome === 'left' ? undefined : await store.getGroup(group.groupId);
      if (fresh === undefined) return false;
      current = fresh;
      if (outcome === 'stayed') break;
    }
    await queueKx(current);
    // Once halted (Erase, #78), the bot neither claims nor posts, and no nudge goes.
    if (halted) return true;
    await chatBot?.run(group.groupId).catch(() => undefined);
    await push?.nudge(group.groupId).catch(() => undefined);
    return true;
  }

  /** Queues this member's `kx` when the fold has no encryption key for them (#98). */
  async function queueKx(group: Group): Promise<void> {
    const state = fold(group.log, group.relayNow);
    if (state.group === null || !needsKx(group, state)) return;
    const kxKey = await store.ensureKx(group.groupId, group.kxKey ?? newKxKey());
    await store.enqueue(group.groupId, kxRecord(group, state.group, kxKey, clock()));
  }

  /**
   * The duty (#98): when the group has a key change due that this device may
   * write, sync it once more, and if one is still due, post it to the
   * outgoing epoch's mailbox, then sync again to take up the new key.
   */
  async function rotateIfDue(groupId: string): Promise<void> {
    const group = await store.getGroup(groupId);
    if (group === undefined || !hasDuty(group, fold(group.log, group.relayNow))) return;
    if (!(await syncGroup(group))) return;
    const fresh = await store.getGroup(groupId);
    const state = fresh === undefined ? null : fold(fresh.log, fresh.relayNow);
    if (fresh === undefined || state === null || !hasDuty(fresh, state)) return;
    const { mailbox, key } = channelOf(fresh.secret);
    const record = keyRotateRecord(fresh, state, clock());
    await relay.putBlob(mailbox, seal.seal(mailbox, key, record), GROUP_TTL_DAYS);
    await syncGroup(fresh);
  }

  /** Runs `step` for each group in turn while not halted; true when every group's step succeeded. */
  async function eachGroup(step: (group: Group) => Promise<unknown>): Promise<boolean> {
    let ok = true;
    for (const group of await store.listGroups()) {
      if (halted) break;
      ok = (await step(group).then(succeeded, failed)) && ok;
    }
    return ok;
  }

  /**
   * What follows a pass in which every group synced and its key changes were
   * made, unless halted: push upkeep (#99), then, last, the relay backup's
   * refresh (#97), so each sees every group at the epoch it moved to (#98).
   */
  async function afterComplete(): Promise<void> {
    if (!halted) await push?.upkeep();
    if (!halted) await afterPass?.().catch(() => undefined);
  }

  async function pass(): Promise<boolean> {
    let ok = true;
    try {
      ok = await eachGroup(syncGroup);
      // Only after a complete pass: a device that missed records mustn't write a key change.
      if (ok) ok = await eachGroup((group) => rotateIfDue(group.groupId));
    } catch {
      ok = false;
    }
    if (ok) await afterComplete();
    if (ok !== reachable) {
      reachable = ok;
      for (const listener of listeners) {
        listener();
      }
    }
    return ok;
  }

  function syncOnce(): Promise<boolean> {
    if (halted) return Promise.resolve(false);
    inFlight ??= pass().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const poller = createPoller(syncOnce, options.timers);
  return {
    start() {
      if (!halted) poller.start();
    },
    stop() {
      poller.stop();
    },
    async halt() {
      halted = true;
      poller.stop();
      await inFlight;
    },
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

/**
 * The relay records whose blobs open on `channel`, as log records, each
 * tagged with `epoch`, the epoch of the mailbox they came from, unless it is
 * 0 (#98); the rest are skipped.
 */
export function openRecords(
  seal: Seal,
  { mailbox, key }: Channel,
  records: readonly RelayRecord[],
  epoch = 0,
): LogRecord[] {
  const tag = epoch === 0 ? {} : { epoch };
  return records.flatMap(({ seq, received, data }) => {
    const bytes = seal.open(mailbox, key, data);
    return bytes === null ? [] : [{ seq, received, bytes, ...tag }];
  });
}

const succeeded = (): boolean => true;
const failed = (): boolean => false;
