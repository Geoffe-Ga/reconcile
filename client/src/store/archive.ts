/**
 * A dissolved group on this device (#108; docs/spec/phase-1-spec.md §7,
 * Dissolve; ADR-0051, ADR-0057, ADR-0075 §5).
 *
 * After each pass that brought something new, the sync loop calls
 * {@link settleDissolve}: once a `dissolve` has folded, the group becomes a
 * read-only archive (`markArchived`), its outbox goes and no request names its
 * mailbox again, so the relay's copy expires on its usual schedule. Until
 * then, a device that folds a dissolve Proposal's final pass posts the one
 * `dissolve` the fold needs.
 *
 * At each launch, {@link sweepArchives} acts on the archives whose time has
 * come, by the device's own clock, since no relay time arrives after a
 * dissolve: with wipe, it erases the group a week after the dissolve's
 * receipt, so everyone sees the result first; without, it clears every ballot
 * and note `ballotExpiryDays` after it, keeping each outcome and its totals
 * from this device's own tally. That clearing is a device-local stand-in for
 * #111's expiry, which can't run here: it needs a `result` in the log, and a
 * dissolved group posts nothing. A removed member's copy (#115), which no
 * longer syncs, clears the same way, `ballotExpiryDays` after the `remove`,
 * removal responses included.
 */
import { can, isSuspended } from '../engine/capabilities';
import { clearMinute, dissolveDue, wipeMinute } from '../engine/dissolve';
import { parseRecord, signEvent } from '../engine/event';
import { type GroupState, proposalTally } from '../engine/fold';
import { removedClearMinute, removedFrom } from '../engine/removal';
import { type ClearedArchive, type Group, isArchive, type Store, takesNew } from './db';
import { foldGroup } from './expiry';

/** One minute in device milliseconds: the device clock counts the archive's days in relay minutes. */
export const MINUTE_MS = 60_000;

/** What the device shows for a group: a cleared archive's kept state, or its log folded. */
export function shownState(group: Group): GroupState {
  return group.archived?.cleared?.state ?? foldGroup(group);
}

/** True when this member's own `dissolve` already waits in the outbox. */
function dissolveQueued(group: Group): boolean {
  return group.outbox.some((bytes) => parseRecord(bytes)?.event.type === 'dissolve');
}

/**
 * Settles a dissolve for one group after a pass (#108): archives it once a
 * `dissolve` has folded, or else, when a dissolve Proposal's pass is final,
 * queues this member's `dissolve`, unless one is queued already, the group is
 * leaving or a restored copy that sends nothing yet (#231), or the fold
 * wouldn't take one from this member (not yet in, or suspended). `clock` is
 * the device clock in ms, for the event's `ts`.
 */
export async function settleDissolve(
  store: Store,
  groupId: string,
  clock: () => number,
): Promise<void> {
  const group = await store.getGroup(groupId);
  if (group === undefined) return;
  const state = foldGroup(group);
  if (state.dissolved !== null) {
    await store.markArchived(groupId, 'dissolved');
    return;
  }
  const due = dissolveDue(state);
  if (due === null || !takesNew(group) || dissolveQueued(group)) return;
  const me = group.me.author;
  if (!can(state, me, 'read') || isSuspended(state, me)) return;
  const dissolve = signEvent(group.signingKey, {
    type: 'dissolve',
    group: groupId,
    ts: clock(),
    body: { proposal: due },
  });
  await store.enqueue(groupId, dissolve.record);
}

/**
 * The state to keep once an archive's ballots and notes are cleared: every
 * Proposal with no ballot, no removal response, which expires with them
 * (#111, #115), and each decided one's totals and outcome from this device's
 * tally. `at` is the device clock in ms.
 */
export function clearedArchive(state: GroupState, at: number): ClearedArchive {
  const decided = state.proposals.filter((proposal) => proposal.final);
  const tallies = Object.fromEntries(decided.map((p) => [p.id, proposalTally(p)]));
  const proposals = state.proposals.map((proposal) => ({ ...proposal, ballots: [] }));
  return { at, state: { ...state, proposals, responses: [], ignored: [] }, tallies };
}

/**
 * The relay minute an unwiped archive's ballots and notes clear at, by the
 * device clock: `ballotExpiryDays` after the dissolve (#108), or after the
 * `remove` that took this device's member out (#115). Null for a group that
 * is neither.
 */
function clearMinuteOf(state: GroupState, me: string): number | null {
  if (state.dissolved !== null) return clearMinute(state.rules, state.dissolved);
  const removal = removedFrom(state, me);
  return removal === undefined ? null : removedClearMinute(state.rules, removal);
}

/**
 * At launch (#108): for each dissolved archive not yet cleared, erases it
 * once the device clock reaches a week after the dissolve's receipt when its
 * vote chose to wipe, and otherwise clears its ballots and notes once it
 * reaches `ballotExpiryDays` after it. A removed member's copy (#115) clears
 * the same way, `ballotExpiryDays` after the `remove`: it no longer syncs, so
 * #111's expiry, which runs in relay time, never reaches it. A restored copy
 * that hasn't heard from its group (#231) is left alone: it still syncs, so
 * #111's expiry clears it. `clock` is the device clock in ms.
 */
export async function sweepArchives(store: Store, clock: () => number = Date.now): Promise<void> {
  for (const group of await store.listGroups()) {
    if (!isArchive(group.archived) || group.archived.cleared !== undefined) continue;
    const state = foldGroup(group);
    const now = clock();
    const minute = Math.floor(now / MINUTE_MS);
    const { dissolved } = state;
    if (dissolved?.wipe === true) {
      if (minute >= wipeMinute(dissolved)) await store.purgeGroup(group.groupId);
      continue;
    }
    const clearAt = clearMinuteOf(state, group.me.author);
    if (clearAt !== null && minute >= clearAt) {
      await store.clearArchive(group.groupId, clearedArchive(state, now));
    }
  }
}
