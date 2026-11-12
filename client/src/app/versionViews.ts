/**
 * A Proposal's versions as the screens show them (spec §8; ADR-0004):
 * numbered in ballot order, which is relay order, each with its author's name,
 * and, for an add or a section's removal (#75), a line that says first what
 * it does. A steward or rules Proposal's one version has no text: it carries
 * what the ballot decides instead (#102, #117), and so does a dissolve
 * Proposal's (#108) and a member removal's (#115).
 */
import { WIPE_DAYS } from '../engine/dissolve';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import { rulesChangeOf } from '../engine/optIns';
import { type ProposalTarget, type StewardChange, stewardChangeOf } from '../engine/stewards';
import { messages } from './messages';
import { type RulesView, rulesView } from './optInLines';
import { type Motion, motionFor } from './stewardLines';
import { firstWords } from './text/firstWords';

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
  /** The text it would put in the section, or `""` to remove it. */
  readonly text: string;
  /** What it does, said before its change: where an add goes, or that it removes the section (#75). */
  readonly does?: string;
  /** For a steward Proposal, what its ballot decides, in place of any text (#102). */
  readonly steward?: StewardView;
  /** For a rules Proposal, what its ballot decides, in place of any text (#117). */
  readonly rules?: RulesView;
  /** For a dissolve Proposal, what its ballot decides, in place of any text (#108). */
  readonly dissolve?: DissolveView;
  /** For a removal, whom its ballot would remove, in place of any text (#115). */
  readonly removal?: RemovalView;
  /**
   * For a reconcile Proposal or a coalition motion, what its ballot decides,
   * in place of any text (#114): its title, which may hold a name someone
   * chose, and what passing does.
   */
  readonly decision?: DissolveView;
}

/** What a removal's ballot decides: the name of the person it would remove, and what passing does (#115). */
export interface RemovalView {
  readonly name: string;
  readonly line: string;
}

/** What a removal's ballot decides: removing `person`, named as the group sees them. */
export function removalView(
  state: Pick<GroupState, 'members' | 'former'>,
  person: string,
): RemovalView {
  return { name: displayName(state, person) ?? '', line: messages.removal.ballotLine };
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

/** Where an add's section goes: after its anchor's first words, at the start, or at the end once the anchor is gone. */
function addsWhere(state: GroupState, after: string | null): string {
  if (after === null) return messages.proposal.addsAtStart;
  const anchor = state.atoms.find((atom) => atom.id === after);
  return anchor === undefined
    ? messages.proposal.addsAtEnd
    : messages.proposal.addsAfter(firstWords(anchor.text));
}

/**
 * What a version with `text` does to the Document (#75): where an add's
 * section goes, or that an edit's `""` removes the section. Null for a change
 * of wording, and for a steward, rules or dissolve Proposal, whose ballot
 * says what it decides.
 */
export function versionDoes(
  state: GroupState,
  target: ProposalTarget,
  text: string,
): string | null {
  if (target.kind === 'add') return addsWhere(state, target.after);
  return target.kind === 'edit' && text === '' ? messages.proposal.removes : null;
}

/** True when a ballot already holds a removal: a version whose text is `""` (#75). */
export function holdsRemoval(proposal: {
  readonly versions: readonly { readonly text: string }[];
}): boolean {
  return proposal.versions.some((version) => version.text === '');
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

/**
 * A Proposal's versions in ballot order, each numbered and named by `names`:
 * the group's members, or for a coalition motion (#120), the coalition's
 * participants, whose names the group's own fold doesn't hold.
 */
export function versionViews(
  state: GroupState,
  proposal: Proposal,
  names: Pick<GroupState, 'members' | 'former'> = state,
): VersionView[] {
  const change = stewardChangeOf(proposal);
  const rules = rulesChangeOf(proposal);
  const { target } = proposal;
  return proposal.versions.map((version, index) => {
    const does = versionDoes(state, target, version.text);
    return {
      id: version.id,
      number: index + 1,
      author: displayName(names, version.author) ?? '',
      text: version.text,
      ...(does === null ? {} : { does }),
      ...(change === null ? {} : { steward: stewardView(state, change) }),
      ...(rules === null ? {} : { rules: rulesView(rules) }),
      ...(target.kind === 'dissolve' ? { dissolve: dissolveView(target.wipe) } : {}),
      ...(target.kind === 'remove' ? { removal: removalView(state, target.member) } : {}),
      ...decisionOf(proposal),
    };
  });
}

/**
 * What a reconcile Proposal's or a coalition motion's ballot decides (#114):
 * the coalition it would form, or a motion with no text, as admitting a
 * group is, as the coalition titled it. A motion that rewords a section
 * shows its change instead, as any edit does (#120).
 */
export function decisionOf(proposal: Pick<Proposal, 'target' | 'title' | 'text'>): {
  readonly decision?: DissolveView;
} {
  const { target } = proposal;
  if (target.kind === 'reconcile') {
    const title = messages.card.proposalTitle(target.name);
    return { decision: { title, line: messages.coalitions.reconcileLine } };
  }
  if (target.kind === 'motion' && proposal.text === '') {
    return { decision: { title: proposal.title, line: messages.coalitions.motionLine } };
  }
  return {};
}
