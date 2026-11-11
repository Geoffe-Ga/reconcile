/**
 * An in-memory Discord webhook endpoint (#119, #123), for tests: a `fetch`
 * that records each request a device sends it and answers as Discord answers
 * a webhook, for a text channel or a forum channel. It never reaches the
 * network, so no test ever posts to Discord.
 *
 * - A GET of the webhook answers its server and channel ids.
 * - A post into a text channel answers 204 (or its message, with `?wait=true`).
 *   Asked to open a thread (`thread_name`), a text channel refuses with 400,
 *   or, as `text-ignoring`, posts in the channel all the same.
 * - A forum channel opens a new thread for each `thread_name` and answers its
 *   message, whose `channel_id` is the thread; a post with `?thread_id=` of a
 *   thread it opened answers 204, and anything else 400, as a forum takes no
 *   post outside a thread.
 */
import type { Fetch } from '../net/relay';

/** The server the fake webhook belongs to. */
export const FAKE_GUILD = '1188000000000000001';

/** The channel the fake webhook belongs to. */
export const FAKE_CHANNEL = '1199000000000000777';

/** The kind of channel the fake webhook posts into. */
export type FakeChannel = 'text' | 'text-ignoring' | 'forum';

/** One request the fake received, and how it answered. */
export interface DiscordRequest {
  readonly method: string;
  /** The URL exactly as given. */
  readonly url: string;
  readonly init: RequestInit;
  /** The body read as JSON, the text itself when it isn't JSON, or null for none. */
  readonly body: unknown;
  /** The status it answered with, or null when it failed the request. */
  readonly status: number | null;
}

/** A test's handle on the fake endpoint. */
export interface FakeDiscord {
  /** The `fetch` a test device's Discord calls go through. */
  readonly fetch: Fetch;
  /** Every request it received, oldest first. */
  readonly requests: DiscordRequest[];
  /** The kind of channel the webhook posts into (default: `text`). */
  channel: FakeChannel;
  /** A status it answers every request with, and no body, instead of Discord's own; null by default. */
  status: number | null;
  /** While true, every request fails the way `fetch` does with no network. */
  offline: boolean;
  /** How long it takes to answer each request, in milliseconds (default: 0, at once). */
  latency: number;
  /** The id of each thread it opened, oldest first. */
  readonly threads: string[];
}

/** The body as JSON, the text when it isn't JSON, or null for none. */
function readBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** A JSON answer. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Discord's answer to a post that landed in `channel`: its message with `?wait=true`, else 204. */
function landed(url: URL, channel: string): Response {
  if (url.searchParams.get('wait') !== 'true') return new Response(null, { status: 204 });
  return json({ id: '1400000000000000001', type: 0, channel_id: channel });
}

/** True when the post asks to open a thread. */
function opensThread(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'thread_name' in body;
}

/** A fake Discord: a text channel's webhook until a test says otherwise. */
export function createFakeDiscord(): FakeDiscord {
  /** How the webhook's channel answers a post. */
  function answerPost(url: URL, body: unknown): Response {
    const thread = url.searchParams.get('thread_id');
    if (discord.channel !== 'forum') {
      const refused = thread !== null || (opensThread(body) && discord.channel === 'text');
      return refused ? json({ code: 220003 }, 400) : landed(url, FAKE_CHANNEL);
    }
    if (opensThread(body)) {
      const id = `13090000000000000${String(discord.threads.length + 10)}`;
      discord.threads.push(id);
      return landed(url, id);
    }
    return thread !== null && discord.threads.includes(thread)
      ? landed(url, thread)
      : json({ code: 220001 }, 400);
  }

  function answer(method: string, url: URL, body: unknown): Response {
    if (discord.status !== null) return new Response(null, { status: discord.status });
    if (method === 'GET') {
      return json({ id: '1199000000000000001', guild_id: FAKE_GUILD, channel_id: FAKE_CHANNEL });
    }
    return answerPost(url, body);
  }

  const discord: FakeDiscord = {
    requests: [],
    channel: 'text',
    status: null,
    offline: false,
    latency: 0,
    threads: [],
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init.method ?? 'GET';
      const body = readBody(init.body);
      if (discord.offline) {
        discord.requests.push({ method, url, init, body, status: null });
        throw new TypeError('Failed to fetch');
      }
      const response = answer(method, new URL(url), body);
      discord.requests.push({ method, url, init, body, status: response.status });
      if (discord.latency > 0) {
        await new Promise((resolve) => setTimeout(resolve, discord.latency));
      }
      return response;
    },
  };
  return discord;
}

/** The posts Discord took: every POST it answered 2xx, in order. */
export function delivered(discord: FakeDiscord): DiscordRequest[] {
  return discord.requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.status !== null &&
      request.status >= 200 &&
      request.status < 300,
  );
}
