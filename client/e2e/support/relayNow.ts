/**
 * A later relay clock for a profile, in test code alone (#127).
 *
 * A coalition's pass is final only a day after its deadline (#100, #250, #387),
 * and the real relay's clock can't move: `scripts/relay.sh` starts it with no
 * test-only route, flag or hook, and `page.clock` would close every vote
 * early. So a spec that must see a pass become final reads the relay's own
 * answers later instead: {@link readRelayLater} routes a profile's mailbox
 * GETs, and its reads of the public shelf (#434), whose entries show a relay
 * day after they arrive (#431), through Playwright, fetches each from the
 * real relay, and adds `minutes` to the `now` it answered, leaving its
 * records, their `received` minutes and every other request untouched. The
 * relay, its database and the app's code never see the difference.
 *
 * The app takes its relay week from that `now` (#110), so every profile must
 * read the same later clock, and only once nothing more needs to cross: a
 * device whose clock has moved writes to a later week's mailbox, which a
 * device still on the relay's own clock doesn't read. Move every profile at
 * once, as the last thing a spec does before it reads what time settles.
 *
 * WebKit never lets `context.route` see a request from a page under the
 * app's service worker (#123), so a spec moves its pages with `visit`, and
 * {@link LaterRelay.rewritten} counts the answers the route changed: a
 * profile whose count stays 0 never read the later clock.
 */
import { randomBytes } from 'node:crypto';

import type { APIRequestContext, Route } from '@playwright/test';

import { expect, type Person } from './fixtures';

/** The relay's own minute now: the `now` a GET of a throwaway mailbox returns (#110). */
export async function relayMinute(request: APIRequestContext): Promise<number> {
  const response = await request.get(`/v1/mailbox/${randomBytes(32).toString('base64url')}`);
  expect(response.status()).toBe(200);
  const { now } = (await response.json()) as { now: number };
  return now;
}

/** A profile reading the relay's clock later. */
export interface LaterRelay {
  /** How many mailbox and shelf GETs this profile has read with the later `now` so far. */
  rewritten(): number;
  /** Stops moving the clock, before the spec takes the profile offline or stops the relay. */
  stop(): Promise<void>;
}

/**
 * True for the relay's reads that answer its `now`, on the app's own origin:
 * a mailbox, `/v1/mailbox/{id}`, and the public shelf, `/v1/shelf` and the
 * steward's `/v1/shelf/held` (#434).
 */
function isMailbox(url: URL): boolean {
  const path = url.pathname;
  return path.startsWith('/v1/mailbox/') || path === '/v1/shelf' || path === '/v1/shelf/held';
}

/** A mailbox or shelf GET's JSON answer, `{records, now, instance}`, as the relay sends it. */
interface MailboxPage {
  readonly now: number;
}

/** True for a body shaped like a mailbox or shelf page: an object whose `now` is a whole number. */
function isMailboxPage(body: unknown): body is MailboxPage {
  return (
    typeof body === 'object' && body !== null && 'now' in body && Number.isSafeInteger(body.now)
  );
}

/**
 * From now on, `person`'s profile reads every mailbox and shelf GET's `now`
 * as `minutes` later than the relay answered it. Any other request, and any
 * answer that isn't a mailbox page, goes through as the relay sent it. A
 * request the relay doesn't answer fails in the page, as it would unrouted.
 */
export async function readRelayLater(person: Person, minutes: number): Promise<LaterRelay> {
  const context = person.page.context();
  let rewritten = 0;
  const later = async (route: Route): Promise<void> => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    try {
      const response = await route.fetch();
      const body: unknown = response.ok() ? await response.json() : null;
      if (!isMailboxPage(body)) {
        await route.fulfill({ response });
        return;
      }
      rewritten += 1;
      await route.fulfill({ response, json: { ...body, now: body.now + minutes } });
    } catch {
      // The relay stopped, or the profile closed, while the request was out.
      await route.abort('failed').catch(() => undefined);
    }
  };
  await context.route(isMailbox, later);
  return {
    rewritten: () => rewritten,
    stop: () => context.unroute(isMailbox, later),
  };
}
