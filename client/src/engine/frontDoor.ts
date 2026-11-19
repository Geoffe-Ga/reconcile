/**
 * The front door's one event in the group log (#121; ADR-0038, ADR-0014;
 * docs/spec/phase-1-spec.md §4, Opt-ins).
 *
 * A group that opens its front door by Proposal gets a public page where
 * people can ask to join (src/door/). Applications reach the members' devices
 * sealed to the door's key, and stay on each device: the log never holds one.
 * What the log holds is `door-invited`: a member sent an invite to one
 * application, named by the SHA-256 of its sealed blob, so everyone sees who
 * did and nobody sends a second. Applicants still come in by that invite,
 * then vouches and the wait (ADR-0014, #101).
 *
 * The fold and the devices ask the same function ({@link mayRecordInvite}),
 * so a device never records an invite the fold would ignore.
 *
 * A front door also takes reconcile cards (#426; ADR-0077 §5), which stay on
 * each device as applications do. What the log holds of one is
 * `door-card-closed`: a member who may propose brought it to a vote or
 * dismissed it, so every device stops showing it ({@link mayCloseCard}).
 *
 * A front door may also be listed in the public registry (#485; ADR-0081):
 * its value carries the covenant its group accepted. The listing is part of
 * the door, so it ends whenever the door closes, by a vote, by a steward's
 * narrowing or when a membership ends (#288). A narrowing ends it for good,
 * even once the narrowing lapses and the door reopens (#501): the shelf holds
 * that address's final listing, so the group lists again by one fresh
 * entrenched vote, under a new address, which the fold classes as a listing
 * though the standing value still reads listed ({@link listingHistory},
 * {@link listingInEffect}, optIns.ts's `relists`; docs/spec/listed-doors.md
 * §3.3).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { can, type Roster } from './capabilities';
import {
  effectiveOptIn,
  isFrontDoor,
  listedUnder,
  type ListingFound,
  type OptInProposalState,
  type OptInState,
  type RulesChange,
  rulesChangeOf,
} from './optIns';

/** A SHA-256 in unpadded base64url: 43 characters. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * An invite a member sent to someone who asked at the front door: the first
 * valid `door-invited` for its application, in relay order. `by` is the
 * member who sent it.
 */
export interface DoorInvite {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly application: string;
}

/**
 * A reconcile card from the front door that a member closed (#426): the
 * first valid `door-card-closed` for it, in relay order. `by` closed it.
 */
export interface DoorCardClosed {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly card: string;
}

/** What the invite rule reads of a group, at relay minute `at`. */
export interface DoorInviteState
  extends Roster, Pick<OptInState, 'rules' | 'proposals' | 'narrowings'> {
  readonly doorInvites: readonly DoorInvite[];
}

/** What closing a card reads of a group (#426). */
export interface DoorCardState extends Roster {
  readonly doorCardsClosed: readonly DoorCardClosed[];
}

/** True when `value` is an application's id: a SHA-256 in its one canonical unpadded base64url. */
export function isApplicationId(value: unknown): value is string {
  return (
    typeof value === 'string' && DIGEST.test(value) && base64url(fromBase64url(value)) === value
  );
}

/** The invite recorded for `application`, if one has folded. */
export function inviteFor(
  state: Pick<DoorInviteState, 'doorInvites'>,
  application: string,
): DoorInvite | undefined {
  return state.doorInvites.find((invite) => invite.application === application);
}

/**
 * Whether `author` may record an invite to `application` at `state.at`: they
 * may invite (`can()`, so not a newcomer, a follower or someone suspended),
 * the front door is open in effect (not closed, nor narrowed by a steward),
 * the id is a SHA-256, and nobody has recorded one for it yet.
 */
export function mayRecordInvite(
  state: DoorInviteState,
  author: string,
  application: string,
): boolean {
  return (
    isApplicationId(application) &&
    can(state, author, 'invite') &&
    effectiveOptIn(state, 'frontDoor') !== false &&
    inviteFor(state, application) === undefined
  );
}

/** The record that closed the front-door card `card`, if one has folded (#426). */
export function cardClosedFor(
  state: Pick<DoorCardState, 'doorCardsClosed'>,
  card: string,
): DoorCardClosed | undefined {
  return state.doorCardsClosed.find((closed) => closed.card === card);
}

/**
 * Whether `author` may close the front-door card `card` (#426): they may
 * propose (`can()`), as bringing it to a vote takes, since closing it speaks
 * for the group; the id is a SHA-256; and nobody has closed it yet. The
 * door need not be open: a card held from before it closed may still go.
 */
export function mayCloseCard(state: DoorCardState, author: string, card: string): boolean {
  return (
    isApplicationId(card) &&
    can(state, author, 'propose') &&
    cardClosedFor(state, card) === undefined
  );
}

/** What a listing's history reads of a Proposal: a front door change's pass, and where it sits in relay order. */
export interface ListingProposal extends Pick<
  OptInProposalState,
  'id' | 'author' | 'target' | 'deadline' | 'closedAt'
> {
  readonly seq: number;
  readonly received: number;
  readonly final: boolean;
  readonly outcome: { readonly kind: string };
}

/** What a listing's history reads of a group, at relay minute `at` (#501). */
export interface ListingState extends Pick<OptInState, 'rules' | 'narrowings' | 'at'> {
  readonly proposals: readonly ListingProposal[];
  /** Front door Proposals a membership end exposed while open, whose pass opened nothing (#288). */
  readonly exposedDoors: readonly string[];
}

