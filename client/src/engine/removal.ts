/**
 * Removing a member by vote (docs/spec/phase-1-spec.md §4, Removal; ADR-0016,
 * ADR-0049, ADR-0059, ADR-0072 §4, ADR-0075 §3; #115).
 *
 * Any voting member may propose removing another member. The vote runs a
 * fixed 14 days at removal's own bar, where a single 0 never blocks, and the
 * person it names isn't in its eligible set, so their own score never counts.
 * They may post one response on the ballot while it's open, even while a
 * steward has them suspended, and a suspension running when the vote opens
 * lasts until it closes (ADR-0059). Once its pass is final they only read
 * (`capabilities.ts`), and any member's device that folds the pass posts one
 * `remove`: the fold takes the first valid one, the member leaves as on a
 * leave, any seat they hold empties, and the group's key changes (#98), so
 * they see nothing new. They keep what their device already has (ADR-0016).
 *
 * The fold and the screens ask the same functions here, so a screen never
 * offers what the fold would ignore. This file reads only the few fields it
 * names, and imports nothing from the fold.
 */
import { can, isOusted, isSuspended, type Roster } from './capabilities';
import type { Dissolution } from './dissolve';
import { isOpenAt } from './open';
import { DAY_MINUTES, type Rules } from './rules';
import { type Suspension, suspensionEnd } from './stewards';
import { codePointLength } from './text';

/** The longest response the person a removal names may post, in code points (ADR-0072 §4). */
export const RESPONSE_MAX = 1_000;

/** Where an event sits in the relay's log, and who wrote it. */
export interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
}

/** The one response the person a removal names posted on its ballot: by them, in relay order. */
export interface RemovalResponse extends Receipt {
  readonly proposal: string;
  readonly text: string;
}

/**
 * A removal whose pass is final: the Proposal, whom it removes, the relay
 * minute its vote closed with that pass, and the `remove` that took them out
 * of the group, or null until one folds.
 */
export interface Removal {
  readonly proposal: string;
  readonly member: string;
  readonly passedAt: number;
  readonly removed: Receipt | null;
}

/** What the removal rules read of a Proposal: its id, what it changes, and when it closes. */
export interface RemovalProposalState {
  readonly id: string;
  readonly target: { readonly kind: string; readonly member?: string | null };
  readonly deadline: number;
  /** Its early close, null until the fold reaches it, on a cleared device too (#289). */
  readonly closedAt: number | null;
}

/** What the removal rules read of a group, at relay minute `at`. */
export interface RemovalState extends Roster {
  readonly dissolved: Dissolution | null;
  readonly proposals: readonly RemovalProposalState[];
  readonly removals: readonly Removal[];
  readonly responses: readonly RemovalResponse[];
}

/** Whom a Proposal would remove, or null when it isn't a removal. */
export function removalTarget(proposal: Pick<RemovalProposalState, 'target'>): string | null {
  const { target } = proposal;
  return target.kind === 'remove' && typeof target.member === 'string' ? target.member : null;
}

/** True when `person` is in the group now. */
function isMember(state: Pick<Roster, 'members'>, person: string): boolean {
  return state.members.some((member) => member.author === person);
}

/** The removal of `person` open at `state.at`, if any: one at a time per person. */
export function openRemovalOf(
  state: Pick<RemovalState, 'proposals' | 'at'>,
  person: string,
): RemovalProposalState | undefined {
  return state.proposals.find((p) => removalTarget(p) === person && isOpenAt(p, state.at));
}

/**
 * Whether `author` may propose removing `person` now (ADR-0049, #115): the
 * group hasn't dissolved, they hold `propose-removal`, and `person` is
 * another current member whom no open removal names and no removal has
 * passed against.
 */
export function mayProposeRemoval(state: RemovalState, author: string, person: string): boolean {
  return (
    state.dissolved === null &&
    can(state, author, 'propose-removal') &&
    person !== author &&
    isMember(state, person) &&
    !isOusted(state, person) &&
    openRemovalOf(state, person) === undefined
  );
}

