/**
 * A Proposal's versions as the screens show them (spec §8; ADR-0004):
 * numbered in ballot order, which is relay order, each with its author's name,
 * and, for an add or a removal (#75), a line that says first what it does.
 */
import type { ProposalTarget } from '../engine/event';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import { messages } from './messages';
import { firstWords } from './text/firstWords';

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
  /** What it does, said before its change: where an add goes, or that it removes the section. */
  readonly does?: string;
}

/** Where an add's section goes: after its anchor's first words, at the start, or at the end once the anchor is gone. */
function addsWhere(state: GroupState, after: string | null): string {
  if (after === null) return messages.proposal.addsAtStart;
  const anchor = state.atoms.find((atom) => atom.id === after);
  return anchor === undefined
    ? messages.proposal.addsAtEnd
    : messages.proposal.addsAfter(firstWords(anchor.text));
}

/** What a version with `text` does to the Document (#75), or null for a change of wording. */
export function versionDoes(
  state: GroupState,
  target: ProposalTarget,
  text: string,
): string | null {
  if (target.kind === 'add') return addsWhere(state, target.after);
  return text === '' ? messages.proposal.removes : null;
}

/** True when a ballot already holds a removal: a version whose text is `""` (#75). */
export function holdsRemoval(proposal: {
  readonly versions: readonly { readonly text: string }[];
}): boolean {
  return proposal.versions.some((version) => version.text === '');
}

/** A Proposal's versions in ballot order, each numbered and named. */
export function versionViews(state: GroupState, proposal: Proposal): VersionView[] {
  return proposal.versions.map((version, index) => {
    const does = versionDoes(state, proposal.target, version.text);
    return {
      id: version.id,
      number: index + 1,
      author: displayName(state, version.author) ?? '',
      text: version.text,
      ...(does === null ? {} : { does }),
    };
  });
}
