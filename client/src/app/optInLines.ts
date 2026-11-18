/**
 * The opt-ins in words (#117; ADR-0038, ADR-0039, ADR-0040): what a rules
 * ballot decides, and where each opt-in stands. The engine decides the values
 * (src/engine/optIns.ts); this file only words them. A webhook URL is a
 * credential, so nothing here returns more of it than its last 4 characters.
 */
import type { GroupState } from '../engine/fold';
import {
  effectiveOptIn,
  isFrontDoor,
  isNarrowed,
  isOff,
  listedUnder,
  type OptIn,
  type RulesChange,
} from '../engine/optIns';
import { messages } from './messages';

/** How many of a webhook's characters a screen may show. */
const TAIL = 4;

/** The last 4 characters of a webhook URL: all a screen ever shows of it. */
export function webhookTail(webhook: string): string {
  return webhook.slice(-TAIL);
}

/** What a rules change does: turns its opt-in on, turns it off, or swaps one webhook for another. */
export type Direction = 'on' | 'off' | 'replace';

/** Which way `change` moves its opt-in, from the standing value it opened against. */
export function directionOf(change: RulesChange): Direction {
  if (isOff(change.optIn, change.value)) return 'off';
  return isOff(change.optIn, change.from) ? 'on' : 'replace';
}

/** A table of words with one entry per direction for each opt-in. */
type Worded = Readonly<Record<OptIn, Readonly<Record<Direction, string>>>>;

/** The entry of `table` for `change`. */
function wordsFor(table: Worded, change: RulesChange): string {
  return table[change.optIn][directionOf(change)];
}

/**
 * What else a front door change does (#121), each as its own sentence: a new
 * link, when its keys change on a door that stays open, and the count, when
 * it starts or stops showing.
 */
function doorChanges(change: RulesChange): string[] {
  if (change.optIn !== 'frontDoor' || !isFrontDoor(change.value)) return [];
  const { doorCount } = messages.optIns;
  const from = isFrontDoor(change.from) ? change.from : null;
  const moves = from !== null && from.sign !== change.value.sign ? [doorCount.moves] : [];
  const shown = from?.showCount ?? false;
  if (change.value.showCount === shown) return moves;
  return [...moves, change.value.showCount ? doorCount.shows : doorCount.hides];
}

/** What a front door change does to its listing (#485), or null when it leaves it as it is. */
export type ListingChange = 'list' | 'unlist' | 'renew';

/**
 * How `change` moves the front door's listing: it lists a door that wasn't,
 * unlists or closes one that was, or accepts another covenant (#485).
 */
export function listingChangeOf(change: RulesChange): ListingChange | null {
  if (change.optIn !== 'frontDoor') return null;
  const from = listedUnder(change.from);
  const to = listedUnder(change.value);
  if (from === to) return null;
  if (from === null) return 'list';
  return to === null ? 'unlist' : 'renew';
}

/** True when `change` keeps an open door's keys and count, so only its listing changes. */
function onlyListing(change: RulesChange): boolean {
  const { from, value } = change;
  return (
    isFrontDoor(from) &&
    isFrontDoor(value) &&
    from.sign === value.sign &&
    from.box === value.box &&
    from.showCount === value.showCount
  );
}

/** The heading and the pass of `change`, when they're its listing's own (#485), or null. */
function listingWords(change: RulesChange, listing: ListingChange | null) {
  const { motions, passed, openedAndListed } = messages.optIns.listing;
  if (listing === null) return null;
  if (onlyListing(change)) return { title: motions[listing], passed: passed[listing] };
  return listing === 'list' && isOff(change.optIn, change.from)
    ? { title: wordsFor(messages.optIns.motions, change), passed: openedAndListed }
    : null;
}

/** What a rules ballot decides, in words (#117). */
export interface RulesView {
  readonly optIn: OptIn;
  /** Its heading, which a Proposal's title also starts as. */
  readonly title: string;
  /** What passing does. */
  readonly line: string;
  /** The result's sentence once it passes. */
  readonly passed: string;
  /** The last 4 characters of the webhook it would set, or null for none. */
  readonly tail: string | null;
  /**
   * The covenant hash a front door Proposal asks the group to accept, when it
   * lists the door or accepts another version (#485), so its ballot shows the
   * covenant; else null.
   */
  readonly covenant: string | null;
}

/**
 * The words for a rules change: its heading, what passing does, its pass, and
 * the webhook's last 4. A front door Proposal `exposed` when a member left
 * while it was open (#288) says that passing it opens no door, and its pass
 * that the door stays closed.
 */
export function rulesView(change: RulesChange, exposed = false): RulesView {
  const { motions, lines, passed } = messages.optIns;
  const left = exposed ? [messages.optIns.exposed.line] : [];
  const listing = listingView(change);
  const own = listing.words;
  return {
    optIn: change.optIn,
    title: own?.title ?? wordsFor(motions, change),
    line: [wordsFor(lines, change), ...doorChanges(change), ...listing.line, ...left].join(' '),
    passed: exposed ? messages.optIns.exposed.passed : (own?.passed ?? wordsFor(passed, change)),
    tail: tailOf(change),
    covenant: listing.covenant,
  };
}

/** The last 4 characters of the webhook a chat bot change would set, or null for none. */
function tailOf(change: RulesChange): string | null {
  const webhook = change.optIn === 'chatBot' ? (change.value?.webhook ?? null) : null;
  return webhook === null ? null : webhookTail(webhook);
}

/**
 * What a change does to the front door's listing, in words (#485): its
 * sentence after the line, its own heading and pass when it has them, and
 * the covenant it asks the group to accept, when it lists or renews.
 */
function listingView(change: RulesChange) {
  const listing = listingChangeOf(change);
  const accepts = listing === 'list' || listing === 'renew';
  return {
    line: listing === null ? [] : [messages.optIns.listing.lines[listing]],
    words: listingWords(change, listing),
    covenant: accepts ? listedUnder(change.value) : null,
  };
}

/** Where an opt-in stands now: off, on (with the bot's webhook's last 4), or narrowed by a steward. */
export type OptInStanding =
  | { readonly kind: 'off'; readonly label: string }
  | { readonly kind: 'on'; readonly label: string; readonly tail?: string }
  | {
      readonly kind: 'narrowed';
      readonly label: string;
      /** The steward who turned it off at once. */
      readonly by: string;
      /** Their off-Proposal, which the group is voting on. */
      readonly proposal: string;
    };

/** The steward narrowing of `optIn` in force now, if any. */
function narrowingOf(state: GroupState, optIn: OptIn) {
  if (!isNarrowed(state, optIn)) return undefined;
  return state.narrowings.filter((n) => n.optIn === optIn).at(-1);
}

/** Where `optIn` stands at `state.at`, from its effective value (optIns.ts). */
export function optInState(state: GroupState, optIn: OptIn): OptInStanding {
  const { off, on } = messages.optIns;
  const narrowing = narrowingOf(state, optIn);
  if (narrowing !== undefined) {
    return { kind: 'narrowed', label: off[optIn], by: narrowing.by, proposal: narrowing.proposal };
  }
  const value = effectiveOptIn(state, optIn);
  if (isOff(optIn, value)) return { kind: 'off', label: off[optIn] };
  const webhook = optIn === 'chatBot' ? state.optIns.chatBot?.webhook : undefined;
  return webhook === undefined
    ? { kind: 'on', label: on[optIn] }
    : { kind: 'on', label: on[optIn], tail: webhookTail(webhook) };
}
