/**
 * Ballots and notes expire 30 days after a decision (#111; ADR-0017,
 * ADR-0065 §3; docs/spec/phase-1-spec.md §7 and §9).
 *
 * Two duties run on the device after each sync pass, in relay time:
 *
 * - **The result.** A device holding a closed Proposal's ballots, with no
 *   valid result in its log once the relay is past the close, syncs once
 *   more and, if there's still none, signs one and queues it for the next
 *   pass to post (`resultsDue`, `signResults`, sync.ts). Any member may, and
 *   the fold keeps the first valid one.
 * - **Clearing.** Once the relay's minute reaches the result's close plus
 *   `ballotExpiryDays` days, `clearExpiredBallots` deletes, in one store
 *   change, the Proposal's ballots, every other result for it and anything
 *   else that expires with them, from the log and the outbox, and marks it
 *   `cleared`. The result stays, so its totals and outcome do too.
 *
 * Nothing here reaches the network: sync.ts posts what `signResults` signs.
 */
import { can, isOusted, isSuspended } from '../engine/capabilities';
import { parseRecord, signEvent } from '../engine/event';
import { ballotsExpired, needsResult, resultFor } from '../engine/expiry';
import { fold, type GroupState, type Proposal } from '../engine/fold';
import type { Clearing, Group, Store } from './db';

/** A stored group folded as the screens fold it: its log, the relay's minute, and what it cleared. */
export function foldGroup(group: Pick<Group, 'log' | 'relayNow' | 'cleared'>): GroupState {
  return fold(group.log, group.relayNow, [], group.cleared ?? []);
}

/**
 * The closed Proposals this device's member should post a result for now:
 * none once they've left or are leaving (#77), since nothing is queued after
 * a leave; none while they're suspended (#102), or once a removal of them has
 * passed (#115), since the fold ignores their result then; none once the group has dissolved (#108), since the fold takes no
 * event after its dissolve; and none in a coalition's own log (#100), which
 * takes no result: its motions are decided by the groups' results, and each
 * group's own log carries the result of its vote on one. A Proposal whose
 * result already waits in the outbox is left out, so none is queued twice.
 */
export function resultsDue(
  state: GroupState,
  group: Pick<Group, 'me' | 'relayNow' | 'leaving'> & Partial<Pick<Group, 'outbox'>>,
): readonly Proposal[] {
  if (state.dissolved !== null || state.coalition !== null) return [];
  const me = group.me.author;
  if (group.leaving !== undefined || !can(state, me, 'read')) return [];
  if (isSuspended(state, me) || isOusted(state, me)) return [];
  const queued = queuedResults(group.outbox ?? []);
  return state.proposals.filter(
    (proposal) => needsResult(proposal, group.relayNow) && !queued.has(proposal.id),
  );
}

/** The Proposals `outbox` already holds a result for, on its way to the relay. */
function queuedResults(outbox: readonly Uint8Array[]): Set<string> {
  const queued = new Set<string>();
  for (const bytes of outbox) {
    const event = parseRecord(bytes)?.event;
    if (event?.type === 'result') queued.add(event.body.proposal);
  }
  return queued;
}

/** A signed result for each Proposal in `due`, by this device's member, at device time `ts`. */
export function signResults(
  state: GroupState,
  group: Pick<Group, 'signingKey'>,
  due: readonly Proposal[],
  ts: number,
): Uint8Array[] {
  const groupId = state.group ?? '';
  return due.map(
    (proposal) =>
      signEvent(group.signingKey, {
        type: 'result',
        group: groupId,
        ts,
        body: resultFor(proposal),
      }).record,
  );
}

/** Each Proposal of `state` whose ballots expire at `relayNow`, with the result that stays. */
export function expiredBallots(state: GroupState, relayNow: number | null): Clearing[] {
  return state.proposals.flatMap((proposal) =>
    proposal.result !== null && ballotsExpired(state.rules, proposal, relayNow)
      ? [{ proposal: proposal.id, keep: proposal.result.id }]
      : [],
  );
}

/**
 * Clears every expired ballot in `groupId` (#111), and returns the Proposals
 * it cleared. It runs after every sync pass, and #78's import runs it too.
 */
export async function clearExpiredBallots(
  store: Pick<Store, 'getGroup' | 'clearBallots'>,
  groupId: string,
  state?: GroupState,
): Promise<readonly string[]> {
  const group = await store.getGroup(groupId);
  if (group === undefined) return [];
  const clearings = expiredBallots(state ?? foldGroup(group), group.relayNow);
  if (clearings.length > 0) await store.clearBallots(groupId, clearings);
  return clearings.map(({ proposal }) => proposal);
}
