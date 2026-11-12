/**
 * Whether a Proposal is open (docs/spec/phase-1-spec.md §4, Proposals and
 * ballots; #72, #111, #289): from its receipt until its deadline or its early
 * close, whichever comes first, both in relay order.
 *
 * Every rule that asks whether a Proposal is open asks here: the fold, and
 * the steward, opt-in and dissolve rules the fold and the screens share. Its
 * `closedAt` is null until the fold reaches its early close: the ballot that
 * closed it, on a device that holds its ballots, or the place its result
 * records, on one that has cleared them (`closedSeq`, #289). So a Proposal
 * reads open or closed at the same point in relay order on every device.
 */

/** What openness reads of a Proposal: its deadline, and its early close once the fold has reached it. */
export interface Closing {
  readonly deadline: number;
  readonly closedAt: number | null;
}

/** True while a Proposal takes ballots at relay minute `at`: before its deadline, and before any early close. */
export function isOpenAt(proposal: Closing, at: number): boolean {
  return proposal.closedAt === null && at < proposal.deadline;
}
