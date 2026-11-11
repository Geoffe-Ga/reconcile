import { describe, expect, it, vi } from 'vitest';

import viteConfig from '../../vite.config.ts?raw';
import { DISCORD_WEBHOOKS, getWebhook, postWebhook } from './discord';
import type { Fetch } from './relay';

const ID = '1199000000000000001';
const TOKEN = 'rV7-first_token';
const WEBHOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const CONTENT =
  'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.\nhttps://app.example/';
const GUILD = '1188000000000000001';
const FORUM = '1199000000000000777';
const THREAD = '1309000000000000003';

/** What every request to Discord carries besides its method, headers and body. */
const QUIET = {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
  redirect: 'error',
} as const;

/** A fetch spy that answers every request with a fresh `answer()`, as Discord would. */
function discordWith(answer: () => Response) {
  const answers: Response[] = [];
  const send = vi.fn<Fetch>(() => {
    const response = answer();
    answers.push(response);
    return Promise.resolve(response);
  });
  return Object.assign(send, { answers });
}

/** A fetch spy that answers every request with `status` and no body, as Discord answers a post. */
function discord(status = 204) {
  return discordWith(() => new Response(null, { status }));
}

/** A fetch spy that answers with `status` and `json` as the body. */
function discordJson(json: unknown, status = 200) {
  return discordWith(
    () =>
      new Response(JSON.stringify(json), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

/** The one request `send` was called with: its URL and options. */
function onlyCall(send: ReturnType<typeof discord>): { url: string; init: RequestInit } {
  expect(send).toHaveBeenCalledTimes(1);
  const [input, init] = send.mock.calls[0] ?? [];
  if (typeof input !== 'string' || init === undefined) throw new Error('Expected (url, init).');
  return { url: input, init };
}

/** The message Discord sends back for a post with `?wait=true`, landed in `channel`. */
function message(channel: unknown) {
  return { id: '1400000000000000001', type: 0, content: CONTENT, channel_id: channel };
}

describe('postWebhook (#119)', () => {
  it('POSTs exactly the content, with no mentions, as JSON, sending no cookie, referrer or cache, and following no redirect', async () => {
    const send = discord();

    await expect(postWebhook(WEBHOOK, CONTENT, { fetch: send })).resolves.toEqual({
      ok: true,
      status: 204,
      channel: null,
    });

    const { url, init } = onlyCall(send);
    expect(url).toBe(WEBHOOK);
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: CONTENT, allowed_mentions: { parse: [] } }),
      ...QUIET,
    });
    expect(typeof init.body === 'string' ? JSON.parse(init.body) : null).toEqual({
      content: CONTENT,
      allowed_mentions: { parse: [] },
    });
  });

  it('posts a discordapp.com webhook to discord.com, the one host the CSP allows', async () => {
    const send = discord();

    await postWebhook(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`, CONTENT, {
      fetch: send,
    });

    expect(onlyCall(send).url).toBe(WEBHOOK);
  });

  it.each([
    ['http:', `http://discord.com/api/webhooks/${ID}/${TOKEN}`],
    ['another host', `https://example.com/api/webhooks/${ID}/${TOKEN}`],
    ['a look-alike host', `https://discord.com.example.com/api/webhooks/${ID}/${TOKEN}`],
    ['an extra path segment', `https://discord.com/api/webhooks/${ID}/${TOKEN}/slack`],
    ['a query', `${WEBHOOK}?wait=true`],
    ['a fragment', `${WEBHOOK}#x`],
    ['another Discord API path', `https://discord.com/api/channels/${ID}/messages`],
    ['a URL that isn’t Discord’s', 'https://reconcile.test/v1/mailbox/x'],
    ['an empty string', ''],
  ])('refuses %s before fetch runs, without naming the URL', async (_name, url) => {
    const send = discord();

    const refused = postWebhook(url, CONTENT, { fetch: send });

    await expect(refused).rejects.toThrow(RangeError);
    await expect(refused).rejects.not.toThrow(TOKEN);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers with Discord’s status when it isn’t 2xx, reading nothing it sent back', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      const send = discordJson({ code: 50027, message: 'Invalid Webhook Token' }, status);
      await expect(postWebhook(WEBHOOK, CONTENT, { fetch: send })).resolves.toEqual({
        ok: false,
        status,
        channel: null,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.answers.map((answer) => answer.bodyUsed)).toEqual([false]);
    }
    const ok = discordJson(message(THREAD));
    await expect(postWebhook(WEBHOOK, CONTENT, { fetch: ok })).resolves.toEqual({
      ok: true,
      status: 200,
      channel: null,
    });
    expect(ok.answers.map((answer) => answer.bodyUsed)).toEqual([false]);
  });

  it('rejects, once, when the network or a redirect fails the request', async () => {
    const send = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(postWebhook(WEBHOOK, CONTENT, { fetch: send })).rejects.toThrow(TypeError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('postWebhook into a thread (#123)', () => {
  it('opens a forum thread with ?wait=true and thread_name, and reads the channel the message landed in', async () => {
    const send = discordJson(message(THREAD));

    const answer = postWebhook(WEBHOOK, CONTENT, {
      threadName: 'Proposal 3 in Reconcile',
      fetch: send,
    });

    await expect(answer).resolves.toEqual({ ok: true, status: 200, channel: THREAD });
    const { url, init } = onlyCall(send);
    expect(url).toBe(`${WEBHOOK}?wait=true`);
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: CONTENT,
        thread_name: 'Proposal 3 in Reconcile',
        allowed_mentions: { parse: [] },
      }),
      ...QUIET,
    });
  });

  it.each([
    ['names no channel', { id: '1400000000000000001' }],
    ['names a channel that isn’t a Discord id', message('1309-not-an-id')],
    ['names a channel as a number', message(1309)],
    ['is a list', [message(THREAD)]],
    ['is null', null],
  ])('reads no channel from an answer that %s', async (_name, json) => {
    const send = discordJson(json);
    await expect(
      postWebhook(WEBHOOK, CONTENT, { threadName: 'Proposal 3 in Reconcile', fetch: send }),
    ).resolves.toEqual({ ok: true, status: 200, channel: null });
  });

  it('reads no channel from an answer that isn’t JSON, or has no body', async () => {
    const text = discordWith(() => new Response('<html>', { status: 200 }));
    await expect(
      postWebhook(WEBHOOK, CONTENT, { threadName: 'Proposal 3 in Reconcile', fetch: text }),
    ).resolves.toEqual({ ok: true, status: 200, channel: null });
    const empty = discord(204);
    await expect(
      postWebhook(WEBHOOK, CONTENT, { threadName: 'Proposal 3 in Reconcile', fetch: empty }),
    ).resolves.toEqual({ ok: true, status: 204, channel: null });
  });

  it('answers a refused thread with its status, reading nothing more', async () => {
    const send = discordJson(
      { code: 220003, message: 'Webhooks can only create threads in forum channels' },
      400,
    );

    const answer = postWebhook(WEBHOOK, CONTENT, {
      threadName: 'Proposal 3 in Reconcile',
      fetch: send,
    });

    await expect(answer).resolves.toEqual({ ok: false, status: 400, channel: null });
    expect(send.answers.map((response) => response.bodyUsed)).toEqual([false]);
  });

  it('posts into a thread with ?thread_id=, its body as a channel post’s', async () => {
    const send = discord();

    await expect(postWebhook(WEBHOOK, CONTENT, { threadId: THREAD, fetch: send })).resolves.toEqual(
      { ok: true, status: 204, channel: null },
    );

    const { url, init } = onlyCall(send);
    expect(url).toBe(`${WEBHOOK}?thread_id=${THREAD}`);
    expect(init.body).toBe(JSON.stringify({ content: CONTENT, allowed_mentions: { parse: [] } }));
  });

  it.each([
    ['a thread id that isn’t a Discord id', { threadId: `${THREAD}&wait=true` }],
    ['a short thread id', { threadId: '1309' }],
    ['both a thread name and a thread id', { threadName: 'Proposal 3', threadId: THREAD }],
  ])('refuses %s before fetch runs', async (_name, options) => {
    const send = discord();

    await expect(postWebhook(WEBHOOK, CONTENT, { ...options, fetch: send })).rejects.toThrow(
      RangeError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('getWebhook (#123)', () => {
  /** The webhook object Discord answers a GET of a webhook URL with. */
  const webhookObject = (guild: unknown = GUILD, channel: unknown = FORUM) => ({
    application_id: null,
    avatar: null,
    channel_id: channel,
    guild_id: guild,
    id: ID,
    name: 'Reconcile',
    type: 1,
    token: TOKEN,
  });

  it('GETs the webhook with no body, cookie, referrer or cache, following no redirect, and reads its server and channel', async () => {
    const send = discordJson(webhookObject());

    await expect(getWebhook(WEBHOOK, { fetch: send })).resolves.toEqual({
      guild: GUILD,
      channel: FORUM,
    });

    const { url, init } = onlyCall(send);
    expect(url).toBe(WEBHOOK);
    expect(init).toEqual({ method: 'GET', ...QUIET });
  });

  it('reads a discordapp.com webhook on discord.com', async () => {
    const send = discordJson(webhookObject());
    await getWebhook(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`, { fetch: send });
    expect(onlyCall(send).url).toBe(WEBHOOK);
  });

  it.each([
    ['a server id that isn’t a Discord id', webhookObject('guild', FORUM), 200],
    ['a channel id that isn’t a Discord id', webhookObject(GUILD, 7), 200],
    ['no server', { channel_id: FORUM }, 200],
    ['a list', [webhookObject()], 200],
    ['an error', { code: 10015, message: 'Unknown Webhook' }, 404],
    ['a refusal, whatever its body says', webhookObject(), 401],
  ])('answers null for %s', async (_name, json, status) => {
    await expect(getWebhook(WEBHOOK, { fetch: discordJson(json, status) })).resolves.toBeNull();
  });

  it('answers null for a body that isn’t JSON', async () => {
    const send = discordWith(() => new Response('<html>', { status: 200 }));
    await expect(getWebhook(WEBHOOK, { fetch: send })).resolves.toBeNull();
  });

  it('refuses a URL that isn’t a webhook before fetch runs, and rejects when the network fails', async () => {
    const send = discord();
    await expect(getWebhook(`${WEBHOOK}/x`, { fetch: send })).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
    const offline = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(getWebhook(WEBHOOK, { fetch: offline })).rejects.toThrow(TypeError);
  });
});

/** The deploy CSP's directives, as vite.config.ts serves them under `vite preview`. */
function deployCsp(): Map<string, string[]> {
  const policy = /'Content-Security-Policy':\s*"([^"]*)"/.exec(viteConfig)?.[1] ?? '';
  return new Map(
    policy.split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('the deploy CSP and the webhook (#119, #123)', () => {
  it('lets the page connect to its own origin and to Discord’s webhook path, and nowhere else', () => {
    expect(deployCsp().get('connect-src')).toEqual(["'self'", DISCORD_WEBHOOKS]);
    expect(DISCORD_WEBHOOKS).toBe('https://discord.com/api/webhooks/');
  });

  it('sends every request, thread posts and the webhook read included, to a path under it', async () => {
    const send = discordJson(message(THREAD));
    const discordapp = `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`;
    await postWebhook(discordapp, CONTENT, { fetch: send });
    await postWebhook(discordapp, CONTENT, { threadName: 'Proposal 3 in Reconcile', fetch: send });
    await postWebhook(discordapp, CONTENT, { threadId: THREAD, fetch: send });
    await getWebhook(discordapp, { fetch: send });
    const urls = send.mock.calls.map(([input]) => (typeof input === 'string' ? input : ''));
    expect(urls).toHaveLength(4);
    // A CSP source's path matches the URL's path alone: a query never widens it.
    for (const url of urls) expect(new URL(url).pathname).toBe(`/api/webhooks/${ID}/${TOKEN}`);
    for (const url of urls) expect(url.startsWith(DISCORD_WEBHOOKS)).toBe(true);
  });
});
