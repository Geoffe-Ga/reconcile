/**
 * A Proposal's versions as the screens show them (spec §8; ADR-0004):
 * numbered in ballot order, which is relay order, each with its author's name.
 * A steward or rules Proposal's one version has no text: it carries what the
 * ballot decides instead (#102, #117), and so does a dissolve Proposal's (#108).
 */
import { WIPE_DAYS } from '../engine/dissolve';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import { rulesChangeOf } from '../engine/optIns';
import { type StewardChange, stewardChangeOf } from '../engine/stewards';
import { messages } from './messages';
import { type RulesView, rulesView } from './optInLines';
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
  /** For a rules Proposal, what its ballot decides, in place of any text (#117). */
  readonly rules?: RulesView;
  /** For a dissolve Proposal, what its ballot decides, in place of any text (#108). */
  readonly dissolve?: DissolveView;
  /**
   * For a reconcile Proposal or a coalition motion, what its ballot decides,
   * in place of any text (#114): its title, which may hold a name someone
   * chose, and what passing does.
   */
  readonly decision?: DissolveView;
}

/** What a dissolve ballot decides, and the line that says what passing does (#108). */
export interface DissolveView {
  readonly title: string;
  readonly line: string;
}

/** What a dissolve ballot decides: the group ends, and every copy stays or is erased a week on. */
export function dissolveView(wipe: boolean): DissolveView {
  const { dissolve } = messages;
  return {
    title: dissolve.ballotTitle,
    line: wipe ? dissolve.wipeLine(WIPE_DAYS) : dissolve.keepLine,
  };
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
  const rules = rulesChangeOf(proposal);
  const { target } = proposal;
  return proposal.versions.map((version, index) => ({
    id: version.id,
    number: index + 1,
    author: displayName(state, version.author) ?? '',
    text: version.text,
    ...(change === null ? {} : { steward: stewardView(state, change) }),
    ...(rules === null ? {} : { rules: rulesView(rules) }),
    ...(target.kind === 'dissolve' ? { dissolve: dissolveView(target.wipe) } : {}),
    ...decisionOf(proposal),
  }));
}

/**
 * What a reconcile Proposal's or a coalition motion's ballot decides (#114):
 * the coalition it would form, or the motion as the coalition titled it.
 */
export function decisionOf(proposal: Pick<Proposal, 'target' | 'title'>): {
  readonly decision?: DissolveView;
} {
  const { target } = proposal;
  if (target.kind === 'reconcile') {
    const title = messages.card.proposalTitle(target.name);
    return { decision: { title, line: messages.coalitions.reconcileLine } };
  }
  if (target.kind === 'motion') {
    return { decision: { title: proposal.title, line: messages.coalitions.motionLine } };
  }
  return {};
}
