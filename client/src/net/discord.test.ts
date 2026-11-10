import { describe, expect, it, vi } from 'vitest';

import viteConfig from '../../vite.config.ts?raw';
import { DISCORD_WEBHOOKS, postWebhook } from './discord';
import type { Fetch } from './relay';

const ID = '1199000000000000001';
const TOKEN = 'rV7-first_token';
const WEBHOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const CONTENT =
  'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.\nhttps://app.example/';

/** A fetch spy that answers every request with `status` and no body, as Discord answers a post. */
function discord(status = 204) {
  return vi.fn<Fetch>(() => Promise.resolve(new Response(null, { status })));
}

/** The one request `send` was called with: its URL and options. */
function onlyCall(send: ReturnType<typeof discord>): { url: string; init: RequestInit } {
  expect(send).toHaveBeenCalledTimes(1);
  const [input, init] = send.mock.calls[0] ?? [];
  if (typeof input !== 'string' || init === undefined) throw new Error('Expected (url, init).');
  return { url: input, init };
}

describe('postWebhook (#119)', () => {
  it('POSTs exactly the content, with no mentions, as JSON, sending no cookie, referrer or cache, and following no redirect', async () => {
    const send = discord();

    await expect(postWebhook(WEBHOOK, CONTENT, send)).resolves.toBe(true);

    const { url, init } = onlyCall(send);
    expect(url).toBe(WEBHOOK);
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: CONTENT, allowed_mentions: { parse: [] } }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(typeof init.body === 'string' ? JSON.parse(init.body) : null).toEqual({
      content: CONTENT,
      allowed_mentions: { parse: [] },
    });
  });

  it('posts a discordapp.com webhook to discord.com, the one host the CSP allows', async () => {
    const send = discord();

    await postWebhook(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`, CONTENT, send);

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

    const refused = postWebhook(url, CONTENT, send);

    await expect(refused).rejects.toThrow(RangeError);
    await expect(refused).rejects.not.toThrow(TOKEN);
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves false when Discord answers anything but 2xx, and reads nothing it sent back', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      const send = discord(status);
      await expect(postWebhook(WEBHOOK, CONTENT, send)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    }
    await expect(postWebhook(WEBHOOK, CONTENT, discord(200))).resolves.toBe(true);
  });

  it('rejects, once, when the network or a redirect fails the request', async () => {
    const send = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(postWebhook(WEBHOOK, CONTENT, send)).rejects.toThrow(TypeError);
    expect(send).toHaveBeenCalledTimes(1);
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

describe('the deploy CSP and the webhook (#119)', () => {
  it('lets the page connect to its own origin and to Discord’s webhook path, and nowhere else', () => {
    expect(deployCsp().get('connect-src')).toEqual(["'self'", DISCORD_WEBHOOKS]);
    expect(DISCORD_WEBHOOKS).toBe('https://discord.com/api/webhooks/');
  });

  it('posts only to URLs under that path', async () => {
    const send = discord();
    await postWebhook(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`, CONTENT, send);
    expect(onlyCall(send).url.startsWith(DISCORD_WEBHOOKS)).toBe(true);
  });
});
