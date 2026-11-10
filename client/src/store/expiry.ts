/**
 * Ballots and notes expire 30 days after a decision (#111; ADR-0017,
 * ADR-0065 §3; docs/spec/phase-1-spec.md §7 and §9).
 *
 * Two duties run on the device after each sync pass, in relay time:
 *
 * - **The result.** A device holding a closed Proposal's ballots, with no
 *   valid result in its log once the relay is past the close, re-syncs once
 *   and, if there's still none, signs and posts one (`resultsDue`,
 *   `signResults`). Any member may, and the fold keeps the first valid one.
 * - **Clearing.** Once the relay's minute reaches the result's close plus
 *   `ballotExpiryDays` days, `clearExpiredBallots` deletes, in one store
 *   change, the Proposal's ballots, every other result for it and anything
 *   else that expires with them, from the log and the outbox, and marks it
 *   `cleared`. The result stays, so its totals and outcome do too.
 *
 * Nothing here reaches the network: sync.ts posts what `signResults` signs.
 */
import { can } from '../engine/capabilities';
import { signEvent } from '../engine/event';
import { ballotsExpired, needsResult, resultFor } from '../engine/expiry';
import { fold, type GroupState, type Proposal } from '../engine/fold';
import type { Clearing, Group, Store } from './db';

/** A stored group folded as the screens fold it: its log, the relay's minute, and what it cleared. */
export function foldGroup(group: Pick<Group, 'log' | 'relayNow' | 'cleared'>): GroupState {
  return fold(group.log, group.relayNow, group.cleared ?? []);
}

/** The closed Proposals this device's member should post a result for now. */
export function resultsDue(
  state: GroupState,
  group: Pick<Group, 'me' | 'relayNow'>,
): readonly Proposal[] {
  if (!can(state, group.me.author, 'read')) return [];
  return state.proposals.filter((proposal) => needsResult(proposal, group.relayNow));
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
