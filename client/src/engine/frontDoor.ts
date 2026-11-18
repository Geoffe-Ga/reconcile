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
 * narrowing or when a membership ends (#288), and relisting takes a new
 * opening Proposal, with fresh secrets and a new address
 * ({@link listingInEffect}; docs/spec/listed-doors.md §3.3).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { can, type Roster } from './capabilities';
import { effectiveOptIn, listedUnder, type OptInState } from './optIns';

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

/**
 * The covenant the front door is listed under at `state.at` (#485), or null
 * when it isn't listed: the door is closed, a steward's narrowing holds it
 * shut, or its group never listed it. A listing ends with its door.
 */
export function listingInEffect(
  state: Pick<OptInState, 'rules' | 'proposals' | 'narrowings' | 'at'>,
): string | null {
  return listedUnder(effectiveOptIn(state, 'frontDoor'));
}
