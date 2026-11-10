/**
 * The chat bot (#119, #123; ADR-0039 step 1, ADR-0011, ADR-0074;
 * docs/spec/phase-1-spec.md §4, Chat bot, and §7): claim, then post, after
 * each sync of a group.
 *
 * No server holds a group's webhook, so the members' devices post its
 * notices, and the log decides which device posts each one. After each sync
 * pass, while the group has its bot on (`effectiveOptIn(state, 'chatBot')`):
 *
 * 1. each claim this device made is settled once it can be: posted when the
 *    fold kept it as the winning claim and its moment is still due, dropped
 *    when another claim won, the fold ignored it, or its moment has passed;
 * 2. each Proposal moment due by the relay's `now` that nobody has claimed
 *    gets a signed `chat-posted` claim in the outbox, its id kept locally.
 *
 * A post goes out once, the claim settled first in one store change, so two
 * tabs can't both send it, and is never retried. It carries only what
 * `notice` makes from the moment and the deadline, and what `threadName`
 * makes from the Proposal's number, which are all they are given: never a
 * title, a name or anything else of the group. A slow or failing Discord
 * never holds up sync. A group this device is leaving (#77) claims and posts
 * nothing.
 *
 * Each Proposal gets its own thread when the webhook belongs to a forum
 * channel (#123). A post for a Proposal with no thread in the log asks
 * Discord to open one, 'Proposal 3 in Reconcile'. A text channel may refuse
 * that with a 400, and the device sends the post once more without it, or
 * may post it in the channel all the same; either way this device remembers
 * that the webhook takes no threads, and from then on posts as #119 does.
 * Otherwise, when the post was the opening this device won, it reads the
 * webhook's server and channel once, and when the message landed in another
 * channel, a new thread, it queues a `chat-thread` with the thread's link.
 * Later posts for the Proposal go into that thread, the result as the
 * concluded line. A group's posts go out one after another, so each sees
 * what the one before it learned.
 */
import { newEventNonce } from '../crypto/nonce';
import { can } from '../engine/capabilities';
import {
  type BotMoment,
  claimFor,
  dueClaims,
  dueMoment,
  mayRecordThread,
  threadFor,
  threadIdOf,
  threadUrl,
} from '../engine/chatPosts';
import { signEvent } from '../engine/event';
import { fold, type GroupState, type Proposal } from '../engine/fold';
import { effectiveOptIn, webhookParts } from '../engine/optIns';
import type { Answer, PostOptions, WebhookHome } from '../net/discord';
import type { ChatChannel, ChatClaim, Group, Store } from './db';

/**
 * The text the bot posts for `moment` of a Proposal whose voting ends at
 * `deadline`, and whether it goes into the Proposal's thread (#123).
 */
export type Notice = (moment: BotMoment, deadline: number, inThread: boolean) => string;

/** Where a post goes: into a new thread of a name, into a thread by its id, or the channel. */
export type Place = Pick<PostOptions, 'threadName' | 'threadId'>;

/** What the bot needs. */
export interface ChatBotOptions {
  /** The device's groups. */
  readonly store: Pick<
    Store,
    'getGroup' | 'claimChat' | 'settleChatClaim' | 'enqueue' | 'noteChatChannel'
  >;
  /** Posts `content` through `webhook` at `place`, once: `postWebhook` (src/net/discord.ts) in the app. */
  readonly post: (webhook: string, content: string, place: Place) => Promise<Answer>;
  /** Reads the server and channel `webhook` posts into, once: `getWebhook` in the app (#123). */
  readonly getWebhook: (webhook: string) => Promise<WebhookHome | null>;
  /** The text for each notice: `botNotice` (src/app/chatMessages.ts) in the app. */
  readonly notice: Notice;
  /** The name of Proposal `number`'s thread: `botThreadName` in the app (#123). */
  readonly threadName: (number: number) => string;
  /** The device clock in milliseconds, an event's display-only `ts` (default: `Date.now`). */
  readonly clock?: () => number;
  /** A claim's nonce (default: `newEventNonce`), so no two claims share bytes. */
  readonly nonce?: () => string;
}

