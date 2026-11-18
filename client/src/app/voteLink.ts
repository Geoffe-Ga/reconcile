/**
 * Vote links (#472, ADR-0079): a link to one vote that a member can paste to
 * their group, `{origin}/#vote/{token}`, where the token is keyed by the
 * group's secret (`crypto/voteLink.ts`). It names no group and no Proposal,
 * and one coalition motion's links in two groups have nothing in common.
 *
 * A device makes a link when it shares one, and resolves a token by
 * computing the token of each Proposal in each group it holds, the group's
 * own and the coalition motions opened in it from outside alike. No token is
 * stored, backed up, or sent to the relay: browsers never send the part of a
 * link after `#`.
 */
import { VOTE_TOKEN, voteToken } from '../crypto/voteLink';
import type { GroupState } from '../engine/fold';
import { foldCoalitions, foldWithCoalitions } from '../store/coalitions';
import type { Group, Store } from '../store/db';

/** A vote link's own form: `#vote/{token}`, with no slash after `#`. */
export const VOTE_PREFIX = '#vote/';

/** Whether `payload`, what follows `#vote/`, is a token: 22 unpadded base64url characters. */
export function readsAsVoteToken(payload: string): boolean {
  return VOTE_TOKEN.test(payload);
}

/** The vote link for `token`, at the app's `origin`. */
export function voteLinkOf(origin: string, token: string): string {
  return `${origin}/${VOTE_PREFIX}${token}`;
}

/**
 * The token of `proposalId` in the group whose secret is `secret`, or null
 * when `proposalId` isn't an event id, so no link is offered for it.
 */
export function tokenFor(secret: Uint8Array, proposalId: string): string | null {
  try {
    return voteToken(secret, proposalId);
  } catch {
    return null;
  }
}

/** One group a token may name: its id, its secret, and its Proposals, coalition motions included. */
export interface VoteGroup {
  readonly groupId: string;
  readonly secret: Uint8Array;
  readonly state: Pick<GroupState, 'proposals'>;
}

/** Where a vote link goes: one Proposal's page in one group. */
export interface VoteTarget {
  readonly groupId: string;
  readonly proposalId: string;
}

/**
 * The Proposal `token` names among `groups`, or null when none of them
 * holds it. A token that isn't 22 base64url characters names none.
 */
export function findVote(token: string, groups: readonly VoteGroup[]): VoteTarget | null {
  if (!readsAsVoteToken(token)) return null;
  for (const { groupId, secret, state } of groups) {
    const match = state.proposals.find(({ id }) => tokenFor(secret, id) === token);
    if (match !== undefined) return { groupId, proposalId: match.id };
  }
  return null;
}

/** Each of `groups` folded with the motions its seats decide in `coalitions`' entries. */
function voteGroupsOf(groups: readonly Group[], coalitions: readonly Group[]): VoteGroup[] {
  const held = foldCoalitions(coalitions);
  return groups.map((group) => ({
    groupId: group.groupId,
    secret: group.secret,
    state: group.archived?.cleared?.state ?? foldWithCoalitions(group, held),
  }));
}

/** The Proposal `token` names on this device, read from `store` afresh, or null for none. */
export async function locateVote(
  store: Pick<Store, 'listGroups' | 'listCoalitions'>,
  token: string,
): Promise<VoteTarget | null> {
  if (!readsAsVoteToken(token)) return null;
  const [groups, coalitions] = await Promise.all([store.listGroups(), store.listCoalitions()]);
  return findVote(token, voteGroupsOf(groups, coalitions));
}
