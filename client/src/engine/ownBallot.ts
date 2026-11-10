/**
 * The viewer's own ballot on one Proposal, as its result tells them (#74;
 * docs/spec/phase-1-spec.md §8, Result).
 *
 * The fold counts a ballot only when the relay received it before the vote
 * closed, and leaves a later one in `ignored` without saying why. This reads
 * the viewer's own ignored records back, so a ballot sent offline that
 * reached the relay too late can say so, to its author only. It reads the
 * group's own log, and nothing leaves the device.
 */
import { parseRecord } from './event';
import type { GroupState, LogRecord } from './fold';

/**
 * `counted` when the fold counts the viewer's ballot, `late` when their only
 * ballot reached the relay once voting had closed, and `none` otherwise.
 */
export type OwnBallot = 'counted' | 'late' | 'none';

/** True when `record` holds a signed ballot by `me` on `proposalId`. */
function isBallotOn(record: LogRecord, proposalId: string, me: string): boolean {
  const event = parseRecord(record.bytes)?.event;
  return event?.type === 'vote' && event.author === me && event.body.proposal === proposalId;
}

/**
 * Where `me`'s ballot on `proposalId` stands. Only someone in its eligible set
 * can be late: anyone else had no ballot to cast. An early close waits for
 * every eligible ballot, so only the deadline leaves one out.
 */
export function ownBallot(
  state: Pick<GroupState, 'proposals' | 'ignored'>,
  log: readonly LogRecord[],
  proposalId: string,
  me: string,
): OwnBallot {
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  if (proposal === undefined || !proposal.eligible.includes(me)) return 'none';
  if (proposal.ballots.some((ballot) => ballot.voter === me)) return 'counted';
  const closed = proposal.closedAt ?? proposal.deadline;
  const ignored = new Set(state.ignored.map((record) => record.seq));
  const late = log.some(
    (record) =>
      ignored.has(record.seq) && record.received >= closed && isBallotOn(record, proposalId, me),
  );
  return late ? 'late' : 'none';
}
