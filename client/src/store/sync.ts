/**
 * The sync loop (spec §7): framework-free, so the UI only reads the store.
 *
 * While the page is visible, a pass runs every 3 seconds, and at once on focus.
 * After a failure the wait doubles, up to 30 seconds. When the browser comes
 * back online the wait resets and a pass runs at once, so an event saved
 * offline doesn't sit out the backoff. Mailboxes rotate weekly (#110,
 * ./mailbox.ts), and each pass, for each group:
 *
 * 1. GETs first: the mailbox of the week of the group's last relay minute
 *    (week 0's, which no one writes to, before it has one). That GET's `now`
 *    gives the relay's week, so a device back from a long absence never
 *    writes to a stale week. The week comes from the relay only;
 * 2. posts the outbox in order to this week's mailbox, each record sealed for
 *    it, removing an entry only once the relay accepts it. A Proposal, or a
 *    ballot after which this device's fold closes one early, goes with
 *    `wake=1` (#99, `engine/wake.ts`), whether or not this device's own push
 *    is on: the wake is for the others' phones;
 * 3. reads every record after its cursor in each mailbox `pollWeeks` names:
 *    last week's and this week's, and each week since the last sync, once,
 *    back to the last 5. It opens each blob (skipping one that won't open),
 *    and adds each event the log doesn't hold yet, the weeks' records merged
 *    by seq and each put in relay order (./logOrder.ts);
 * 4. saves each mailbox's cursor, dropping those older than 5 weeks, the
 *    relay's time (the earliest of the GETs' `now`s) and instance, and when
 *    it synced;
 * 5. runs the chat bot for it (#119, ./chatBot.ts), which claims and posts
 *    only while the group has its bot on and hasn't dissolved, and never once
 *    the loop is halted (#78). Nothing the bot does, or fails to do, changes
 *    whether the pass succeeded;
 * 6. keeps the group's front door (#121, src/door/keeper.ts): posts its
 *    page when it's due and reads its inbox while the door is open, closes
 *    the page of a door no longer open, a dissolved group's included (#108),
 *    and never fails the pass;
 * 7. posts the push nudges due for this device's own open Proposals (#99,
 *    ./push.ts), each once, which likewise never fails the pass. A read-only
 *    archive (#108) posts none.
 *
 * After a pass in which every group synced, and unless the loop is halted,
 * five things follow, in this order:
 *
 * 1. the key changes due (#98, below), so what comes next sees each group at
 *    the epoch it moved to;
 * 2. results and expiry (#111, ./expiry.ts): for each group that isn't a
 *    read-only archive, a result for each closed Proposal that still has
 *    none after the pass before found none too, so the device has synced
 *    once more to be sure, is queued for the next pass to post; then every
 *    ballot that has expired is cleared. Folding the log for this costs a
 *    signature check per record, so a group is settled once per relay minute
 *    unless a result is owed: the duty waits for the minute after a close,
 *    and expiry for a minute, anyway;
 * 3. push upkeep, which keeps each group with push on registered at the
 *    relay (#99), under the weekly mailboxes of its current key for the next
 *    30 days, so a phone is under a new mailbox as soon as the pass that
 *    moved it. A read-only archive gets no upkeep: its registration is left
 *    to expire at the relay, so no request names its mailbox again;
 * 4. replies to the front-door applications this device sent (#121), which
 *    runs on a device in no group too, and never fails the pass;
 * 5. `afterPass`: in the app, the relay backup's daily refresh (#97,
 *    ./relayBackup.ts), last because it may send the largest request of the
 *    day, and so that its snapshot holds each group after its key change.
 *    It waits while a key change this device should write is still due
 *    (`refreshRelayBackup`). Nothing it does changes whether the pass
 *    succeeded.
 *
 * The mailbox ids and seal key are derived from the group's secret on each
 * pass (spec §3); the store keeps only the secret. A cursor moves past a
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
 * A relay `instance` the group hasn't seen, at the pass's first GET, means a
 * fresh relay database: the pass reads every mailbox from 0, the outbox goes
 * to the fresh relay, the pull's records go after the whole log, and the
 * log's dedupe by event id keeps any event from folding twice. A pass that
 * meets another instance after its first GET fails, and the next starts
 * over. Folded state comes from the log alone, so an event still in the
 * outbox is pending and never folded.
 *
 * A group's key changes when someone leaves or is removed (#98, #115,
 * `epochs.ts`). Each record read is tagged with the epoch of the mailboxes it
 * came from. While a key change is due, the outbox sends only `key-rotate`
 * and `leave`. After a pass in which every group synced, a device that sees a key change due syncs that
 * group once more and, if none has landed, posts one to the outgoing epoch's
 * mailbox for this week. A pull that brings a canonical key change this
 * member's wrap opens moves the group to the new epoch's mailboxes, in the
 * same store change, and they are read at once, from the key change's seq.
 * The old epoch's are read no more, so whatever reaches any week of them
 * after the key change stays ignored. A member with no encryption key posts
 * one. A dissolve ends all of this (#108): the fold makes no key change due
 * once a group has dissolved, and an archive neither writes one nor posts a key.
 *
 * Coalitions follow the groups in a complete pass (#114, ./coalitions.ts),
 * then each coalition's room (#125, ./rooms.ts), synced as a group is under
 * keys from the coalition's `inner`: no key change, no `kx`, chat bot, door
 * or nudges, and no wake. A room never read before reads its last 5 weeks,
 * and each pull deletes what is more than 30 days of relay time old. Every
 * pass first keeps the device's rooms from the store alone, so a room whose
 * last member group here is leaving, read-only or gone is purged at once,
 * even while the relay can't be reached.
 *
 * A group off the device leaves nothing in the loop's memory (#270): right
 * after the rooms, every pass forgets, from the store alone, what the loop
 * keeps of each group left, removed or wiped, and the result duty's notes of
 * a read-only archive (#108), so nothing noted before comes due if the group
 * comes back.
 */

