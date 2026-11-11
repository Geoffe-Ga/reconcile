/**
 * The Discord webhook client (#119, #123; ADR-0039 step 1, ADR-0011,
 * ADR-0074): the app's one network destination besides the relay, called only
 * for a group that turned its chat bot on by Proposal (src/store/chatBot.ts).
 *
 * The webhook URL is a credential: anyone holding it can post into the
 * channel. It comes only from the group's folded state, is checked with the
 * fold's own validator before anything is sent, and is rebuilt from its id
 * and token on `discord.com`, the one host the deploy CSP's `connect-src`
 * allows ({@link DISCORD_WEBHOOKS}), so a `discordapp.com` URL posts too and
 * nothing else in it survives. No error names it.
 *
 * With a forum channel's webhook, a post can open a thread (`?wait=true` and
 * `thread_name`, reading back only the channel the message landed in) or go
 * into one (`?thread_id=`), and the device can read which server and channel
 * the webhook posts into (a GET of it, reading only those two ids). Every
 * request stays on the webhook's own path, so the CSP needs nothing new: a
 * source's path never matches the query.
 *
 * Discord receives the fixed text it is handed, the app's origin (a
 * cross-origin request always carries it) and the address of the device that
 * posts: no cookie, no referrer, and no mention it could ping anyone with.
 */
import { isDiscordId } from '../engine/chatPosts';
import { webhookParts } from '../engine/optIns';
import type { Fetch } from './relay';

/**
 * The prefix every request goes to, exactly as the deploy CSP's `connect-src`
 * names it (deploy/Caddyfile, client/vite.config.ts).
 */
export const DISCORD_WEBHOOKS = 'https://discord.com/api/webhooks/';

/** The browser's `fetch`, called unbound so it never sees a foreign `this`. */
const browserFetch: Fetch = (input, init) => fetch(input, init);

/**
 * What every request to Discord carries: no cookie or referrer, no HTTP
 * cache, and no redirect, which the CSP's path check couldn't hold.
 */
const QUIET = {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
  redirect: 'error',
} as const;

/** Where a post goes (#123), and the `fetch` it goes through. */
export interface PostOptions {
  /** Opens a forum thread of this name with the post, and waits for Discord's message. */
  readonly threadName?: string;
  /** Posts into the thread with this Discord id. */
  readonly threadId?: string;
  /** The `fetch` to send it through (default: the browser's). */
  readonly fetch?: Fetch;
}

/**
 * What Discord answered a post: whether it took it, its status, and, for a
 * post that opened a thread, the Discord id of the channel the message landed
 * in (the new thread, or the webhook's own channel when it isn't a forum's),
 * or null.
 */
export interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly channel: string | null;
}

/** The server and channel a webhook posts into, as Discord ids (#123). */
export interface WebhookHome {
  readonly guild: string;
  readonly channel: string;
}

/** `webhook` rebuilt on `discord.com` from its id and token, or a `RangeError` that doesn't name it. */
function webhookUrl(webhook: string): string {
  const parts = webhookParts(webhook);
  if (parts === null) {
    throw new RangeError('The chat bot posts only to a Discord webhook URL.');
  }
  return `${DISCORD_WEBHOOKS}${parts.id}/${parts.token}`;
}

/** The query a post's place adds: `?wait=true` to open a thread, `?thread_id=` to post into one. */
function placeQuery({ threadName, threadId }: PostOptions): string {
  if (threadName !== undefined && threadId !== undefined) {
    throw new RangeError('A post opens a thread or goes into one, not both.');
  }
  if (threadName !== undefined) return '?wait=true';
  if (threadId === undefined) return '';
  if (!isDiscordId(threadId)) throw new RangeError('A thread id is a Discord id.');
  return `?thread_id=${threadId}`;
}

/** The response's body as JSON, or null when it isn't JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return null;
  }
}

/** True for a JSON object or array, whose fields can be read by name (an array has none of ours). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** The `channel_id` of the message Discord sent back, when it is a Discord id, or null. */
async function landedIn(response: Response): Promise<string | null> {
  const value = await readJson(response);
  return isRecord(value) && isDiscordId(value.channel_id) ? value.channel_id : null;
}

/**
 * Posts `content` through `webhook`, once: a JSON body of the content and
 * `allowed_mentions: {parse: []}`, so no `@everyone` or name in it pings
 * anyone. With `threadName`, it opens a forum thread of that name
 * (`?wait=true`, `thread_name` after the content) and reads back only the
 * channel the message landed in; with `threadId`, it posts into that thread
 * (`?thread_id=`). It sends no cookie or referrer, skips the HTTP cache and
 * follows no redirect.
 *
 * Resolves with Discord's status, reading nothing it sent back but that
 * channel. Rejects with a `RangeError` before `fetch` runs for a webhook
 * {@link webhookParts} refuses, a thread id that isn't a Discord id, or both a
 * thread name and a thread id, and with `fetch`'s own error when the request
 * fails. It never retries.
 */
export async function postWebhook(
  webhook: string,
  content: string,
  options: PostOptions = {},
): Promise<Answer> {
  const { threadName, fetch: send = browserFetch } = options;
  const url = `${webhookUrl(webhook)}${placeQuery(options)}`;
  const thread = threadName === undefined ? {} : { thread_name: threadName };
  const response = await send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, ...thread, allowed_mentions: { parse: [] } }),
    ...QUIET,
  });
  const { ok, status } = response;
  const channel = ok && threadName !== undefined ? await landedIn(response) : null;
  return { ok, status, channel };
}

/**
 * Reads the server and channel `webhook` posts into (#123), once: a GET of
 * the webhook with no body, cookie, referrer or cache, following no redirect.
 * It reads only `guild_id` and `channel_id`, and resolves null unless Discord
 * answers 2xx with both as Discord ids. Rejects as {@link postWebhook} does
 * for a webhook it refuses or a request that fails.
 */
export async function getWebhook(
  webhook: string,
  options: Pick<PostOptions, 'fetch'> = {},
): Promise<WebhookHome | null> {
  const { fetch: send = browserFetch } = options;
  const response = await send(webhookUrl(webhook), { method: 'GET', ...QUIET });
  if (!response.ok) return null;
  const value = await readJson(response);
  if (!isRecord(value)) return null;
  const { guild_id: guild, channel_id: channel } = value;
  return isDiscordId(guild) && isDiscordId(channel) ? { guild, channel } : null;
}
