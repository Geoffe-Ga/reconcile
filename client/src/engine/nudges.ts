/**
 * The wakes a proposer's device schedules for its own Proposals (#99;
 * ADR-0012, ADR-0074 "closing soon").
 *
 * A new Proposal and an early close wake the group when they're sent
 * (`wake.ts`). The two moments no one sends anything for, a vote's last day
 * and its result at the deadline, are nudges: relay minutes the proposer's
 * device asks the relay, once, to wake the group's mailbox at. Only the
 * proposer's device asks, so a group gets each nudge once. A nudge for a
 * Proposal that then closes early still fires: one extra wake, carrying
 * nothing, is fine (cancelling it is deferred).
 */
import type { GroupState } from './fold';
import { DAY_MINUTES } from './rules';

/** One wake to schedule: a Proposal of mine, and the relay minute to wake its group at. */
export interface Nudge {
  readonly proposal: string;
  readonly minute: number;
}

/**
 * Two nudges for each of `me`'s open Proposals, in relay order: a day before
 * its deadline (closing soon) and at its deadline (its result, when no ballot
 * closes it early). None for anyone else's, or for one that has closed, and
 * none once the group has dissolved (#108): a Proposal still open then never
 * closes, and nothing more goes to the group's mailbox.
 */
export function nudgesFor(state: GroupState, me: string): Nudge[] {
  if (state.dissolved !== null) return [];
  return state.proposals
    .filter((p) => p.author === me && !p.final)
    .flatMap((p) => [
      { proposal: p.id, minute: p.deadline - DAY_MINUTES },
      { proposal: p.id, minute: p.deadline },
    ]);
}

/** The name a device records a nudge under once it is posted: its Proposal and minute. */
export function nudgeKey(nudge: Nudge): string {
  return `${nudge.proposal}@${String(nudge.minute)}`;
}