import { newKxKey } from '../crypto/box';
import { deriveSealKey, deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import type { Seal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import type { Relay, RelayRecord } from '../net/relay';
import type { GroupState, LogRecord } from '../engine/fold';
import { wakeForRecord } from '../engine/wake';
import { settleDissolve } from './archive';
import { settleRemoval } from './removal';
import type { ChatBot } from './chatBot';
import { ensureEntries, settleCoalitions, stillSyncs } from './coalitions';
import { type EventIdOf, type Group, isRoomEntry, type Pull, sameBytes, type Store } from './db';
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
import { clearExpiredBallots, foldGroup, resultsDue, signResults } from './expiry';
import { keptWeeks, pollWeeks } from './mailbox';
import type { PushUpkeep } from './push';
import { keepRooms, type RoomReads } from './rooms';

/** The wait between passes while they succeed. */
export const POLL_MS = 3000;

/** The longest wait after repeated failures. */
export const MAX_WAIT_MS = 30_000;

/** How long the relay keeps a group's events, in days (ADR-0057). */
export const GROUP_TTL_DAYS = 30;

/**
 * The front door's work in a pass (#121): `createDoorKeeper` in src/door/,
 * kept apart from this module so sync needs nothing of the door's.
 */
export interface DoorUpkeep {
  /** Keeps `groupId`'s door after the group synced. */
  run(groupId: string): Promise<void>;
  /** Looks for replies to this device's applications, after a complete pass. */
  replies(): Promise<void>;
}

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
  /** The chat bot, run after each group syncs (#119); without one, nothing posts. */
  chatBot?: Pick<ChatBot, 'run'>;
  /** Push's nudges, upkeep and Leave's forget (#99); without it, nothing is registered or nudged. */
  push?: PushUpkeep;
  /** The front door's keeper (#121); without it, no page is kept and no inbox or reply read. */
  door?: DoorUpkeep;
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
  const { chatBot, push, door, afterPass } = options;
  const listeners = new Set<() => void>();
  let reachable = true;
  let halted = false;
  let inFlight: Promise<boolean> | null = null;
  // Each group as the coalitions' part of a pass last read it (#114), so an unchanged one isn't folded again.
  const scanned = new Map<string, string>();
  // Each group's fold as the rooms last read it (#125), for the same reason.
  const roomReads: RoomReads = new Map();

  /**
   * Post the group's current outbox in order; an entry leaves only once the
   * relay accepts it. While `frozen` (#98), every entry but a `key-rotate` or
   * `leave` stays queued, in its place. Once the relay has returned a seq for
   * the group's leave, the group is purged: `left`. Else `posted` when the
   * relay took anything, `none` when it took nothing.
   */
  async function postOutbox(
    groupId: string,
    { mailbox, key }: Channel,
    frozen: boolean,
  ): Promise<'left' | 'posted' | 'none'> {
    const current = await store.getGroup(groupId);
    if (current === undefined) return 'none';
    let before: GroupState | null = null;
    let posted: 'posted' | 'none' = 'none';
    for (const bytes of current.outbox) {
      if (frozen && !passesFreeze(bytes)) continue;
      // No phone registers under a coalition's or a room's mailboxes (#120, #284), so nothing
      // there asks to wake one.
      const wake =
        current.kind === undefined && wakeForRecord((before ??= foldGroup(current)), bytes);
      await relay.putBlob(mailbox, seal.seal(mailbox, key, bytes), GROUP_TTL_DAYS, { wake });
      if (current.leaving !== undefined && sameBytes(bytes, current.leaving)) {
        push?.forget(current);
        await store.purgeGroup(groupId);
        return 'left';
      }
      await store.markSent(groupId, bytes);
      posted = 'posted';
    }
    return posted;
  }

  /** GETs week `week`'s mailbox of `secret`, after its cursor in `cursors` (#110). */
  async function readWeek(secret: Uint8Array, week: number, cursors: Cursors): Promise<WeekRead> {
    const mailbox = deriveWeekMailboxId(secret, week);
    const after = cursors.held[mailbox] ?? cursors.base;
    const { records, now, instance } = await relay.getBlobs(mailbox, after);
    return { week, mailbox, after, records, now, instance };
  }

  /** `read`, with whatever its mailbox took since, once this device has posted there. */
  async function readOn(read: WeekRead): Promise<WeekRead> {
    const page = await relay.getBlobs(read.mailbox, read.records.at(-1)?.seq ?? read.after);
    return { ...read, records: [...read.records, ...page.records], instance: page.instance };
  }

  /**
   * The pass's first GET (#110): the mailbox of the week of the group's last
   * relay minute, or week 0's before it has one. A relay instance the group
   * hasn't seen is a fresh relay database: the pass reads every mailbox from
   * its start, that one again first, and its pull starts the store's cursors
   * over (`applyPull`).
   */
  async function firstRead(group: Group): Promise<{ first: WeekRead; cursors: Cursors }> {
    const week = group.relayNow === null ? 0 : weekOf(group.relayNow);
    const held = { base: group.cursor, held: group.cursors ?? {} };
    const first = await readWeek(group.secret, week, held);
    if (group.instance === null || first.instance === group.instance) {
      return { first, cursors: held };
    }
    const cursors = { base: 0, held: {} };
    return { first: await readWeek(group.secret, week, cursors), cursors };
  }

  /**
   * Reads each week `pollWeeks` names for a pass in relay week `week`,
   * ascending (#110): the first GET stands for its own week, read on when this
   * device has posted there since. Every read must come from the first's
   * relay instance, or the pass fails and the next starts over.
   */
  async function readWeeks(group: Group, pass: Pass): Promise<WeekRead[]> {
    const { first, cursors, week, posted } = pass;
    const last = group.relayNow === null ? neverRead(group) : weekOf(group.relayNow);
    const reads: WeekRead[] = [];
    for (const each of pollWeeks(last, week)) {
      if (each !== first.week) reads.push(await readWeek(group.secret, each, cursors));
      else reads.push(posted && each === week ? await readOn(first) : first);
    }
    if (reads.some((read) => read.instance !== first.instance)) {
      throw new Error('The relay changed instance during the pass.');
    }
    return reads;
  }

  /**
   * GETs first, to take this week from the relay's `now` (#110), posts the
   * outbox to this week's mailbox, then reads each week `pollWeeks` names and
   * saves what they held in one pull: `left` once the group's leave is posted
   * and the group purged, `moved` when the pull took the group to its next
   * epoch (#98), else `stayed`.
   */
  async function syncMailbox(group: Group): Promise<'left' | 'moved' | 'stayed'> {
    // A room's log is messages alone (#125): it has no key change to freeze for or move to.
    const room = isRoomEntry(group);
    const frozen = !room && isFrozen(foldGroup(group), group);
    const { first, cursors } = await firstRead(group);
    const week = weekOf(first.now);
    const outcome = await postOutbox(group.groupId, channelOf(group.secret, week), frozen);
    if (outcome === 'left') return 'left';
    const pass = { first, cursors, week, posted: outcome === 'posted' };
    const reads = await readWeeks(group, pass);
    const { records, relayNow } = openReads(seal, group, reads);
    const advance = room ? null : advanceFor(group, records, relayNow);
    const pull: Pull = {
      records,
      cursors: cursorsAfter(group.secret, pass, reads),
      relayNow,
      instance: first.instance,
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
    if (group.kind !== undefined) return;
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
    if (group.archived !== undefined || !stillSyncs(group)) return true;
    const current = await syncEpochs(group);
    if (current === undefined) return false;
    // A coalition or a room has no key of its own to post, no chat bot and no nudges (#114, #120, #125).
    if (current.kind !== undefined) return true;
    await queueKx(current);
    // Once halted (Erase, #78), the bot neither claims nor posts, and no nudge goes.
    if (halted) return true;
    await chatBot?.run(group.groupId).catch(() => undefined);
    await door?.run(group.groupId).catch(() => undefined);
    await push?.nudge(group.groupId).catch(() => undefined);
    return true;
  }

  /**
   * Syncs the group's mailboxes, and each new epoch's a key change moves it
   * to at once (#98); the group as it stands after, or undefined once gone.
   */
  async function syncEpochs(group: Group): Promise<Group | undefined> {
    let current = group;
    for (;;) {
      const outcome = await syncMailbox(current);
      const fresh = outcome === 'left' ? undefined : await store.getGroup(group.groupId);
      if (fresh === undefined || outcome === 'stayed') return fresh;
      current = fresh;
    }
  }

  /** Queues this member's `kx` when the fold has no encryption key for them (#98). */
  async function queueKx(group: Group): Promise<void> {
    const state = foldGroup(group);
    if (state.group === null || !needsKx(group, state)) return;
    const kxKey = await store.ensureKx(group.groupId, group.kxKey ?? newKxKey());
    await store.enqueue(group.groupId, kxRecord(group, state.group, kxKey, clock()));
  }

  /**
   * The duty (#98): when the group has a key change due that this device may
   * write, sync it once more, and if one is still due, post it to the
   * outgoing epoch's mailbox for the week that sync's relay minute falls in
   * (#110), then sync again to take up the new key.
   */
  async function rotateIfDue(groupId: string): Promise<void> {
    const group = await store.getGroup(groupId);
    if (group === undefined || !hasDuty(group, foldGroup(group))) return;
    if (!(await syncGroup(group))) return;
    const fresh = await store.getGroup(groupId);
    // A group that just synced has a relay minute; one without never writes a key change.
    if (fresh === undefined || fresh.relayNow === null) return;
    const state = foldGroup(fresh);
    if (!hasDuty(fresh, state)) return;
    const { mailbox, key } = channelOf(fresh.secret, weekOf(fresh.relayNow));
    const record = keyRotateRecord(fresh, state, clock());
    await relay.putBlob(mailbox, seal.seal(mailbox, key, record), GROUP_TTL_DAYS);
    await syncGroup(fresh);
  }

  /** Runs `step` for each of `groups` in turn while not halted; true when every step succeeded. */
  async function each(
    groups: readonly Group[],
    step: (group: Group) => Promise<unknown>,
  ): Promise<boolean> {
    let ok = true;
    for (const group of groups) {
      if (halted) break;
      ok = (await step(group).then(succeeded, failed)) && ok;
    }
    return ok;
  }

  /** Runs `step` for each group in turn while not halted; true when every group's step succeeded. */
  async function eachGroup(step: (group: Group) => Promise<unknown>): Promise<boolean> {
    return each(await store.listGroups(), step);
  }

  /**
   * The coalitions' part of a pass (#114), once every group has synced:
   * keeps an entry for each coalition secret a group holds, syncs each, then
   * joins, reports and proposes admissions as `settleCoalitions` decides,
   * and sends what that queued at once. Then the rooms (#125): one for each
   * coalition whose `inner` a group here holds, each synced as a group is.
   */
  async function syncCoalitions(): Promise<boolean> {
    await ensureEntries(store, scanned);
    const ok = await each(await store.listCoalitions(), syncGroup);
    if (!ok || halted) return ok;
    const queued = await settleCoalitions(store, clock);
    const entries = await Promise.all(queued.map((id) => store.getGroup(id)));
    const sent = await each(
      entries.filter((entry) => entry !== undefined),
      syncGroup,
    );
    await keepRooms(store, roomReads);
    return (await each(await store.listRooms(), syncGroup)) && sent;
  }

  /**
   * What follows a pass in which every group synced and its key changes,
   * results and clearing were made, unless halted: push upkeep (#99), the
   * front door's replies (#121), then, last, the relay backup's refresh
   * (#97), so each sees every group at the epoch it moved to (#98), with its
   * expired ballots gone (#111).
   */
  async function afterComplete(): Promise<void> {
    if (!halted) await push?.upkeep();
    if (!halted) await door?.replies().catch(() => undefined);
    if (!halted) await afterPass?.().catch(() => undefined);
  }

  /** The relay minute each group's results and expiry were last settled at (#111). */
  const settled = new Map<string, number | null>();
  /** By group, the Proposals a settle found a result due for, which the next queues if still due. */
  const owed = new Map<string, readonly string[]>();

  /**
   * Settles a group's results and expiry (#111), after a complete pass: a
   * result due on this pass and on the one before, so the device has synced
   * once more since it first saw none, is queued, and the next pass posts it
   * and reads it back; then every ballot that has expired is cleared. A
   * read-only archive (#108) posts nothing, and its own sweep clears it.
   * Folding costs a signature check per record, so a group already settled in
   * this relay minute, with nothing owed, is skipped, and one that just
   * queued results is settled again on the next pass, which clears by them.
   */
  async function settleExpiry(groupId: string): Promise<void> {
    const group = await store.getGroup(groupId);
    if (group === undefined || group.archived !== undefined) return;
    const noted = owed.get(groupId) ?? [];
    if (settled.get(groupId) === group.relayNow && noted.length === 0) return;
    const state = foldGroup(group);
    const due = resultsDue(state, group);
    const now = due.filter((p) => noted.includes(p.id));
    owed.set(
      groupId,
      due.filter((p) => !noted.includes(p.id)).map((p) => p.id),
    );
    if (now.length > 0) {
      await store.enqueueAll(groupId, signResults(state, group, now, clock()));
      settled.delete(groupId);
    } else {
      settled.set(groupId, group.relayNow);
    }
    await clearExpiredBallots(store, groupId, state);
  }

  /**
   * Forgets all the loop keeps in memory of each group not in `groups`, the
   * device's groups: one left, removed or wiped (#270). That is the marks and
   * folds the coalitions' and rooms' parts keep, and the result duty's notes,
   * which go for a read-only archive (#108) too, since {@link settleExpiry}
   * settles one no more: nothing noted of it ever comes due.
   */
  function forgetGone(groups: readonly Group[]): void {
    forgetAllBut(groups, [scanned, roomReads]);
    forgetAllBut(
      groups.filter((group) => group.archived === undefined),
      [settled, owed],
    );
  }

  async function pass(): Promise<boolean> {
    let ok = true;
    try {
      // First, from the store alone: a room this device may no longer read goes now, even offline (#125).
      await keepRooms(store, roomReads);
      // And so does what the loop keeps of a group no longer on the device (#270).
      forgetGone(await store.listGroups());
      ok = await eachGroup(syncGroup);
      // Only after a complete pass: a device that missed records mustn't write a key change.
      if (ok) ok = await eachGroup((group) => rotateIfDue(group.groupId));
      // Then results and expiry (#111), at each group's epoch after any key change.
      if (ok) ok = await eachGroup((group) => settleExpiry(group.groupId));
      // Coalitions read their groups as this pass left them (#114).
      if (ok && !halted) ok = await syncCoalitions();
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

/**
 * The week a pass treats as the last read of an entry that has never synced
 * (#110): none, so a group reads last week and this one, as its invite or
 * genesis is no older; but week 0 for a room (#125), so a device that comes
 * to one reads every week the relay can still hold, its last 30 days.
 */
function neverRead(group: Pick<Group, 'kind'>): number | null {
  return isRoomEntry(group) ? 0 : null;
}

/** Where a group's blobs go and the key they're sealed under, both derived from its secret. */
export interface Channel {
  /** The group's mailbox id at the relay. */
  readonly mailbox: string;
  /** The key its blobs are sealed under. */
  readonly key: Uint8Array;
}

/** The mailbox id for relay week `week` and the seal key that `secret` derives (spec §3, #110). */
export function channelOf(secret: Uint8Array, week: number): Channel {
  return { mailbox: deriveWeekMailboxId(secret, week), key: deriveSealKey(secret) };
}

/** The cursors a pass reads after (#110): each mailbox's own, else the base. */
interface Cursors {
  /** The group's base cursor (`Group.cursor`). */
  readonly base: number;
  /** Each mailbox's cursor, by its id (`Group.cursors`). */
  readonly held: Readonly<Record<string, number>>;
}

/** One weekly mailbox as a pass read it (#110). */
interface WeekRead {
  /** Its relay week. */
  readonly week: number;
  /** Its id at the relay. */
  readonly mailbox: string;
  /** The seq it was read after. */
  readonly after: number;
  /** Its records after `after`, in seq order. */
  readonly records: readonly RelayRecord[];
  /** The `now` of its first GET: every record left out arrived at or after it. */
  readonly now: number;
  /** The relay instance that last answered for it. */
  readonly instance: string;
}

/** A pass, once its first GET has given the relay's week (#110). */
interface Pass {
  /** The first GET. */
  readonly first: WeekRead;
  /** The cursors the pass reads after. */
  readonly cursors: Cursors;
  /** The relay's week, from the first GET's `now`. */
  readonly week: number;
  /** Whether the relay took anything from the outbox this pass. */
  readonly posted: boolean;
}

/**
 * What a pass's reads hold (#110): every blob that opens, as a log record
 * tagged with the group's epoch, merged across the weeks in seq order, and
 * the relay minute they stand at, the earliest of the reads' `now`s, so no
 * record the pass left out of any mailbox arrived before it.
 */
function openReads(
  seal: Seal,
  group: Group,
  reads: readonly WeekRead[],
): { records: LogRecord[]; relayNow: number } {
  const key = deriveSealKey(group.secret);
  const records = reads
    .flatMap(({ mailbox, records: read }) =>
      openRecords(seal, { mailbox, key }, read, epochOf(group)),
    )
    .sort((a, b) => a.seq - b.seq);
  return { records, relayNow: Math.min(...reads.map((read) => read.now)) };
}

/**
 * The group's cursors after a pass (#110): each mailbox it read at the
 * highest seq it read there, or where it read from when it found nothing,
 * and each other cursor it held for the last 5 weeks; older ones, and any of
 * another secret's mailboxes, are dropped.
 */
function cursorsAfter(
  secret: Uint8Array,
  { cursors, week }: Pass,
  reads: readonly WeekRead[],
): Record<string, number> {
  const kept = new Set(keptWeeks(week).map((each) => deriveWeekMailboxId(secret, each)));
  return Object.fromEntries([
    ...Object.entries(cursors.held).filter(([mailbox]) => kept.has(mailbox)),
    ...reads.map((read) => [read.mailbox, read.records.at(-1)?.seq ?? read.after] as const),
  ]);
}

/** Deletes from each of `maps`, keyed by group id, every group but those of `groups` (#270). */
function forgetAllBut(
  groups: readonly Pick<Group, 'groupId'>[],
  maps: readonly Map<string, unknown>[],
): void {
  const kept = new Set(groups.map((group) => group.groupId));
  for (const map of maps) {
    for (const groupId of map.keys()) {
      if (!kept.has(groupId)) map.delete(groupId);
    }
  }
}

/** A log read straight from the relay, outside any store entry (#114). */
export interface RecentLog {
  /** The records that opened, as log records, in seq order. */
  readonly records: LogRecord[];
  /** The highest seq read, or 0 for none. */
  readonly cursor: number;
  /** The relay minute the reads stand at: the earliest of their `now`s. */
  readonly relayNow: number;
  /** The relay instance that answered. */
  readonly instance: string;
}

/**
 * Reads `secret`'s mailboxes for last week and the week of relay minute `now`
 * from the start (#110, #114), as a sync pass that has never synced would,
 * and opens what they hold: how Bring a card reads a coalition whose genesis,
 * if any, is no older than the card. Every read must come from one relay
 * instance.
 *
 * @throws {Error} when the relay can't be reached or changes instance.
 */
export async function readRecentLog(
  relay: Pick<Relay, 'getBlobs'>,
  seal: Seal,
  secret: Uint8Array,
  now: number,
): Promise<RecentLog> {
  const week = weekOf(now);
  const key = deriveSealKey(secret);
  const pages = [];
  for (const each of pollWeeks(null, week)) {
    const mailbox = deriveWeekMailboxId(secret, each);
    pages.push({ mailbox, page: await relay.getBlobs(mailbox, 0) });
  }
  const [first] = pages;
  if (first === undefined || pages.some(({ page }) => page.instance !== first.page.instance)) {
    throw new Error('The relay changed instance during the read.');
  }
  const records = pages
    .flatMap(({ mailbox, page }) => openRecords(seal, { mailbox, key }, page.records))
    .sort((a, b) => a.seq - b.seq);
  const relayNow = Math.min(...pages.map(({ page }) => page.now));
  const cursor = records.reduce((highest, record) => Math.max(highest, record.seq), 0);
  return { records, cursor, relayNow, instance: first.page.instance };
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