/** The bot, which the sync loop runs after each group it syncs. */
export interface ChatBot {
  /** Settle and make this device's claims for `groupId`, and start any post it won. */
  run(groupId: string): Promise<void>;
  /** Resolves once every post the bot has started so far is done, sent or failed. */
  idle(): Promise<void>;
}

/** The webhook the bot posts through, and its id, which names what the device learned of it. */
interface Webhook {
  readonly url: string;
  readonly id: string;
}

/** What to do with one of this device's claims now. */
type Settlement =
  | { readonly kind: 'wait' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'post'; readonly webhook: Webhook; readonly proposal: Proposal };

const WAIT: Settlement = { kind: 'wait' };
const DROP: Settlement = { kind: 'drop' };

/** One post a won claim makes: `moment` of `proposal`, through `webhook`, as the group stood. */
interface Delivery {
  readonly group: Group;
  readonly state: GroupState;
  readonly webhook: Webhook;
  readonly proposal: Proposal;
  readonly moment: BotMoment;
}

/**
 * What to do with `claim` in `state`: drop it once its moment isn't due, or
 * when the fold ignored it or kept another claim; wait while it is still on
 * its way, or while the bot is off for now; and post it through `webhook`
 * when it won.
 */
function settlementOf(state: GroupState, claim: ChatClaim, webhook: Webhook | null): Settlement {
  const proposal = state.proposals.find((p) => p.id === claim.proposal);
  if (proposal === undefined || dueMoment(proposal, state.at) !== claim.moment) return DROP;
  if (state.ignored.some((record) => record.id === claim.id)) return DROP;
  const winner = claimFor(state, claim.proposal, claim.moment);
  if (winner === undefined) return WAIT;
  if (winner.id !== claim.id) return DROP;
  return webhook === null ? WAIT : { kind: 'post', webhook, proposal };
}

/** The webhook the bot posts through now: the effective one, while `me` is a member, or null. */
function webhookFor(state: GroupState, me: string): Webhook | null {
  if (!can(state, me, 'read')) return null;
  const url = effectiveOptIn(state, 'chatBot')?.webhook;
  const parts = webhookParts(url);
  return url === undefined || parts === null ? null : { url, id: parts.id };
}

/** True when this device already holds a claim of `moment` on `proposal`. */
function holds(group: Group, proposal: string, moment: BotMoment): boolean {
  return (group.chatClaims ?? []).some((c) => c.proposal === proposal && c.moment === moment);
}

/** What this device learned of `webhook`, or null when it has learned nothing of it. */
function learned(group: Group | undefined, webhook: Webhook): ChatChannel['home'] | null {
  const channel = group?.chatChannel;
  return channel?.webhook === webhook.id ? channel.home : null;
}

