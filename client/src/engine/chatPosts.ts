/**
 * The chat bot's claims (#119; ADR-0039 step 1, ADR-0074; docs/spec/phase-1-spec.md §4, Chat bot).
 *
 * Once a group turns its Discord bot on by Proposal, its channel hears of each
 * Proposal three times: when it opens, when its last day starts, and when it
 * is decided. No server holds the webhook, so a member's device posts each
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
 */
import { can, isSuspended, type Roster } from './capabilities';
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

/** The winning claim of `moment` on `proposal`, if one has folded. */
export function claimFor(
  state: Pick<ChatPostState, 'chatPosts'>,
  proposal: string,
  moment: BotMoment,
): ChatPost | undefined {
  return state.chatPosts.find((post) => post.proposal === proposal && post.moment === moment);
}

/** True when `author`'s events count now: a member, not suspended (ADR-0016). */
function mayAct(state: Roster, author: string): boolean {
  return can(state, author, 'read') && !isSuspended(state, author);
}

/**
 * Whether `author` may claim `moment` on `proposal` at `state.at`: they are a
 * member who isn't suspended, the bot is on in effect (not off, nor narrowed
 * by a steward), the Proposal is known and `moment` is the one due, and
 * nobody has claimed it yet.
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
    mayAct(state, author) &&
    effectiveOptIn(state, 'chatBot') !== null &&
    dueMoment(target, state.at) === moment &&
    claimFor(state, proposal, moment) === undefined
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
