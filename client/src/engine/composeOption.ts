/**
 * What someone can write for one Atom (docs/spec/phase-1-spec.md §4 and §8;
 * ADR-0004, ADR-0047, ADR-0073).
 *
 * An Atom has at most one open Proposal. While it's open, new wording joins
 * its ballot as a version, up to three in all, and a fuller ballot takes no
 * more. A move (#103) is its Proposal's only option, so while one is open the
 * section takes nothing at all, and so is a class Proposal (#116). The fold
 * and the screens both ask
 * {@link optionFor}, so the composer never offers what the fold would ignore.
 * This file imports nothing from the fold: it reads only the few fields it
 * names.
 */

/** The most versions one ballot holds: the Proposal's own text and two more (ADR-0047). */
export const VERSIONS_MAX = 3;

/**
 * What the composer offers for an Atom: a new Proposal, a version of its open
 * one, nothing more on a full ballot, or nothing while a move of it (#103) or
 * a vote on its class (#116) is open.
 */
export type ComposeOption = 'propose' | 'add-version' | 'ballot-full' | 'moving' | 'protecting';

/**
 * What the rule reads of an open Proposal: the versions on its ballot so far,
 * and what kind of change it is, when the reader knows (a move takes none).
 */
export interface BallotSoFar {
  readonly versions: readonly unknown[];
  readonly target?: { readonly kind: string };
}

/** What {@link composeOption} reads of a Proposal: its Atom, its versions, its kind, and whether it has closed. */
export interface ComposeProposal extends BallotSoFar {
  readonly atom: string;
  readonly target: { readonly kind: string };
  readonly final: boolean;
}

/**
 * The one rule: a new Proposal when nothing is open on the Atom, a version
 * while the open ballot has room, and nothing once it holds three, or while
 * the open Proposal is a move (#103) or a class Proposal (#116), whose ballot
 * takes no versions.
 */
export function optionFor(open: BallotSoFar | undefined): ComposeOption {
  if (open === undefined) return 'propose';
  if (open.target?.kind === 'move') return 'moving';
  if (open.target?.kind === 'class') return 'protecting';
  return open.versions.length < VERSIONS_MAX ? 'add-version' : 'ballot-full';
}

/** The Proposal open on `atomId`, if any: one whose vote hasn't closed. */
export function openProposalOn<P extends ComposeProposal>(
  state: { readonly proposals: readonly P[] },
  atomId: string,
): P | undefined {
  return state.proposals.find((proposal) => proposal.atom === atomId && !proposal.final);
}

/**
 * What the composer offers for `atomId` in a folded group: `'propose'`,
 * `'add-version'`, `'ballot-full'`, `'moving'` while a move of it is open, or
 * `'protecting'` while a vote on its class is open (#116).
 */
export function composeOption(
  state: { readonly proposals: readonly ComposeProposal[] },
  atomId: string,
): ComposeOption {
  return optionFor(openProposalOn(state, atomId));
}
