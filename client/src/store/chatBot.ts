/**
 * The chat bot (#119; ADR-0039 step 1, ADR-0074; docs/spec/phase-1-spec.md §4,
 * Chat bot, and §7): claim, then post, after each sync of a group.
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
 * `notice` makes from the moment and the deadline, which are all it is given:
 * never a title, a name or anything else of the group. A slow or failing
 * Discord never holds up sync. A group this device is leaving (#77) claims
 * and posts nothing.
 */
import { newEventNonce } from '../crypto/nonce';
import { can } from '../engine/capabilities';
import { type BotMoment, claimFor, dueClaims, dueMoment } from '../engine/chatPosts';
import { signEvent } from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import { effectiveOptIn } from '../engine/optIns';
import type { ChatClaim, Group, Store } from './db';

/** The text the bot posts for `moment` of a Proposal whose voting ends at `deadline`. */
export type Notice = (moment: BotMoment, deadline: number) => string;

/** What the bot needs. */
export interface ChatBotOptions {
  /** The device's groups. */
  readonly store: Pick<Store, 'getGroup' | 'claimChat' | 'settleChatClaim'>;
  /** Posts `content` through `webhook`, once: `postWebhook` (src/net/discord.ts) in the app. */
  readonly post: (webhook: string, content: string) => Promise<unknown>;
  /** The text for each notice: `botNotice` (src/app/chatMessages.ts) in the app. */
  readonly notice: Notice;
  /** The device clock in milliseconds, a claim's display-only `ts` (default: `Date.now`). */
  readonly clock?: () => number;
  /** A claim's nonce (default: `newEventNonce`), so no two claims share bytes. */
  readonly nonce?: () => string;
}

/** The bot, which the sync loop runs after each group it syncs. */
export interface ChatBot {
  /** Settle and make this device's claims for `groupId`, and start any post it won. */
  run(groupId: string): Promise<void>;
}

/** What to do with one of this device's claims now. */
type Settlement =
  | { readonly kind: 'wait' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'post'; readonly webhook: string; readonly deadline: number };

const WAIT: Settlement = { kind: 'wait' };
const DROP: Settlement = { kind: 'drop' };

/**
 * What to do with `claim` in `state`: drop it once its moment isn't due, or
 * when the fold ignored it or kept another claim; wait while it is still on
 * its way, or while the bot is off for now; and post it through `webhook`
 * when it won.
 */
function settlementOf(state: GroupState, claim: ChatClaim, webhook: string | null): Settlement {
  const proposal = state.proposals.find((p) => p.id === claim.proposal);
  if (proposal === undefined || dueMoment(proposal, state.at) !== claim.moment) return DROP;
  if (state.ignored.some((record) => record.id === claim.id)) return DROP;
  const winner = claimFor(state, claim.proposal, claim.moment);
  if (winner === undefined) return WAIT;
  if (winner.id !== claim.id) return DROP;
  return webhook === null ? WAIT : { kind: 'post', webhook, deadline: proposal.deadline };
}

/** The webhook the bot posts through now: the effective one, while `me` is a member, or null. */
function webhookFor(state: GroupState, me: string): string | null {
  return can(state, me, 'read') ? (effectiveOptIn(state, 'chatBot')?.webhook ?? null) : null;
}

/** True when this device already holds a claim of `moment` on `proposal`. */
function holds(group: Group, proposal: string, moment: BotMoment): boolean {
  return (group.chatClaims ?? []).some((c) => c.proposal === proposal && c.moment === moment);
}

/** A chat bot over `options.store`. */
export function createChatBot(options: ChatBotOptions): ChatBot {
  const { store, post, notice, clock = Date.now, nonce = newEventNonce } = options;
  /** Each group's log length and relay time at its last run: nothing changes until one does. */
  const settled = new Map<string, string>();

  async function settle(group: Group, state: GroupState, webhook: string | null): Promise<void> {
    for (const claim of group.chatClaims ?? []) {
      const next = settlementOf(state, claim, webhook);
      if (next.kind === 'wait') continue;
      const mine = await store.settleChatClaim(group.groupId, claim.id);
      if (mine && next.kind === 'post') {
        // Not awaited, and never retried: a slow or failing Discord can't hold up sync.
        post(next.webhook, notice(claim.moment, next.deadline)).catch(() => undefined);
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
  };
}
