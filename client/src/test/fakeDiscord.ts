/**
 * An in-memory Discord webhook endpoint (#119), for tests: a `fetch` that
 * records each request a device sends it and answers as Discord answers a
 * post, 204 with no body, unless a test sets another status or takes it
 * offline. It never reaches the network, so no test ever posts to Discord.
 */
import type { Fetch } from '../net/relay';

/** One request the fake received: its URL exactly as given, its options, and its JSON body. */
export interface DiscordRequest {
  readonly url: string;
  readonly init: RequestInit;
  /** The body read as JSON, or the text itself when it isn't JSON. */
  readonly body: unknown;
}

/** A test's handle on the fake endpoint. */
export interface FakeDiscord {
  /** The `fetch` a test device's `postWebhook` calls. */
  readonly fetch: Fetch;
  /** Every request it received, oldest first. */
  readonly requests: DiscordRequest[];
  /** The status it answers with (default: 204). */
  status: number;
  /** While true, every request fails the way `fetch` does with no network. */
  offline: boolean;
}

/** The body as JSON, or as text when it isn't JSON. */
function readBody(body: RequestInit['body']): unknown {
  const text = typeof body === 'string' ? body : '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A fake Discord that answers 204 until a test says otherwise. */
export function createFakeDiscord(): FakeDiscord {
  const discord: FakeDiscord = {
    requests: [],
    status: 204,
    offline: false,
    fetch: (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      discord.requests.push({ url, init, body: readBody(init.body) });
      if (discord.offline) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(null, { status: discord.status }));
    },
  };
  return discord;
}
