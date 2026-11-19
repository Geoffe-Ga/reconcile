/**
 * Group opt-ins (docs/spec/phase-1-spec.md §4 and §11; ADR-0038, ADR-0039,
 * ADR-0040, ADR-0074, ADR-0075 §3 and §5; #117).
 *
 * A group has two opt-ins, both off at founding: the Discord chat bot, which
 * posts content-free nudges through a webhook (ADR-0039, step 1), and the
 * front door, a public page where people can ask to join (ADR-0038), which
 * the group may also list in the public registry (#485; ADR-0081). Each
 * changes only by a rules Proposal, never by a toggle (ADR-0040). Opening one
 * up is entrenched and closing it is ordinary ({@link isWider}), and so is
 * listing the front door again after a steward's narrowing ended its listing
 * ({@link relists}, #501). A
 * steward can close one at once beside their own off-Proposal, until the
 * group decides (stewards.ts, `mayNarrow`).
 *
 * Each opt-in has a standing value, in `state.rules.optIns`: the founding
 * default, or what the last passed rules Proposal set. Its effective value
 * ({@link effectiveOptIn}) is off while a steward's narrowing is in force,
 * and the standing value otherwise. #119 and #121 read the effective value.
 *
 * The webhook URL is a credential: anyone holding it can post into the
 * channel. It lives only in sealed group events and in folded state on
 * members' devices, so it never reaches the relay readable. So do a front
 * door's two secrets (#121): the proposer's device makes them, and they
 * travel only inside the rules Proposal that opens the door. They don't
 * change with the group key, so whoever leaves keeps them: a membership's end
 * closes the door, and only a door with fresh secrets opens again (#288,
 * fold.ts's `endMembership`).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { can, type Roster } from './capabilities';
import { type Closing, isOpenAt } from './open';

/** The opt-ins, in the order screens list them. */
export const OPT_INS = ['chatBot', 'frontDoor'] as const;

/** A group opt-in. */
export type OptIn = (typeof OPT_INS)[number];

/** The chat bot, on: the Discord webhook it posts through. */
export interface ChatBot {
  readonly webhook: string;
}

/**
 * The front door, open (#121; ADR-0038): its two secrets, each 32 bytes in
 * unpadded base64url, and whether its page shows how many people are in the
 * group. `sign` is the Ed25519 secret key the page is signed with, whose
 * public half is the door's address; `box` is the X25519 secret key that
 * opens the applications sealed to the page's `box` (src/crypto/door.ts).
 *
 * A door the group voted to list (#485; ADR-0081) also has `listed: true`
 * and `covenant`, the SHA-256 of the covenant text its voters read, in
 * unpadded base64url (src/shelf/covenant.ts). An unlisted door is written as
 * it was before #485, with neither field, so a build from before then still
 * reads every change that doesn't list (docs/spec/listed-doors.md §3.1, Older
 * apps). `listed: false` alone reads as the same unlisted door.
 */
export interface FrontDoor {
  readonly sign: string;
  readonly box: string;
  readonly showCount: boolean;
  readonly listed?: boolean;
  readonly covenant?: string;
}

/**
 * A value for each opt-in: the chat bot is `null` (off) or `{webhook}`, and
 * the front door is `false` (closed) or a {@link FrontDoor}. {@link isWider}
 * compares only whether the door is open, whether it shows a count
 * (ADR-0075 §5) and whether it is listed (#485), never its keys or its
 * covenant's version.
 */
export interface OptIns {
  readonly chatBot: ChatBot | null;
  readonly frontDoor: FrontDoor | false;
}

/** A value one of the opt-ins can hold. */
export type OptInValue = OptIns[OptIn];

/** Every opt-in off, as each group is founded (ADR-0038: off by default). */
export const OFF: OptIns = { chatBot: null, frontDoor: false };

/**
 * A Discord webhook URL in the one form the bot posts to: `https:` on
 * `discord.com` or `discordapp.com`, the path `/api/webhooks/<digits>/<token>`
 * with a token of letters, digits, `_` and `-`, and nothing else: no port,
 * user, query or fragment, and the host in lower case. Written as one pattern
 * over the whole string rather than read with a URL parser, so every device
 * folds the same answer whatever its browser.
 */
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/;

/** A webhook's two path parts: the webhook's id and its token, the secret part. */
export interface WebhookParts {
  readonly id: string;
  readonly token: string;
}

/**
 * The id and token of a Discord webhook URL the bot may post to, read with
 * {@link isWebhook}'s pattern, or null for anything else. `postWebhook`
 * (src/net/discord.ts, #119) rebuilds the URL from these alone.
 */
