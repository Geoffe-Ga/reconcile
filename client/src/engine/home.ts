/**
 * What Group home lists, and in what order (#77; docs/spec/phase-1-spec.md §8,
 * Group home; ADR-0073: no push, digest or feed tabs).
 *
 * 'Needs your vote' brings people back without push: the open Proposals they
 * can vote on now and haven't fully scored, closing soonest first. The other
 * open Proposals follow by closing date, and Decided keeps the group's
 * history, newest first. A reconcile or coalition vote in its last 3 days
 * is marked there, as its reminder comes then (#550). In a dissolved group
 * nothing waits on anyone, and a Proposal still open at the dissolve stays
 * with the open ones, which the screen marks closed (#108). Pure: it reads folded state and a relay minute,
 * and nothing else.
 */
import { can } from './capabilities';
import { closeTime, type GroupState, type Proposal } from './fold';
import { reminds } from './nudges';

/** Group home's three lists of Proposals. */
export interface HomeLists {
  /**
   * Open Proposals before their deadline where `me` is in the eligible set,
   * may vote now, and hasn't scored every version, closing soonest first.
   */
  readonly needsYourVote: readonly Proposal[];
  /**
   * The ids of those that are reconcile or coalition votes in their last 3
   * days, which `me` hasn't scored (#550): the window of their reminder
   * ({@link reminds}), so the row is marked while the reminder shows.
   */
  readonly lastDays: ReadonlySet<string>;
  /** Every other Proposal the fold hasn't closed, by closing date. */
  readonly otherOpen: readonly Proposal[];
  /** Every Proposal the fold hasn't closed, by closing date: the two lists above, together. */
  readonly open: readonly Proposal[];
  /** Closed Proposals, newest first by when they closed, and later relay order first within a minute. */
  readonly decided: readonly Proposal[];
}

/** True when `me`'s latest ballot on `proposal` scores every version on it. */
function hasScoredEvery(proposal: Proposal, me: string): boolean {
  const ballot = proposal.ballots.find((candidate) => candidate.voter === me);
  return (
    ballot !== undefined &&
    proposal.versions.every((version) => Object.hasOwn(ballot.scores, version.id))
  );
}

/** True when `proposal` waits on `me`: the group goes on, it still takes ballots at `now`, and theirs isn't whole. */
function waitsOn(state: GroupState, proposal: Proposal, me: string, now: number): boolean {
  return (
    state.dissolved === null &&
    now < proposal.deadline &&
    proposal.eligible.includes(me) &&
    can(state, me, 'vote') &&
    !hasScoredEvery(proposal, me)
  );
}

/** By deadline, soonest first; `proposals` is in relay order and the sort is stable, so ties keep it. */
function byClosingDate(proposals: readonly Proposal[]): Proposal[] {
  return [...proposals].sort((a, b) => a.deadline - b.deadline);
}

/**
 * Group home's lists for `me` at relay minute `now`: the relay's last `now`,
 * or the device's estimate of it, which the countdowns use. A Proposal whose
 * deadline `now` has reached, before a sync lets the fold close it, moves to
 * the other open ones, so it never drops out of every list.
 */
export function homeLists(state: GroupState, me: string, now: number): HomeLists {
  const open = state.proposals.filter((proposal) => !proposal.final);
  const waiting = open.filter((proposal) => waitsOn(state, proposal, me, now));
  const decided = state.proposals
    .filter((proposal) => proposal.final)
    .reverse()
    .sort((a, b) => closeTime(b) - closeTime(a));
  return {
    needsYourVote: byClosingDate(waiting),
    lastDays: new Set(waiting.filter((p) => reminds(p, me, now)).map((p) => p.id)),
    otherOpen: byClosingDate(open.filter((proposal) => !waiting.includes(proposal))),
    open: byClosingDate(open),
    decided,
  };
}
