import { describe, expect, it } from 'vitest';

import { TEST_MAILBOX, TEST_PUSH_KEY, createFakeRelay } from '../test/fakeRelay';
import { createPushRelay } from './push';
import type { Fetch } from './relay';

const mailbox = TEST_MAILBOX;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

/** A fetch that answers every request with `body` as JSON and `status`, keeping each request's init. */
function answering(body: unknown, status = 200) {
  const inits: RequestInit[] = [];
  const fetch: Fetch = (_input, init) => {
    inits.push(init ?? {});
    const response =
      status === 204 ? new Response(null, { status }) : Response.json(body, { status });
    return Promise.resolve(response);
  };
  return { fetch, inits };
}

/** The bodies a fake relay received, as text. */
function bodies(fake: ReturnType<typeof createFakeRelay>): (string | null)[] {
  return fake.requests.map((r) => (r.body === null ? null : new TextDecoder().decode(r.body)));
}

describe('the relay’s push routes (#89, #99)', () => {
  it('reads the relay’s VAPID key', async () => {
    const fake = createFakeRelay();

    expect(await createPushRelay({ fetch: fake.fetch }).key()).toBe(TEST_PUSH_KEY);
    expect(fake.requests).toEqual([
      { method: 'GET', url: '/v1/push/key', contentType: null, body: null },
    ]);
  });

  it('refuses a key that isn’t 87 base64url characters', async () => {
    for (const key of ['short', `${TEST_PUSH_KEY}A`, `+${TEST_PUSH_KEY.slice(1)}`, 7]) {
      const { fetch } = answering({ vapid_public_key: key });

      await expect(createPushRelay({ fetch }).key()).rejects.toMatchObject({
        status: 200,
        code: 'bad_response',
      });
    }
  });

  it('says push_unavailable when the relay has no key', async () => {
    const fake = createFakeRelay();
    fake.pushKey = null;
    const push = createPushRelay({ fetch: fake.fetch });

    await expect(push.key()).rejects.toMatchObject({ status: 404, code: 'push_unavailable' });
    await expect(push.register(mailbox, ENDPOINT)).rejects.toMatchObject({
      code: 'push_unavailable',
    });
  });

  it('registers and forgets an endpoint with a body holding only the endpoint', async () => {
    const fake = createFakeRelay();
    const push = createPushRelay({ fetch: fake.fetch });

    await push.register(mailbox, ENDPOINT);
    expect(fake.endpoints(mailbox)).toEqual([ENDPOINT]);
    await push.unregister(mailbox, ENDPOINT);

    expect(fake.endpoints(mailbox)).toEqual([]);
    expect(fake.requests.map((r) => [r.method, r.url, r.contentType])).toEqual([
      ['PUT', `/v1/push/${mailbox}`, 'application/json'],
      ['DELETE', `/v1/push/${mailbox}`, 'application/json'],
    ]);
    expect(bodies(fake)).toEqual([
      JSON.stringify({ endpoint: ENDPOINT }),
      JSON.stringify({ endpoint: ENDPOINT }),
    ]);
  });

  it('sends a Leave’s forget with keepalive, so it outlives the page', async () => {
    const fake = createFakeRelay();
    const push = createPushRelay({ fetch: fake.fetch });

    await push.unregister(mailbox, ENDPOINT, { keepalive: true });
    await push.unregister(mailbox, ENDPOINT);

    expect(fake.requests.map((r) => r.keepalive)).toEqual([true, undefined]);
  });

  it('schedules a nudge with a body holding only its relay minute', async () => {
    const fake = createFakeRelay({ minute: 29_000_000 });

    await createPushRelay({ fetch: fake.fetch }).nudge(mailbox, 29_010_080);

    expect(fake.nudges(mailbox)).toEqual([29_010_080]);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: `/v1/push/${mailbox}/nudge` });
    expect(bodies(fake)).toEqual([JSON.stringify({ not_before: 29_010_080 })]);
  });

  it('turns a refusal into a RelayError with the relay’s code, or the status without one', async () => {
    const fake = createFakeRelay();
    const push = createPushRelay({ fetch: fake.fetch });
    const { fetch } = answering('nope', 503);

    await expect(push.register(mailbox, 'https://evil.test/x')).rejects.toMatchObject({
      status: 422,
      code: 'push_endpoint_rejected',
    });
    await expect(createPushRelay({ fetch }).nudge(mailbox, 1)).rejects.toMatchObject({
      status: 503,
      code: 'http_503',
    });
  });

  it('sends what every relay request sends, and refuses a mailbox id that could rewrite the URL', async () => {
    const { fetch, inits } = answering(null, 204);
    const push = createPushRelay({ fetch, baseUrl: 'https://relay.test/v1' });

    await push.nudge(mailbox, 1);

    expect(inits[0]).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    await expect(push.register('../key', ENDPOINT)).rejects.toThrow(RangeError);
  });
});
