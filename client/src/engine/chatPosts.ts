/**
 * The chat bot's claims (#119; ADR-0039 step 1, ADR-0074; docs/spec/phase-1-spec.md §4, Chat bot).
 *
 * Once a group turns its Discord bot on by Proposal, its channel hears of each
 * of the group's own Proposals three times: when it opens, when its last day
 * starts, and when it is decided; never of a coalition motion it votes on
 * (#100). No server holds the webhook, so a member's device posts each
 * notice, and the group's log decides which one: every device that sees a
 * moment come due claims it with a `chat-posted` event, the fold keeps the
 * first claim per (Proposal, moment) in relay order, and only the device that
 * made the winning claim posts.
 *
 * At any relay minute, at most one moment of a Proposal is due
 * ({@link dueMoment}): `open` from its receipt until a day before its
 * deadline, `closing` from then until it closes, and `result` for a day after
 * it closes. The fold checks a claim against the moment due at its receipt,
 * so nobody can claim a moment early and silence it, and the result window
 * means turning the bot on, or joining, never replays old results.
 *
 * The fold and the devices ask the same function ({@link mayClaim}), so a
 * device never makes a claim the fold would ignore.
 *
 * With a forum channel's webhook, each Proposal gets its own Discord thread
 * (#123; ADR-0011). The device that won a Proposal's `open` claim opens the
 * thread with that post, and records its link with a `chat-thread` event,
 * which the fold keeps once per Proposal ({@link mayRecordThread}): only from
 * that claimant, so no other member can point Join discussion at another
 * server, and only a link of the one form {@link THREAD_URL} names. Later
 * posts for the Proposal go into the thread. The link sits only in the sealed
 * log, and points into the group's own Discord server.
 */
import { can, isOusted, isSuspended, type Roster } from './capabilities';
import { effectiveOptIn, type OptInState } from './optIns';
import { DAY_MINUTES } from './rules';

/** The moments the bot posts, in the order they come: never a version (#113's `version` line). */
export const BOT_MOMENTS = ['open', 'closing', 'result'] as const;

/** A moment the bot posts. */
export type BotMoment = (typeof BOT_MOMENTS)[number];

/**
 * A day, in relay minutes: a vote is closing from this long before its
 * deadline, and its result is due for this long after it closes.
 */
export const NOTICE_MINUTES = DAY_MINUTES;

/** True when `value` is one of {@link BOT_MOMENTS}. */
export function isBotMoment(value: unknown): value is BotMoment {
  return BOT_MOMENTS.some((moment) => moment === value);
}

/** What {@link dueMoment} reads of a Proposal: its deadline and any early close. */
export interface DueProposal {
  readonly deadline: number;
  readonly closedAt: number | null;
}

/**
 * The moment of `proposal` due at relay minute `at`, or null once its result
 * has been due a day: `open` before it closes while its deadline is more than
 * a day off, `closing` before it closes in its last day, and `result` from its
 * close, early (`closedAt`, never after the deadline) or at its deadline,
 * until a day after. `at` is never before the Proposal's receipt: the fold and
 * the devices read only Proposals already in the log.
 */
export function dueMoment(proposal: DueProposal, at: number): BotMoment | null {
  const { deadline } = proposal;
  const close = proposal.closedAt ?? deadline;
  if (at < close) return at < deadline - NOTICE_MINUTES ? 'open' : 'closing';
  return at < close + NOTICE_MINUTES ? 'result' : null;
}

/**
 * A winning claim: the first valid `chat-posted` for its (Proposal, moment),
 * in relay order. `by` is the member whose device posts it.
 */
export interface ChatPost {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly proposal: string;
  readonly moment: BotMoment;
}

/** One (Proposal, moment) a device may claim. */
export interface DueClaim {
  readonly proposal: string;
  readonly moment: BotMoment;
}

/** What the claim rules read of a group, at relay minute `at`. */
export interface ChatPostState extends Roster, Pick<OptInState, 'rules' | 'narrowings'> {
  readonly proposals: readonly (OptInState['proposals'][number] & DueProposal)[];
  readonly chatPosts: readonly ChatPost[];
}

/**
 * A Proposal's Discord thread (#123): the first valid `chat-thread` for it, in
 * relay order. `by` is the member whose device opened it, and `url` its link.
 */
export interface ChatThread {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly proposal: string;
  readonly url: string;
}

