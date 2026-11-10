/**
 * Dissolving a group (docs/spec/phase-1-spec.md §4, Dissolution; ADR-0051,
 * ADR-0072 §10, ADR-0075 §5; #108).
 *
 * A dissolve Proposal is entrenched. Once its pass is final, any member's
 * device that folds it posts a `dissolve` naming it, and the fold takes the
 * first valid one and ignores every event after it. Relay time stops there:
 * a Proposal still open never closes, applies or seats anyone, and every
 * device keeps a read-only copy. With `wipe`, each device erases its copy on
 * the first launch a week after the dissolve; without it, each clears the
 * copy's ballots and notes `ballotExpiryDays` after it. Both count by the
 * device's own clock, because no relay time arrives after a dissolve: the
 * one place device time decides anything.
 *
 * The fold and the screens ask the same functions here, so a screen never
 * offers what the fold would ignore. This file reads only the few fields it
 * names, and imports nothing from the fold.
 */
import { can, type Roster } from './capabilities';
import { DAY_MINUTES, type Rules } from './rules';
import type { TallyOutcome } from './tally';

/** How long after a dissolve each device erases a group whose vote chose to wipe, in days. */
export const WIPE_DAYS = 7;

/**
 * A dissolved group's last moment: the relay's receipt of its `dissolve`, in
 * relay minutes, and whether the vote chose to wipe every copy.
 */
export interface Dissolution {
  readonly received: number;
  readonly wipe: boolean;
}

/** What the dissolve rules read of a Proposal: its id, its target, and when it closes. */
export interface DissolveProposalState {
  readonly id: string;
  readonly target: { readonly kind: string };
  readonly deadline: number;
  readonly closedAt: number | null;
}

/** What the dissolve rules read of a group, at relay minute `at`. */
export interface DissolveState extends Roster {
  readonly dissolved: Dissolution | null;
  readonly proposals: readonly DissolveProposalState[];
}

/** True when a Proposal proposes dissolving the group. */
export function isDissolve(proposal: Pick<DissolveProposalState, 'target'>): boolean {
  return proposal.target.kind === 'dissolve';
}

/** True while a dissolve Proposal takes ballots at `state.at`: before its deadline and any early close. */
export function hasOpenDissolve(state: Pick<DissolveState, 'proposals' | 'at'>): boolean {
  return state.proposals.some((p) => isDissolve(p) && p.closedAt === null && state.at < p.deadline);
}

/**
 * Whether `author` may propose dissolving the group now: it hasn't
 * dissolved, they hold `propose`, and no other dissolve Proposal is open.
 */
export function mayProposeDissolve(state: DissolveState, author: string): boolean {
  return state.dissolved === null && can(state, author, 'propose') && !hasOpenDissolve(state);
}

/**
 * The dissolve Proposal whose final pass waits for its `dissolve`, if any: the
 * first in relay order. Null once the group has dissolved. The device that
 * folds it posts the `dissolve` (src/store/archive.ts).
 */
export function dissolveDue(state: {
  readonly dissolved: Dissolution | null;
  readonly proposals: readonly (Pick<DissolveProposalState, 'id' | 'target'> & {
    readonly final: boolean;
    readonly outcome: TallyOutcome;
  })[];
}): string | null {
  if (state.dissolved !== null) return null;
  const due = state.proposals.find((p) => isDissolve(p) && p.final && p.outcome.kind === 'pass');
  return due?.id ?? null;
}

/**
 * True when a Proposal was still open when its group dissolved: it never
 * closed, and has no outcome. The screens say "Closed when the group
 * dissolved" in place of a countdown or a result.
 */
export function closedByDissolve(
  state: { readonly dissolved: Dissolution | null },
  proposal: { readonly final: boolean },
): boolean {
  return state.dissolved !== null && !proposal.final;
}

/** The relay minute from which a device erases a group that dissolved with `wipe`: a week after. */
export function wipeMinute(dissolved: Dissolution): number {
  return dissolved.received + WIPE_DAYS * DAY_MINUTES;
}

/**
 * The relay minute from which a device clears a dissolved group's ballots and
 * notes, keeping each outcome and total: `ballotExpiryDays` after the dissolve.
 */
export function clearMinute(
  rules: Pick<Rules, 'ballotExpiryDays'>,
  dissolved: Dissolution,
): number {
  return dissolved.received + rules.ballotExpiryDays * DAY_MINUTES;
}
