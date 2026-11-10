/**
 * What someone can write for one Atom (docs/spec/phase-1-spec.md §4 and §8;
 * ADR-0004, ADR-0047, ADR-0073).
 *
 * An Atom has at most one open Proposal. While it's open, new wording joins
 * its ballot as a version, up to three in all, and a fuller ballot takes no
 * more. The fold and the screens both ask {@link optionFor}, so the composer
 * never offers what the fold would ignore. This file imports nothing from the
 * fold: it reads only the few fields it names.
 */

/** The most versions one ballot holds: the Proposal's own text and two more (ADR-0047). */
export const VERSIONS_MAX = 3;

/** What the composer offers for an Atom. */
export type ComposeOption = 'propose' | 'add-version' | 'ballot-full';

/** What the rule reads of an open Proposal: the versions on its ballot so far. */
export interface BallotSoFar {
  readonly versions: readonly unknown[];
}

/** What {@link composeOption} reads of a Proposal: its Atom, its versions, and whether it has closed. */
export interface ComposeProposal extends BallotSoFar {
  readonly atom: string;
  readonly final: boolean;
}

/**
 * The one rule: a new Proposal when nothing is open on the Atom, a version
 * while the open ballot has room, and nothing once it holds three.
 */
export function optionFor(open: BallotSoFar | undefined): ComposeOption {
  if (open === undefined) return 'propose';
  return open.versions.length < VERSIONS_MAX ? 'add-version' : 'ballot-full';
}

/** The Proposal open on `atomId`, if any: one whose vote hasn't closed. */
export function openProposalOn<P extends ComposeProposal>(
  state: { readonly proposals: readonly P[] },
  atomId: string,
): P | undefined {
  return state.proposals.find((proposal) => proposal.atom === atomId && !proposal.final);
}

/** What the composer offers for `atomId` in a folded group: `'propose'`, `'add-version'` or `'ballot-full'`. */
export function composeOption(
  state: { readonly proposals: readonly ComposeProposal[] },
  atomId: string,
): ComposeOption {
  return optionFor(openProposalOn(state, atomId));
}