export function webhookParts(value: unknown): WebhookParts | null {
  if (typeof value !== 'string') return null;
  const [, id, token] = WEBHOOK.exec(value) ?? [];
  return id === undefined || token === undefined ? null : { id, token };
}

/** True when `value` is a Discord webhook URL the bot may post to. */
export function isWebhook(value: unknown): value is string {
  return webhookParts(value) !== null;
}

/** True when `value` names one of {@link OPT_INS}. */
export function isOptIn(value: unknown): value is OptIn {
  return OPT_INS.some((optIn) => optIn === value);
}

/** True for `{webhook}` with a valid webhook and no other field, `__proto__` included. */
function isChatBot(value: unknown): value is ChatBot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && 'webhook' in value && isWebhook(value.webhook);
}

/** 32 bytes in canonical unpadded base64url: 43 characters, with no spare bit set in the last. */
const BYTES_32 = /^[A-Za-z0-9_-]{43}$/;

/** True when `value` spells 32 bytes, a secret or a SHA-256, in their one canonical form. */
function is32Bytes(value: unknown): value is string {
  return (
    typeof value === 'string' && BYTES_32.test(value) && base64url(fromBase64url(value)) === value
  );
}

/**
 * The fields a front door may have, sorted, as `Object.keys` lists them:
 * unlisted as before #485, unlisted with `listed: false`, or listed with its
 * covenant (#485).
 */
const DOOR_KEYS = new Set(['box,showCount,sign', 'box,listed,showCount,sign']);
const LISTED_KEYS = 'box,covenant,listed,showCount,sign';

/** True when a door's `listed` and `covenant` agree: absent or false with no covenant, or true with one. */
function listingIsValid(keys: string, listed: unknown, covenant: unknown): boolean {
  if (keys === LISTED_KEYS) return listed === true && is32Bytes(covenant);
  return DOOR_KEYS.has(keys) && (listed === undefined || listed === false);
}

/**
 * True for exactly `{sign, box, showCount}`, with `listed: false` or with
 * `listed: true` and a `covenant` (#485): two canonical 32-byte secrets, a
 * boolean, and a covenant hash of 32 bytes exactly when listed, with no other
 * field, `__proto__` included. Any 32 bytes are a key of each kind, so
 * nothing else needs checking, and the covenant is checked for its shape
 * alone: a build that doesn't carry a covenant's words still folds the vote
 * on them as every other build does.
 */
export function isFrontDoor(value: unknown): value is FrontDoor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { sign, box, showCount, listed, covenant } = value as Record<string, unknown>;
  const keys = Object.keys(value).sort().join();
  return (
    listingIsValid(keys, listed, covenant) &&
    is32Bytes(sign) &&
    is32Bytes(box) &&
    typeof showCount === 'boolean'
  );
}

/** The covenant a front door value is listed under, or null when it is closed, unlisted or no door. */
export function listedUnder(value: unknown): string | null {
  return isFrontDoor(value) && value.covenant !== undefined ? value.covenant : null;
}

/**
 * Where the front door's listing stands as a Proposal finds it (#501;
 * docs/spec/listed-doors.md §3.3): whether a steward's narrowing ended the
 * standing door's listing for good, and every address whose listing is final
 * on the shelf. `listingHistory` (frontDoor.ts) reads it from the log.
 */
export interface ListingFound {
  readonly ended: boolean;
  readonly final: ReadonlySet<string>;
}

/** A listing no narrowing has ended, at no final address. */
export const NEVER_ENDED: ListingFound = { ended: false, final: new Set() };

/**
 * True when `value` lists the front door again after a steward's narrowing
 * ended its listing (#501): listed, at an address no listing has left. It is
 * a listing, so it is entrenched like listing an unlisted door, though the
 * standing value it replaces still reads listed. Builds from before #501
 * class it ordinary: the founder accepted that split on 2026-11-19, since
 * every device updates before the pilot (listed-doors.md §3.3).
 */
export function relists(found: ListingFound, value: unknown): boolean {
  return (
    found.ended && isFrontDoor(value) && listedUnder(value) !== null && !found.final.has(value.sign)
  );
}

/** Each opt-in's validator: true for a value that opt-in can hold. */
export const VALIDATORS: { readonly [K in OptIn]: (value: unknown) => value is OptIns[K] } = {
  chatBot: (value): value is ChatBot | null => value === null || isChatBot(value),
  frontDoor: (value): value is FrontDoor | false => value === false || isFrontDoor(value),
};

