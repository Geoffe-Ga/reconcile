/**
 * A Proposal's versions as the screens show them (spec §8; ADR-0004):
 * numbered in ballot order, which is relay order, each with its author's name.
 */
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';

/** One version as the screens show it. */
export interface VersionView {
  /** The version's id: the Proposal's id for version 1, else its own event id. */
  readonly id: string;
  /** Its place on the ballot, from 1, in relay order. */
  readonly number: number;
  /** Its author's name as the group sees it. */
  readonly author: string;
  /** The text it would put in the section. */
  readonly text: string;
}

/** A Proposal's versions in ballot order, each numbered and named. */
export function versionViews(state: GroupState, proposal: Proposal): VersionView[] {
  return proposal.versions.map((version, index) => ({
    id: version.id,
    number: index + 1,
    author: displayName(state, version.author) ?? '',
    text: version.text,
  }));
}