/**
 * Where a group's listings stand (#501; docs/spec/listed-doors.md §3.3):
 * the address the standing door is listed at, whether that listing has ended
 * for good, and every address whose listing is final on the shelf.
 */
export interface ListingHistory extends ListingFound {
  /** The standing door's address (its `sign`) while it is listed, else null. */
  readonly address: string | null;
  /**
   * True once a steward's narrowing ended the listing at `address`, or when
   * it stands at an address already final: it never shows again there, even
   * once the narrowing lapses and the door reopens.
   */
  readonly ended: boolean;
  /** Every address a listing left, by any change or a narrowing: the shelf holds its final listing. */
  readonly final: ReadonlySet<string>;
}

/** A place in relay order: history up to it leaves out what came at or after it. */
export interface Place {
  readonly seq: number;
  readonly received: number;
}

/** One step of a listing's history: a front door change's pass, or a narrowing of the door. */
type Step =
  | { readonly seq: number; readonly kind: 'pass'; readonly change: RulesChange }
  | { readonly seq: number; readonly kind: 'narrow' };

/** True when `proposal` passed and its change stood: no membership's end exposed it (#288). */
function stood(state: ListingState, proposal: ListingProposal): boolean {
  const passed = proposal.final && proposal.outcome.kind === 'pass';
  return passed && !state.exposedDoors.includes(proposal.id);
}

/** True when what came at `seq` and took effect at relay minute `at` came before `before`. */
function isBefore(before: Place | undefined, seq: number, at: number): boolean {
  return before === undefined || (seq < before.seq && at <= before.received);
}

/** The front door changes that passed and stood, by close, before `before` when given. */
function passes(state: ListingState, before: Place | undefined): Step[] {
  const steps: Step[] = [];
  for (const proposal of state.proposals) {
    const change = rulesChangeOf(proposal);
    const at = proposal.closedAt ?? proposal.deadline;
    const earlier = isBefore(before, proposal.seq, at);
    if (change?.optIn === 'frontDoor' && stood(state, proposal) && earlier) {
      steps.push({ seq: proposal.seq, kind: 'pass', change });
    }
  }
  return steps;
}

/**
 * Every pass and narrowing of the front door, in relay order of the record
 * each came from: a pass by its Proposal's, a narrowing by its own. A group
 * has one front door Proposal open at a time, so its passes come in the
 * order they opened, and a narrowing comes while its off-Proposal is open:
 * after every earlier pass and before every later one, whatever relay minute
 * each closed in. Its off-Proposal's own pass closes the door, so which of
 * the two comes first changes nothing.
 */
function stepsOf(state: ListingState, before: Place | undefined): Step[] {
  const narrowings: Step[] = state.narrowings
    .filter((n) => n.optIn === 'frontDoor' && isBefore(before, n.seq, n.received))
    .map((n) => ({ seq: n.seq, kind: 'narrow' }));
  return [...passes(state, before), ...narrowings].sort((a, b) => a.seq - b.seq);
}

/** The address a front door value is listed at, or null when it isn't listed. */
function listedAt(value: unknown): string | null {
  return isFrontDoor(value) && listedUnder(value) !== null ? value.sign : null;
}

/**
 * The listing after a passed front door change: the address it left goes
 * final, and the door stands listed at the address it lists, if any, ended
 * there exactly when that address is final. So a change that keeps the
 * address (the count, another covenant) leaves an ended listing ended, and
 * one that lists at an address no listing has used shows: from an unlisted
 * or closed door, from a live listing that moves, or from an ended one,
 * which the fold classes entrenched (optIns.ts's `relists`).
 */
function afterPass(
  history: ListingHistory,
  final: Set<string>,
  change: RulesChange,
): ListingHistory {
  const to = listedAt(change.value);
  if (history.address !== null && history.address !== to) final.add(history.address);
  return to === null
    ? { address: null, ended: false, final }
    : { address: to, ended: final.has(to), final };
}

/**
 * The group's listing history (#501), from every front door change that
 * passed and stood and every narrowing of the door, up to `state.at`, or
 * only those before `before` in relay order: how a Proposal found it when it
 * opened. A narrowing ends the listing it meets for good, and its address is
 * final; the door is listed again only by a pass that lists it at an address
 * no listing has used, which is entrenched (`relists`), though the standing
 * value it replaces reads listed. A membership's end, which closes the
 * standing door (#288), ends the listing too.
 */
export function listingHistory(state: ListingState, before?: Place): ListingHistory {
  const final = new Set<string>();
  let history: ListingHistory = { address: null, ended: false, final };
  for (const step of stepsOf(state, before)) {
    if (step.kind === 'pass') history = afterPass(history, final, step.change);
    else if (history.address !== null) {
      final.add(history.address);
      history = { ...history, ended: true };
    }
  }
  // A membership's end closes the standing door, listing and all (#288).
  const closed = before === undefined && listedAt(state.rules.optIns.frontDoor) === null;
  if (!closed || history.address === null) return history;
  final.add(history.address);
  return { address: null, ended: false, final };
}

/**
 * The covenant the front door is listed under at `state.at` (#485), or null
 * when it isn't listed: the door is closed, a steward's narrowing holds it
 * shut, its group never listed it, or a narrowing ended its listing for good,
 * even once the narrowing lapsed and the door reopened as it stood (#501;
 * listed-doors.md §3.3).
 */
export function listingInEffect(state: ListingState): string | null {
  const covenant = listedUnder(effectiveOptIn(state, 'frontDoor'));
  return covenant !== null && !listingHistory(state).ended ? covenant : null;
}
