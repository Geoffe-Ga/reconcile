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
 * dissolved group posts nothing.
 */
import { can, isSuspended } from '../engine/capabilities';
import { clearMinute, dissolveDue, wipeMinute } from '../engine/dissolve';
import { parseRecord, signEvent } from '../engine/event';
import { type GroupState, proposalTally } from '../engine/fold';
import type { ClearedArchive, Group, Store } from './db';
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
 * leaving, or the fold wouldn't take one from this member (not yet in, or
 * suspended). `clock` is the device clock in ms, for the event's `ts`.
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
  if (due === null || group.leaving !== undefined || dissolveQueued(group)) return;
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
 * Proposal with no ballot, and each decided one's totals and outcome from
 * this device's tally. `at` is the device clock in ms.
 */
export function clearedArchive(state: GroupState, at: number): ClearedArchive {
  const decided = state.proposals.filter((proposal) => proposal.final);
  const tallies = Object.fromEntries(decided.map((p) => [p.id, proposalTally(p)]));
  const proposals = state.proposals.map((proposal) => ({ ...proposal, ballots: [] }));
  return { at, state: { ...state, proposals, ignored: [] }, tallies };
}

/**
 * At launch (#108): for each dissolved archive not yet cleared, erases it
 * once the device clock reaches a week after the dissolve's receipt when its
 * vote chose to wipe, and otherwise clears its ballots and notes once it
 * reaches `ballotExpiryDays` after it. `clock` is the device clock in ms.
 */
export async function sweepArchives(store: Store, clock: () => number = Date.now): Promise<void> {
  for (const group of await store.listGroups()) {
    if (group.archived === undefined || group.archived.cleared !== undefined) continue;
    const state = foldGroup(group);
    const { dissolved } = state;
    if (dissolved === null) continue;
    const now = clock();
    const minute = Math.floor(now / MINUTE_MS);
    if (dissolved.wipe) {
      if (minute >= wipeMinute(dissolved)) await store.purgeGroup(group.groupId);
    } else if (minute >= clearMinute(state.rules, dissolved)) {
      await store.clearArchive(group.groupId, clearedArchive(state, now));
    }
  }
}
