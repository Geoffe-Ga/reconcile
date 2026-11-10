/**
 * Ballot expiry (#111; ADR-0017, ADR-0065 §3, ADR-0074;
 * docs/spec/phase-1-spec.md §4 and §7): the result a device posts for a
 * decided Proposal, when its ballots expire, and which records expire with
 * them.
 *
 * Individual ballots and notes are visible while voting is open and for 30
 * days after the decision, measured in relay time from the close. Then every
 * device deletes them and keeps the result, which carries only counts and a
 * commitment. All of this is pure: the store does the deleting
 * (`store/expiry.ts`).
 */
import {
  type EventBodies,
  type EventType,
  type GroupEvent,
  parseRecord,
  type RecordedOutcome,
  type ResultBody,
} from './event';
import { closeMinute, heldRecord, type Proposal } from './fold';

export { closeMinute } from './fold';
import { DAY_MINUTES, type Rules } from './rules';
import type { TallyOutcome } from './tally';

/** The event types whose body names the Proposal it belongs to. */
type ProposalBound = {
  [K in EventType]: EventBodies[K] extends { readonly proposal: string } ? K : never;
}[EventType];

/**
 * Event types, beyond `vote` and `result`, that expire with a Proposal's
 * ballots. #115 registers its removal response here. A Proposal's versions
 * are its wording, not its ballots, and never expire.
 */
export const EXPIRES_WITH_BALLOTS: readonly Exclude<
  ProposalBound,
  'version' | 'vote' | 'result'
>[] = [];

const EXPIRING: ReadonlySet<EventType> = new Set<EventType>([
  'vote',
  'result',
  ...EXPIRES_WITH_BALLOTS,
]);

/** The Proposal whose ballots `event` expires with, or null for an event that never expires. */
export function expiringProposal(event: GroupEvent): string | null {
  if (!EXPIRING.has(event.type) || !('proposal' in event.body)) return null;
  return event.body.proposal;
}

/** A record that expires with a Proposal's ballots: its event id and that Proposal's id. */
export interface ExpiryKey {
  readonly id: string;
  readonly proposal: string;
}

/**
 * The event id and Proposal of a signed record that expires with ballots, or
 * null for a record that doesn't verify or never expires. The store drops
 * and deletes records by this.
 */
export function expiryKeyOf(bytes: Uint8Array): ExpiryKey | null {
  const parsed = parseRecord(bytes);
  const proposal = parsed === null ? null : expiringProposal(parsed.event);
  return parsed === null || proposal === null ? null : { id: parsed.id, proposal };
}

/** The relay minute a decided Proposal's individual ballots and notes expire. */
export function ballotsExpireAt(
  rules: Pick<Rules, 'ballotExpiryDays'>,
  proposal: Pick<Proposal, 'closedAt' | 'deadline'>,
): number {
  return closeMinute(proposal) + rules.ballotExpiryDays * DAY_MINUTES;
}

/** A tally's outcome as a result names it: without the bar, which the Proposal's class sets. */
export function recordedOutcome(outcome: TallyOutcome): RecordedOutcome {
  return outcome.kind === 'pass'
    ? { kind: 'pass', version: outcome.version }
    : { kind: outcome.kind };
}

/** The result a device holding a closed Proposal's ballots posts for it. It carries no note. */
export function resultFor(proposal: Proposal): ResultBody {
  return { ...heldRecord(proposal), outcome: recordedOutcome(proposal.outcome) };
}

/**
 * True when this device should post a result for `proposal`: it has closed,
 * its ballots are still held, no valid result is in the log, and the relay's
 * minute is past the close, so the result arrives after it.
 */
export function needsResult(proposal: Proposal, relayNow: number | null): boolean {
  return (
    proposal.final &&
    !proposal.cleared &&
    proposal.result === null &&
    relayNow !== null &&
    relayNow > closeMinute(proposal)
  );
}

/**
 * True when `proposal`'s ballots are due to be cleared: a valid result is in
 * the log, they haven't been cleared yet, and the relay's minute has reached
 * the result's close plus `ballotExpiryDays` days.
 */
export function ballotsExpired(
  rules: Pick<Rules, 'ballotExpiryDays'>,
  proposal: Proposal,
  relayNow: number | null,
): boolean {
  const { result } = proposal;
  if (result === null || proposal.cleared || relayNow === null) return false;
  return relayNow >= result.closedAt + rules.ballotExpiryDays * DAY_MINUTES;
}
