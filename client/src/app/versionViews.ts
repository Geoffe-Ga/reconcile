/**
 * A Proposal's versions as the screens show them (spec §8; ADR-0004):
 * numbered in ballot order, which is relay order, each with its author's name.
 * A steward Proposal's one version has no text: it carries what the ballot
 * decides instead (#102).
 */
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import { type StewardChange, stewardChangeOf } from '../engine/stewards';
import { messages } from './messages';
import { type Motion, motionFor } from './stewardLines';

/** What a steward ballot decides, and the line that says what passing does. */
export interface StewardView {
  readonly motion: Motion;
  readonly line: string;
}

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
  /** For a steward Proposal, what its ballot decides, in place of any text (#102). */
  readonly steward?: StewardView;
}

/** What a steward change's ballot decides: electing its nominee, or recalling its steward. */
export function stewardView(
  state: Pick<GroupState, 'members' | 'former' | 'rules'>,
  change: Omit<StewardChange, 'kind'>,
): StewardView {
  const motion = motionFor(state, change);
  const { stewards } = messages;
  const line =
    motion.kind === 'elect' ? stewards.electLine(state.rules.suspensionDays) : stewards.recallLine;
  return { motion, line };
}

/** A Proposal's versions in ballot order, each numbered and named. */
export function versionViews(state: GroupState, proposal: Proposal): VersionView[] {
  const change = stewardChangeOf(proposal);
  return proposal.versions.map((version, index) => ({
    id: version.id,
    number: index + 1,
    author: displayName(state, version.author) ?? '',
    text: version.text,
    ...(change === null ? {} : { steward: stewardView(state, change) }),
  }));
}
