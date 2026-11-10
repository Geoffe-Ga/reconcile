/**
 * The Discord webhook client (#119; ADR-0039 step 1, ADR-0074): the app's one
 * network destination besides the relay, called only for a group that turned
 * its chat bot on by Proposal (src/store/chatBot.ts).
 *
 * The webhook URL is a credential: anyone holding it can post into the
 * channel. It comes only from the group's folded state, is checked with the
 * fold's own validator before anything is sent, and is rebuilt from its id
 * and token on `discord.com`, the one host the deploy CSP's `connect-src`
 * allows ({@link DISCORD_WEBHOOKS}), so a `discordapp.com` URL posts too and
 * nothing else in it survives. No error names it.
 *
 * Discord receives the fixed text it is handed, the app's origin (a
 * cross-origin request always carries it) and the address of the device that
 * posts: no cookie, no referrer, and no mention it could ping anyone with.
 */
import { webhookParts } from '../engine/optIns';
import type { Fetch } from './relay';

/**
 * The prefix every post goes to, exactly as the deploy CSP's `connect-src`
 * names it (deploy/Caddyfile, client/vite.config.ts).
 */
export const DISCORD_WEBHOOKS = 'https://discord.com/api/webhooks/';

/** The browser's `fetch`, called unbound so it never sees a foreign `this`. */
const browserFetch: Fetch = (input, init) => fetch(input, init);

/**
 * Posts `content` into the channel `webhook` belongs to, once: a JSON body of
 * the content and `allowed_mentions: {parse: []}`, so no `@everyone` or name
 * in it pings anyone. It sends no cookie or referrer, skips the HTTP cache and
 * follows no redirect, which the CSP's path check couldn't hold.
 *
 * Resolves true when Discord answers 2xx and false for any other status,
 * reading nothing it sends back. Rejects with a `RangeError` before `fetch`
 * runs for a webhook {@link webhookParts} refuses, and with `fetch`'s own
 * error when the request fails. It never retries.
 */
export async function postWebhook(
  webhook: string,
  content: string,
  send: Fetch = browserFetch,
): Promise<boolean> {
  const parts = webhookParts(webhook);
  if (parts === null) {
    throw new RangeError('The chat bot posts only to a Discord webhook URL.');
  }
  const response = await send(`${DISCORD_WEBHOOKS}${parts.id}/${parts.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    redirect: 'error',
  });
  return response.ok;
}
