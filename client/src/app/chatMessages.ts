/**
 * Ready-made chat messages (#113; ADR-0011, ADR-0074 "Discussion bridge";
 * docs/spec/phase-1-spec.md §8 and §9, "Shares carry no content").
 *
 * Groups talk in the chat they already use. For a group on Signal or
 * WhatsApp, these lines are the only bridge from Reconcile into it, so each
 * moment of a vote gets one: a new Proposal, a version added, a vote closing
 * within a day, and a result. Each is fixed copy whose only variables are the
 * day voting ends, formatted on the device, and, only when someone ticks
 * Include the title for that one share, the Proposal's title. A group name,
 * Document text, a member's name or a link fragment never goes in, and a
 * steward Proposal's title, which names a member, is never offered.
 */
import { type BotMoment, NOTICE_MINUTES } from '../engine/chatPosts';
import type { Proposal } from '../engine/fold';
import type { Notice } from '../store/chatBot';
import { formatDay } from './format';
import { messages } from './messages';

/**
 * When a message is for: a new Proposal (`open`), a version someone added
 * (`version`, #77's line), a vote that closes within a day (`closing`), or a
 * finished vote (`result`).
 */
export type ChatMoment = 'open' | 'version' | 'closing' | 'result';

/** What a message may say about a Proposal. */
export interface ChatDetails {
  /** The Proposal's deadline, a relay minute: the open and version lines say what day it is. */
  readonly deadline: number;
  /** The Proposal's title, only when someone ticked Include the title for this share. */
  readonly title?: string;
}

/** The part of a Proposal a message is made from. */
export type ChatSource = Pick<Proposal, 'deadline' | 'title' | 'target'>;

/** How long before its deadline a vote counts as closing: a day, in relay minutes, as the chat bot's. */
export const CLOSING_MINUTES = NOTICE_MINUTES;

/** Bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069), which could reorder the chat's text. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/** Each line break: CR LF as one, or any one of the Unicode line and paragraph breaks. */
const LINE_BREAKS = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/gu;

/** Each moment's message, given how its first sentence ends and the day voting ends. */
const LINES: Readonly<Record<ChatMoment, (end: string, day: string) => string>> = {
  open: messages.chat.open,
  version: messages.chat.version,
  closing: messages.chat.closing,
  result: messages.chat.result,
};

/** A title as a message quotes it: no bidi controls, each line break a space, trimmed. */
function quotable(title: string): string {
  return title.replace(BIDI_CONTROLS, '').replace(LINE_BREAKS, ' ').trim();
}

/**
 * The message for `moment`, such as "A new Proposal is open in Reconcile.
 * Voting ends Fri 14 Nov.". With a title, the first sentence ends `: "<title>".`
 * instead of a period. `deadline` is dated in the device's time zone unless a
 * test names one.
 */
export function chatMessage(moment: ChatMoment, details: ChatDetails, timeZone?: string): string {
  const title = quotable(details.title ?? '');
  const end = title === '' ? messages.chat.untitled : messages.chat.titled(title);
  return LINES[moment](end, formatDay(details.deadline, timeZone));
}

/**
 * The message an open vote offers `me` at relay minute `now`: the closing
 * line from a day before its deadline; before that, the version line for
 * someone who added a version to another person's Proposal, and the open
 * line for everyone else.
 */
export function openMoment(
  proposal: Pick<Proposal, 'author' | 'versions' | 'deadline'>,
  me: string,
  now: number,
): ChatMoment {
  if (now >= proposal.deadline - CLOSING_MINUTES) return 'closing';
  const addedVersion = proposal.versions.some((version) => version.author === me);
  return addedVersion && proposal.author !== me ? 'version' : 'open';
}

/** The title Include the title may add, or null for a steward Proposal, whose title names a member. */
export function shareableTitle(proposal: ChatSource): string | null {
  return proposal.target.kind === 'edit' ? proposal.title : null;
}

/** What a share of `proposal` says: its deadline, and its title only when `includeTitle`. */
export function chatDetails(proposal: ChatSource, includeTitle: boolean): ChatDetails {
  const title = shareableTitle(proposal);
  return includeTitle && title !== null
    ? { deadline: proposal.deadline, title }
    : { deadline: proposal.deadline };
}

/**
 * What the chat bot posts (#119; spec §9, "Shares carry no content"): for
 * each moment, its message with no title, then the app's address on a line of
 * its own. It is made from the moment and the deadline alone, so no title,
 * name or other word of the group can reach Discord. `origin` is the app's
 * (`location.origin`); `timeZone` dates the deadline, the device's own unless
 * a test names one.
 */
export function botNotice(origin: string, timeZone?: string): Notice {
  return (moment: BotMoment, deadline: number) =>
    `${chatMessage(moment, { deadline }, timeZone)}\n${origin}/`;
}