/** True when `value` passes `optIn`'s validator. */
export function isOptInValue(optIn: OptIn, value: unknown): boolean {
  return VALIDATORS[optIn](value);
}

/** The webhook a chat-bot value posts through, or null when it is off. */
function webhookOf(value: unknown): string | null {
  return isChatBot(value) ? value.webhook : null;
}

/**
 * A front door's fields as one text, or null when it is closed or not a door.
 * An unlisted door reads the same with or without `listed: false` (#485).
 */
function doorText(value: unknown): string | null {
  if (!isFrontDoor(value)) return null;
  const listing = listedUnder(value) ?? '';
  return `${value.sign}.${value.box}.${String(value.showCount)}.${listing}`;
}

/** How two values of each opt-in compare: by what they hold. */
const SAME: { readonly [K in OptIn]: (a: unknown, b: unknown) => boolean } = {
  chatBot: (a, b) => webhookOf(a) === webhookOf(b),
  frontDoor: (a, b) => doorText(a) === doorText(b),
};

/** True when `a` and `b`, values `optIn`'s validator accepts, hold the same. */
export function sameValue(optIn: OptIn, a: unknown, b: unknown): boolean {
  return SAME[optIn](a, b);
}

/**
 * True when `value` is exactly `optIn`'s off value, `null` or `false`.
 * Anything else counts as on, so a value no validator accepts can only ever
 * class as wider, never narrower.
 */
export function isOff(optIn: OptIn, value: unknown): boolean {
  return value === OFF[optIn];
}

/**
 * What a value lets outsiders see or reach, as three flags: whether it is on,
 * whether a front door's page shows the count (#121), and whether the door is
 * listed in the public registry (#485). A front door that is on but no
 * validator accepts has all three, so it can only ever class as wider. A
 * door's keys and its covenant's version never count (ADR-0075 §5).
 */
function exposure(optIn: OptIn, value: unknown): readonly [boolean, boolean, boolean] {
  if (isOff(optIn, value)) return [false, false, false];
  if (optIn === 'chatBot') return [true, false, false];
  if (!isFrontDoor(value)) return [true, true, true];
  return [true, value.showCount, value.listed === true];
}

/**
 * True when changing `optIn` from `from` to `to` widens what outsiders can
 * see or reach (ADR-0040, ADR-0075 §5): off to on, a front door that starts
 * showing its count (#121), and one that is listed (#485; ADR-0081), each
 * whatever else changes. Closing it, replacing one webhook with another,
 * rotating a door's keys, hiding its count, unlisting it and accepting a new
 * covenant version narrow or keep it, so they're ordinary.
 */
export function isWider(optIn: OptIn, from: unknown, to: unknown): boolean {
  const before = exposure(optIn, from);
  return exposure(optIn, to).some((on, i) => on && !before[i]);
}

/**
 * What a rules Proposal changes (#117), as the fold records it when it opens:
 * the opt-in, the value it would set, and `from`, the standing value then.
 */
export type RulesChange = {
  readonly [K in OptIn]: {
    readonly kind: 'rules';
    readonly optIn: K;
    readonly value: OptIns[K];
    readonly from: OptIns[K];
  };
}[OptIn];

/**
 * The change a rules target would make to the standing `optIns`, or null when
 * it names no opt-in or a value that opt-in's validator refuses.
 */
export function rulesChange(optIns: OptIns, optIn: unknown, value: unknown): RulesChange | null {
  if (optIn === 'chatBot' && VALIDATORS.chatBot(value)) {
    return { kind: 'rules', optIn, value, from: optIns.chatBot };
  }
  if (optIn === 'frontDoor' && VALIDATORS.frontDoor(value)) {
    return { kind: 'rules', optIn, value, from: optIns.frontDoor };
  }
  return null;
}

/** The standing opt-ins once `change` has passed. */
export function withChange(optIns: OptIns, change: RulesChange): OptIns {
  return change.optIn === 'chatBot'
    ? { ...optIns, chatBot: change.value }
    : { ...optIns, frontDoor: change.value };
}

/**
 * The front door a rules change would open or keep open, carrying its two
 * secrets, or null for any other change: one to the chat bot, or one that
 * closes the door.
 */
export function doorIn(change: RulesChange | null): FrontDoor | null {
  return change?.optIn === 'frontDoor' && isFrontDoor(change.value) ? change.value : null;
}

