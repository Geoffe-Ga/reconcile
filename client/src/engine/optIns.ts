/**
 * Group opt-ins (docs/spec/phase-1-spec.md §4 and §11; ADR-0038, ADR-0039,
 * ADR-0040, ADR-0074, ADR-0075 §3 and §5; #117).
 *
 * A group has two opt-ins, both off at founding: the Discord chat bot, which
 * posts content-free nudges through a webhook (ADR-0039, step 1), and the
 * front door, a public page where people can ask to join (ADR-0038). Each
 * changes only by a rules Proposal, never by a toggle (ADR-0040). Opening one
 * up is entrenched and closing it is ordinary ({@link isWider}), and a
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
 * members' devices, so it never reaches the relay readable.
 */
import { can, type Roster } from './capabilities';

/** The opt-ins, in the order screens list them. */
export const OPT_INS = ['chatBot', 'frontDoor'] as const;

/** A group opt-in. */
export type OptIn = (typeof OPT_INS)[number];

/** The chat bot, on: the Discord webhook it posts through. */
export interface ChatBot {
  readonly webhook: string;
}

/**
 * A value for each opt-in: the chat bot is `null` (off) or `{webhook}`, and
 * the front door is open (`true`) or closed (`false`). #121 may make the
 * front door an object; {@link isWider} then compares only whether it is open
 * and whether it shows a count (ADR-0075 §5).
 */
export interface OptIns {
  readonly chatBot: ChatBot | null;
  readonly frontDoor: boolean;
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

/** Each opt-in's validator: true for a value that opt-in can hold. */
export const VALIDATORS: { readonly [K in OptIn]: (value: unknown) => value is OptIns[K] } = {
  chatBot: (value): value is ChatBot | null => value === null || isChatBot(value),
  frontDoor: (value): value is boolean => typeof value === 'boolean',
};

/** True when `value` passes `optIn`'s validator. */
export function isOptInValue(optIn: OptIn, value: unknown): boolean {
  return VALIDATORS[optIn](value);
}

/** The webhook a chat-bot value posts through, or null when it is off. */
function webhookOf(value: unknown): string | null {
  return isChatBot(value) ? value.webhook : null;
}

/** How two values of each opt-in compare: by what they hold. */
const SAME: { readonly [K in OptIn]: (a: unknown, b: unknown) => boolean } = {
  chatBot: (a, b) => webhookOf(a) === webhookOf(b),
  frontDoor: (a, b) => a === b,
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
 * True when changing `optIn` from `from` to `to` widens what outsiders can
 * see or reach (ADR-0040, ADR-0075 §5): only off to on. Closing it, and
 * replacing one webhook with another, narrow or keep it, so they're ordinary.
 */
export function isWider(optIn: OptIn, from: unknown, to: unknown): boolean {
  return isOff(optIn, from) && !isOff(optIn, to);
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

/** What the opt-in rules read of a Proposal: who made it, what it changes, and when it closes. */
export interface OptInProposalState {
  readonly id: string;
  readonly author: string;
  readonly target: { readonly kind: 'edit' | 'steward' | 'dissolve' | 'remove' } | RulesChange;
  readonly deadline: number;
  readonly closedAt: number | null;
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

/** True while a Proposal takes ballots at relay minute `at`: before its deadline and any early close. */
function isOpen(proposal: OptInProposalState, at: number): boolean {
  return proposal.closedAt === null && at < proposal.deadline;
}

/** The rules Proposal open on `optIn` at `state.at`, if any. An opt-in takes one at a time. */
export function openRulesProposal(
  state: Pick<OptInState, 'proposals' | 'at'>,
  optIn: OptIn,
): OptInProposalState | undefined {
  return state.proposals.find((p) => rulesChangeOf(p)?.optIn === optIn && isOpen(p, state.at));
}

/** True while a steward's narrowing of `optIn` is in force: its off-Proposal is still open. */
export function isNarrowed(
  state: Pick<OptInState, 'proposals' | 'narrowings' | 'at'>,
  optIn: OptIn,
): boolean {
  return state.narrowings.some((narrowing) => {
    if (narrowing.optIn !== optIn) return false;
    const proposal = state.proposals.find((p) => p.id === narrowing.proposal);
    return proposal !== undefined && isOpen(proposal, state.at);
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