/** The response posted on removal `proposal`, if any. */
export function responseTo(
  state: Pick<RemovalState, 'responses'>,
  proposal: string,
): RemovalResponse | undefined {
  return state.responses.find((response) => response.proposal === proposal);
}

/**
 * Whether `author` may post their response on removal `proposal` now: it's
 * the removal of them, open at `state.at`, they're still a member, and it
 * has no response yet. A suspension doesn't stop it (ADR-0049).
 */
export function mayRespond(state: RemovalState, author: string, proposal: string): boolean {
  const found = state.proposals.find((p) => p.id === proposal);
  return (
    state.dissolved === null &&
    found !== undefined &&
    removalTarget(found) === author &&
    isOpenAt(found, state.at) &&
    isMember(state, author) &&
    responseTo(state, proposal) === undefined
  );
}

/**
 * True when a response's text is 1–{@link RESPONSE_MAX} code points and not
 * blank. The author trims it and normalizes it to NFC before signing; the
 * fold counts what it received and never normalizes it again.
 */
export function responseFits(text: string): boolean {
  return text.trim() !== '' && codePointLength(text) <= RESPONSE_MAX;
}

/** The passed removal of `proposal` that still waits for its `remove`, while its member is in the group. */
function waitingRemoval(state: RemovalState, proposal: string): Removal | undefined {
  return state.removals.find(
    (removal) =>
      removal.proposal === proposal && removal.removed === null && isMember(state, removal.member),
  );
}

/**
 * Whether a `remove` by `author` naming `proposal` holds now: the group goes
 * on, the author is a member who may act (not suspended, and no removal of
 * them has passed), and `proposal` is a removal whose pass is final and whose
 * member is still in the group. A newcomer still earning a vote may post it.
 */
export function mayRemove(state: RemovalState, author: string, proposal: string): boolean {
  return (
    state.dissolved === null &&
    can(state, author, 'read') &&
    !isSuspended(state, author) &&
    !isOusted(state, author) &&
    waitingRemoval(state, proposal) !== undefined
  );
}

/**
 * The removal whose final pass waits for its `remove`, if any: the first
 * whose vote closed. Null once the group has dissolved. A device that folds
 * it posts the `remove` (src/store/removal.ts).
 */
export function removalDue(state: RemovalState): string | null {
  if (state.dissolved !== null) return null;
  const due = state.removals.find((removal) => waitingRemoval(state, removal.proposal));
  return due?.proposal ?? null;
}

/**
 * The relay minute a removed member's copy clears its ballots, notes and
 * responses (#111, #115): `ballotExpiryDays` after the `remove` that took
 * them out, which the device's own clock counts, since no relay time reaches
 * a copy that no longer syncs. Every ballot it holds expires by then on the
 * devices still in the group. Null until a `remove` has folded.
 */
export function removedClearMinute(
  rules: Pick<Rules, 'ballotExpiryDays'>,
  removal: Pick<Removal, 'removed'>,
): number | null {
  const { removed } = removal;
  return removed === null ? null : removed.received + rules.ballotExpiryDays * DAY_MINUTES;
}

/** The removal that took `person` out of the group, once its `remove` has folded. */
export function removedFrom(
  state: Pick<RemovalState, 'removals'>,
  person: string,
): Removal | undefined {
  return state.removals.find((removal) => removal.member === person && removal.removed !== null);
}

/**
 * A suspension as the removal vote `proposal`, opened while it ran, extends it
 * (ADR-0059, ADR-0075 §3): it lasts until the later of its own end and the
 * vote's close, the early close once there is one, else the deadline. So a
 * vote that fails or lapses after the suspension's own 7 days ends it then,
 * and one opened on its last day keeps it at most 21 days in all. Stewards
 * can't lengthen a suspension; only this does.
 */
export function extendedBy(
  suspension: Suspension,
  rules: Rules,
  proposal: Pick<RemovalProposalState, 'id' | 'deadline' | 'closedAt'>,
): Suspension {
  const own = suspensionEnd(rules, suspension.received);
  const close = proposal.closedAt ?? proposal.deadline;
  return { ...suspension, until: Math.max(own, close), removal: proposal.id };
}