/**
 * Where a membership ended and closed the front door (#288): the `leave` or
 * `remove` whose fold ended it, by event id, relay seq and receipt. Whoever
 * left keeps the door's secrets, so the door closes on every device, and only
 * a new opening Proposal, with fresh secrets, opens it again.
 */
export interface DoorClosure {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/**
 * A steward's narrowing (ADR-0040, ADR-0075 §3): from the relay's receipt of
 * its `narrow`, `optIn` is off until `proposal`, the same steward's
 * off-Proposal, closes. `by` is the steward.
 */
export interface Narrowing {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly optIn: OptIn;
  readonly proposal: string;
}

/**
 * What the opt-in rules read of a Proposal: who made it, what it changes, and
 * when it closes, which they read as every rule does ({@link isOpenAt}, #289).
 */
export interface OptInProposalState extends Closing {
  readonly id: string;
  readonly author: string;
  /** A rules change, or any other kind of target, whose details the opt-in rules don't read. */
  readonly target:
    | {
        readonly kind:
          | 'edit'
          | 'add'
          | 'new-document'
          | 'move'
          | 'class'
          | 'steward'
          | 'dissolve'
          | 'remove'
          | 'reconcile'
          | 'motion'
          | 'priority'
          | 'admit'
          | 'dispatch'
          | 'promote';
      }
    | RulesChange;
}

/** What the opt-in rules read of a group, at relay minute `at`. */
export interface OptInState extends Roster {
  readonly rules: { readonly optIns: OptIns };
  readonly proposals: readonly OptInProposalState[];
  readonly narrowings: readonly Narrowing[];
}

/** The rules change a Proposal makes, or null when it makes another kind of change. */
export function rulesChangeOf(proposal: Pick<OptInProposalState, 'target'>): RulesChange | null {
  const { target } = proposal;
  return target.kind === 'rules' ? target : null;
}

/** The rules Proposal open on `optIn` at `state.at`, if any. An opt-in takes one at a time. */
export function openRulesProposal(
  state: Pick<OptInState, 'proposals' | 'at'>,
  optIn: OptIn,
): OptInProposalState | undefined {
  return state.proposals.find((p) => rulesChangeOf(p)?.optIn === optIn && isOpenAt(p, state.at));
}

/** True while a steward's narrowing of `optIn` is in force: its off-Proposal is still open. */
export function isNarrowed(
  state: Pick<OptInState, 'proposals' | 'narrowings' | 'at'>,
  optIn: OptIn,
): boolean {
  return state.narrowings.some((narrowing) => {
    if (narrowing.optIn !== optIn) return false;
    const proposal = state.proposals.find((p) => p.id === narrowing.proposal);
    return proposal !== undefined && isOpenAt(proposal, state.at);
  });
}

/**
 * The value `optIn` has in effect at `state.at`: off while a steward's
 * narrowing is in force, and the standing value otherwise. This is what the
 * chat bot (#119) and the front door (#121) read.
 */
export function effectiveOptIn<K extends OptIn>(
  state: Pick<OptInState, 'rules' | 'proposals' | 'narrowings' | 'at'>,
  optIn: K,
): OptIns[K] {
  return isNarrowed(state, optIn) ? OFF[optIn] : state.rules.optIns[optIn];
}

/** Every opt-in's effective value at `state.at`. */
export function effectiveOptIns(
  state: Pick<OptInState, 'rules' | 'proposals' | 'narrowings' | 'at'>,
): OptIns {
  return {
    chatBot: effectiveOptIn(state, 'chatBot'),
    frontDoor: effectiveOptIn(state, 'frontDoor'),
  };
}

/**
 * Whether a rules target is valid now (#117): it names an opt-in, its value
 * passes that opt-in's validator and differs from the standing value, and no
 * other rules Proposal for that opt-in is open.
 */
export function rulesTargetIsValid(
  state: Pick<OptInState, 'rules' | 'proposals' | 'at'>,
  target: { readonly optIn: unknown; readonly value: unknown },
): boolean {
  const change = rulesChange(state.rules.optIns, target.optIn, target.value);
  return (
    change !== null &&
    !sameValue(change.optIn, change.value, change.from) &&
    openRulesProposal(state, change.optIn) === undefined
  );
}

/** Whether `author` may make a rules Proposal on `target` now: they may propose, and it's valid. */
export function mayProposeRules(
  state: OptInState,
  author: string,
  target: { readonly optIn: unknown; readonly value: unknown },
): boolean {
  return can(state, author, 'propose') && rulesTargetIsValid(state, target);
}
