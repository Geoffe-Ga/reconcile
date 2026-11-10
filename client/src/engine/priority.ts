/**
 * Priority votes (#107; ADR-0074; docs/plan/07_Voting_and_Governance.md):
 * "What should we focus on?" with 2–7 short options, each scored 0–4.
 *
 * A priority vote is a Proposal whose target is `{kind: "priority"}` and
 * whose title is the question. Option `i` sits on its ballot as a version
 * with the id `${proposalId}.${i}`, so ballots, quorum, the bar, early close
 * and the window work as they do for versions. The options that pass rank by
 * the tally's order ({@link rank} in tally.ts), and the top one of the latest
 * priority vote to pass becomes the group's current focus. It changes no
 * Atom. The fold and the composer share these rules, so the composer never
 * sends what the fold would ignore. This file imports nothing from the fold.
 */
import { codePointLength } from './text';

/** The fewest options a priority vote asks about. */
export const OPTIONS_MIN = 2;

/** The most options a priority vote asks about. */
export const OPTIONS_MAX = 7;

/** The longest option, in code points. */
export const OPTION_MAX = 120;

/** The id of option `index` (from 0) of the priority vote `proposalId`. */
export function optionId(proposalId: string, index: number): string {
  return `${proposalId}.${String(index)}`;
}

/** What's wrong with one option, or null when it's fine. */
export type OptionProblem = 'blank' | 'too-long' | 'repeated';

/**
 * Each option's problem, in order, or null for one that's fine: blank, longer
 * than {@link OPTION_MAX} code points, or the same as an earlier one. It
 * measures and compares each option exactly as given, so the author
 * NFC-normalizes and trims the options before signing, and the fold never
 * re-normalizes them (spec §4).
 */
export function optionProblems(options: readonly string[]): (OptionProblem | null)[] {
  return options.map((option, index) => {
    if (option.trim() === '') return 'blank';
    if (codePointLength(option) > OPTION_MAX) return 'too-long';
    return options.indexOf(option) < index ? 'repeated' : null;
  });
}

/** True when there are 2–7 options and none has a problem. */
export function optionsAreValid(options: readonly string[]): boolean {
  return (
    options.length >= OPTIONS_MIN &&
    options.length <= OPTIONS_MAX &&
    optionProblems(options).every((problem) => problem === null)
  );
}

/** What {@link openPriority} reads of a Proposal: its target, and whether it has closed. */
export interface PriorityProposal {
  readonly target: { readonly kind: string };
  readonly final: boolean;
}

/** True for a priority vote. */
export function isPriority(proposal: { readonly target: { readonly kind: string } }): boolean {
  return proposal.target.kind === 'priority';
}

/** The priority vote that hasn't closed, if any. A group has at most one open at a time. */
export function openPriority<P extends PriorityProposal>(state: {
  readonly proposals: readonly P[];
}): P | undefined {
  return state.proposals.find((proposal) => isPriority(proposal) && !proposal.final);
}