/** A chat bot over `options.store`. */
export function createChatBot(options: ChatBotOptions): ChatBot {
  const { store, post, getWebhook, notice, threadName } = options;
  const { clock = Date.now, nonce = newEventNonce } = options;
  /** Each group's log length and relay time at its last run: nothing changes until one does. */
  const settled = new Map<string, string>();
  /** Each group's posts, one after another, so each sees what the one before learned. */
  const queues = new Map<string, Promise<void>>();

  /** Starts `job` once the group's earlier posts are done; a failure ends that job alone. */
  function queuePost(groupId: string, job: () => Promise<void>): void {
    const before = queues.get(groupId) ?? Promise.resolve();
    queues.set(
      groupId,
      before.then(job).catch(() => undefined),
    );
  }

  /** Remembers that `webhook` posts into a text channel, which takes no threads. */
  async function noteText(groupId: string, webhook: Webhook): Promise<void> {
    await store.noteChatChannel(groupId, { webhook: webhook.id, home: 'text' });
  }

  /** The webhook's server and channel: as this device learned them, or read from Discord once. */
  async function homeOf(groupId: string, webhook: Webhook): Promise<ChatChannel['home'] | null> {
    const known = learned(await store.getGroup(groupId), webhook);
    if (known !== null) return known;
    const home = await getWebhook(webhook.url);
    if (home !== null) await store.noteChatChannel(groupId, { webhook: webhook.id, home });
    return home;
  }

  /**
   * After a Proposal's opening landed in `channel`: a new thread, unless that
   * is the webhook's own channel. Its link goes in the log only from this
   * device's winning open claim, as the fold would keep it.
   */
  async function recordThread(job: Delivery, channel: string): Promise<void> {
    const { group, state, webhook, proposal } = job;
    if (!mayRecordThread(state, group.me.author, proposal.id)) return;
    const home = await homeOf(group.groupId, webhook);
    if (home === null || home === 'text') return;
    if (home.channel === channel) {
      await noteText(group.groupId, webhook);
      return;
    }
    const url = threadUrl(home.guild, channel);
    if (url === null) return;
    const { record } = signEvent(group.signingKey, {
      type: 'chat-thread',
      group: group.groupId,
      ts: clock(),
      body: { proposal: proposal.id, url },
    });
    await store.enqueue(group.groupId, record);
  }

  /** A post for a Proposal with no thread yet: it opens one, unless the webhook takes none. */
  async function openThread(job: Delivery): Promise<void> {
    const { group, webhook, proposal, moment } = job;
    const content = notice(moment, proposal.deadline, false);
    if (learned(await store.getGroup(group.groupId), webhook) === 'text') {
      await post(webhook.url, content, {});
      return;
    }
    const answer = await post(webhook.url, content, { threadName: threadName(proposal.number) });
    if (answer.status === 400) {
      // A text channel refused the thread: the post goes once more, as #119 sends it.
      if ((await post(webhook.url, content, {})).ok) await noteText(group.groupId, webhook);
      return;
    }
    if (answer.channel !== null) await recordThread(job, answer.channel);
  }

  /** One won claim's post: into the Proposal's thread when the log holds one, else opening it. */
  async function deliver(job: Delivery): Promise<void> {
    const { state, webhook, proposal, moment } = job;
    const thread = threadIdOf(threadFor(state, proposal.id)?.url);
    if (thread === null) {
      await openThread(job);
      return;
    }
    await post(webhook.url, notice(moment, proposal.deadline, true), { threadId: thread });
  }

  async function settle(group: Group, state: GroupState, webhook: Webhook | null): Promise<void> {
    for (const claim of group.chatClaims ?? []) {
      const next = settlementOf(state, claim, webhook);
      if (next.kind === 'wait') continue;
      const mine = await store.settleChatClaim(group.groupId, claim.id);
      if (mine && next.kind === 'post') {
        const job: Delivery = { ...next, group, state, moment: claim.moment };
        // Not awaited, and never retried: a slow or failing Discord can't hold up sync.
        queuePost(group.groupId, () => deliver(job));
      }
    }
  }

  async function claim(group: Group, state: GroupState): Promise<void> {
    for (const due of dueClaims(state, group.me.author)) {
      if (holds(group, due.proposal, due.moment)) continue;
      const body = { proposal: due.proposal, moment: due.moment, nonce: nonce() };
      const { record, id } = signEvent(group.signingKey, {
        type: 'chat-posted',
        group: group.groupId,
        ts: clock(),
        body,
      });
      await store.claimChat(group.groupId, record, { id, ...due });
    }
  }

  return {
    async run(groupId) {
      const group = await store.getGroup(groupId);
      if (group === undefined || group.leaving !== undefined) return;
      const mark = `${String(group.log.length)}@${String(group.relayNow)}`;
      if (settled.get(groupId) === mark) return;
      const state = fold(group.log, group.relayNow);
      const webhook = webhookFor(state, group.me.author);
      await settle(group, state, webhook);
      if (webhook !== null) await claim(group, state);
      settled.set(groupId, mark);
    },
    async idle() {
      await Promise.all(queues.values());
    },
  };
}