/** What the thread rules read of a group: the claim rules' state and the threads kept so far. */
export interface ChatThreadState extends ChatPostState {
  readonly chatThreads: readonly ChatThread[];
}

/** A Discord id (a snowflake) as Discord writes it: 17 to 20 digits and nothing else. */
const DISCORD_ID = /^\d{17,20}$/;

/**
 * The one form of thread link the fold keeps:
 * `https://discord.com/channels/{server id}/{thread id}` and nothing else, no
 * path past the thread, query or fragment. Written as one pattern over the
 * whole string, as the webhook's is, so every device folds the same answer.
 */
export const THREAD_URL = /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})$/;

/** True when `value` is a Discord id: 17 to 20 digits. */
export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_ID.test(value);
}

/** True when `value` is a thread link in the form {@link THREAD_URL} names. */
export function isThreadUrl(value: unknown): value is string {
  return typeof value === 'string' && THREAD_URL.test(value);
}

/** The link to thread `thread` in server `guild`, or null unless both are Discord ids. */
export function threadUrl(guild: string, thread: string): string | null {
  return isDiscordId(guild) && isDiscordId(thread)
    ? `https://discord.com/channels/${guild}/${thread}`
    : null;
}

/** The thread id in a link {@link isThreadUrl} accepts, or null for anything else. */
export function threadIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return THREAD_URL.exec(value)?.[2] ?? null;
}

/** The thread kept for `proposal`, if one has folded. */
export function threadFor(
  state: Pick<ChatThreadState, 'chatThreads'>,
  proposal: string,
): ChatThread | undefined {
  return state.chatThreads.find((thread) => thread.proposal === proposal);
}

/** The winning claim of `moment` on `proposal`, if one has folded. */
export function claimFor(
  state: Pick<ChatPostState, 'chatPosts'>,
  proposal: string,
  moment: BotMoment,
): ChatPost | undefined {
  return state.chatPosts.find((post) => post.proposal === proposal && post.moment === moment);
}

/**
 * True when `author`'s events count now: a member, not suspended (ADR-0016),
 * and not named by a removal whose pass is final, whose events the fold
 * ignores from then on (#115).
 */
function mayAct(state: Roster, author: string): boolean {
  return can(state, author, 'read') && !isSuspended(state, author) && !isOusted(state, author);
}

/**
 * Whether `author` may claim `moment` on `proposal` at `state.at`: they are a
 * member who isn't suspended and whom no passed removal names (#115), the bot
 * is on in effect (not off, nor narrowed by a steward), the Proposal is the
 * group's own and `moment` is the one due, and nobody has claimed it yet. A coalition motion the group votes on (#100)
 * is never claimed: it isn't the group's own, has no number to name a thread,
 * and a device without the coalition's log, as the bot's fold is, doesn't
 * know it. So no thread is ever recorded for one either.
 */
export function mayClaim(
  state: ChatPostState,
  author: string,
  proposal: string,
  moment: BotMoment,
): boolean {
  const target = state.proposals.find((p) => p.id === proposal);
  return (
    target !== undefined &&
    target.target.kind !== 'motion' &&
    mayAct(state, author) &&
    effectiveOptIn(state, 'chatBot') !== null &&
    dueMoment(target, state.at) === moment &&
    claimFor(state, proposal, moment) === undefined
  );
}

/**
 * Whether `author` may record `proposal`'s Discord thread at `state.at`
 * (#123): they are a member who isn't suspended and whom no passed removal
 * names (#115), the bot is on in effect, `author` made the Proposal's winning
 * `open` claim (so it is a Proposal the fold knows), and no thread is kept for
 * it yet. The fold also needs the link to be a {@link THREAD_URL}.
 */
export function mayRecordThread(state: ChatThreadState, author: string, proposal: string): boolean {
  return (
    mayAct(state, author) &&
    effectiveOptIn(state, 'chatBot') !== null &&
    claimFor(state, proposal, 'open')?.by === author &&
    threadFor(state, proposal) === undefined
  );
}

/** Every (Proposal, moment) `author` may claim at `state.at`, in the Proposals' relay order. */
export function dueClaims(state: ChatPostState, author: string): DueClaim[] {
  return state.proposals.flatMap((proposal) => {
    const moment = dueMoment(proposal, state.at);
    return moment !== null && mayClaim(state, author, proposal.id, moment)
      ? [{ proposal: proposal.id, moment }]
      : [];
  });
}
