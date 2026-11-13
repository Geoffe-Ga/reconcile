/**
 * Which events wake the group's phones (#99, #112; ADR-0012, ADR-0074).
 *
 * Push carries no content, so the only question is when to send one. A
 * device asks the relay to wake its group's mailbox (`wake=1` on the PUT) for
 * the events other members need to hear of at once: a new Proposal, the
 * ballot that closes one early, since its result is then in, and a Dispatch
 * (#112), which every level follows (ADR-0003). A coalition's motion opened
 * in a group counts as any Proposal for its early close (#284): the ballot
 * that closes it in the group wakes it. The other two moments, a vote's last
 * day and its result at the deadline, come from nudges the proposer's device
 * schedules, or, for a coalition's motion, each eligible member's
 * (`nudges.ts`). A Dispatch a Proposal carries rides its result's wake, so it
 * needs none of its own.
 *
 * Every device marks wakes, whether or not its own push is on: the wake is
 * for the others' phones.
 */
import { can } from './capabilities';
import { type GroupEvent, parseRecord } from './event';
import { everyoneHasScored, type GroupState } from './fold';

/**
 * True when this device's fold, standing at `before`, would close the open
 * Proposal that `vote` scores once `vote` joins it: the voter holds `vote`
 * now, as the fold requires of a ballot, and after it every eligible
 * member's latest ballot scores every version. Eligibility is the
 * Proposal's own, so a newcomer still earning voting rights (#101) never
 * counts.
 */
function closesEarly(before: GroupState, vote: Extract<GroupEvent, { type: 'vote' }>): boolean {
  const proposal = before.proposals.find((p) => p.id === vote.body.proposal);
  if (proposal === undefined || proposal.final || !can(before, vote.author, 'vote')) return false;
  const ballot = { voter: vote.author, scores: vote.body.scores };
  const ballots = [...proposal.ballots.filter((b) => b.voter !== vote.author), ballot];
  return everyoneHasScored({ ...proposal, ballots });
}

/**
 * Whether sending `event` should wake the group's phones: true for a
 * Proposal, a Dispatch (#112) and a recovery alert (#118), and for a ballot after which this device's
 * fold, as it stands at `before`, closes the Proposal early. Nothing else
 * wakes anyone.
 */
export function wakeFor(before: GroupState, event: GroupEvent): boolean {
  switch (event.type) {
    case 'proposal':
    case 'dispatch':
    case 'recovery-alert':
      return true;
    case 'vote':
      return closesEarly(before, event);
    default:
      return false;
  }
}

/**
 * {@link wakeFor} for a signed record from the outbox: false for one that
 * doesn't verify, which the fold would ignore anyway.
 */
export function wakeForRecord(before: GroupState, record: Uint8Array): boolean {
  const parsed = parseRecord(record);
  return parsed !== null && wakeFor(before, parsed.event);
}
