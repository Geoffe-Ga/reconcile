import { describe, expect, it } from 'vitest';

import { TEST_MAILBOX, TEST_PUSH_KEY, createFakeRelay } from './fakeRelay';

const mailbox = TEST_MAILBOX;
const octets = { 'Content-Type': 'application/octet-stream' };

describe('the fake relay keeps #62’s contract', () => {
  it.each([
    ['an unknown path', `/v1/nothing`, { method: 'GET' }, 404, 'not_found'],
    ['another method', `/v1/mailbox/${mailbox}`, { method: 'DELETE' }, 405, 'method_not_allowed'],
    ['a short mailbox id', `/v1/mailbox/abc`, { method: 'GET' }, 400, 'invalid_mailbox'],
    ['a bad after', `/v1/mailbox/${mailbox}?after=-1`, { method: 'GET' }, 400, 'invalid_after'],
    ['a zero limit', `/v1/mailbox/${mailbox}?limit=0`, { method: 'GET' }, 400, 'invalid_limit'],
    ['a long limit', `/v1/mailbox/${mailbox}?limit=101`, { method: 'GET' }, 400, 'invalid_limit'],
    [
      'a ttl over 30 days',
      `/v1/mailbox/${mailbox}?ttl_days=31`,
      { method: 'PUT', headers: octets, body: new Uint8Array(1024) },
      400,
      'invalid_ttl',
    ],
    [
      'a PUT without a content type',
      `/v1/mailbox/${mailbox}`,
      { method: 'PUT', body: new Uint8Array(1024) },
      415,
      'unsupported_media_type',
    ],
    [
      'a blob over 64 KiB',
      `/v1/mailbox/${mailbox}`,
      { method: 'PUT', headers: octets, body: new Uint8Array(65537) },
      413,
      'too_large',
    ],
    [
      'a blob of no padded size',
      `/v1/mailbox/${mailbox}`,
      { method: 'PUT', headers: octets },
      400,
      'invalid_size',
    ],
  ])('refuses %s', async (_name, url, init, status, code) => {
    const fake = createFakeRelay();

    const response = await fake.fetch(url, init);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(fake.blobs(mailbox)).toEqual([]);
  });

  it('answers health', async () => {
    const response = await createFakeRelay().fetch('/v1/health');

    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('stamps each blob with the relay minute and returns it as base64', async () => {
    const fake = createFakeRelay({ minute: 100 });
    await fake.fetch(new URL(`http://relay.test/v1/mailbox/${mailbox}`), {
      method: 'PUT',
      headers: { 'content-type': 'Application/Octet-Stream; charset=binary' },
      body: new Uint8Array(1024).fill(255),
    });
    fake.minute = 105;

    const response = await fake.fetch(`/v1/mailbox/${mailbox}`);

    expect(await response.json()).toEqual({
      records: [{ seq: 1, received: 100, data: btoa('\xff'.repeat(1024)) }],
      now: 105,
      instance: fake.instance,
    });
  });

  it('restarts empty with a new instance, or keeps its blobs when asked', async () => {
    const fake = createFakeRelay();
    await fake.fetch(`/v1/mailbox/${mailbox}`, {
      method: 'PUT',
      headers: octets,
      body: new Uint8Array(1024),
    });
    const first = fake.instance;

    fake.restart({ keep: true });
    const kept = fake.blobs(mailbox).length;
    fake.restart();
    const response = await fake.fetch(`/v1/mailbox/${mailbox}`, {
      method: 'PUT',
      headers: octets,
      body: new Uint8Array(1024),
    });

    expect(kept).toBe(1);
    expect(fake.blobs(mailbox)).toHaveLength(1);
    expect(await response.json()).toEqual({ seq: 1 });
    expect(fake.instance).not.toBe(first);
    expect(fake.instance).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('keeps a blob through the UTC day after its ttl, as the relay rounds up, and not a day more', async () => {
    // Minute 1,440 × 20,000 starts a UTC day; the blob arrives an hour into it.
    const day = 1440 * 20_000;
    const fake = createFakeRelay({ minute: day + 60 });
    const put = (ttl: number) =>
      fake.fetch(`/v1/mailbox/${mailbox}?ttl_days=${String(ttl)}`, {
        method: 'PUT',
        headers: octets,
        body: new Uint8Array(1024),
      });
    await put(1);
    await put(30);

    fake.minute = day + 2 * 1440 - 1;
    expect(fake.blobs(mailbox)).toHaveLength(2);
    fake.minute = day + 2 * 1440;
    expect(fake.blobs(mailbox)).toHaveLength(1);
    const response = await fake.fetch(`/v1/mailbox/${mailbox}`);
    expect((await response.json()) as { records: { seq: number }[] }).toMatchObject({
      records: [{ seq: 2 }],
    });
  });

  it('drops a mailbox’s oldest blobs, as a purge would', async () => {
    const fake = createFakeRelay();
    for (const fill of [1, 2, 3]) {
      await fake.fetch(`/v1/mailbox/${mailbox}`, {
        method: 'PUT',
        headers: octets,
        body: new Uint8Array(1024).fill(fill),
      });
    }

    fake.drop(mailbox, 2);

    expect(fake.blobs(mailbox).map((blob) => blob[0])).toEqual([3]);
  });

  it('records requests as they reach it, and none while offline', async () => {
    const fake = createFakeRelay();
    fake.offline = true;

    await expect(fake.fetch('/v1/health')).rejects.toThrow(TypeError);
    expect(fake.requests).toEqual([]);
  });
});

describe('the fake relay keeps #97’s backup contract', () => {
  const backup = 'test-backup-'.padEnd(43, '2');
  const at = `/v1/backup/${backup}`;

  it.each([
    ['a short backup id', '/v1/backup/abc', { method: 'GET' }, 400, 'invalid_backup'],
    ['another method', at, { method: 'DELETE' }, 405, 'method_not_allowed'],
    [
      'no content type',
      at,
      { method: 'PUT', body: new Uint8Array(65536) },
      415,
      'unsupported_media_type',
    ],
    [
      'a backup over 16 MiB',
      at,
      { method: 'PUT', headers: octets, body: new Uint8Array(16777217) },
      413,
      'too_large',
    ],
    [
      'a mailbox blob’s size',
      at,
      { method: 'PUT', headers: octets, body: new Uint8Array(1024) },
      400,
      'invalid_size',
    ],
    ['an unknown backup', at, { method: 'GET' }, 404, 'not_found'],
  ])('refuses %s', async (_name, url, init, status, code) => {
    const fake = createFakeRelay();

    const response = await fake.fetch(url, init);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(fake.backup(backup)).toBeUndefined();
  });

  it.each([65536, 262144, 1048576, 4194304, 16777216])(
    'keeps a %i-byte backup, replaces it, and serves it as octets',
    async (size) => {
      const fake = createFakeRelay();
      const first = new Uint8Array(size).fill(1);
      const second = new Uint8Array(65536).fill(2);

      const put = await fake.fetch(at, { method: 'PUT', headers: octets, body: first });
      await fake.fetch(at, { method: 'PUT', headers: octets, body: second });
      const got = await fake.fetch(at, { method: 'GET' });

      expect(put.status).toBe(204);
      expect(got.headers.get('content-type')).toBe('application/octet-stream');
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(second);
      expect(fake.backup(backup)).toEqual(second);
    },
  );

  it('keeps a backup 180 days after the UTC day of its last write, and not a day more', async () => {
    const fake = createFakeRelay({ minute: 1440 * 20_000 + 1439 });
    await fake.fetch(at, { method: 'PUT', headers: octets, body: new Uint8Array(65536) });

    fake.minute = 1440 * 20_181 - 1;
    const kept = await fake.fetch(at, { method: 'GET' });
    fake.minute = 1440 * 20_181;
    const gone = await fake.fetch(at, { method: 'GET' });

    expect(kept.status).toBe(200);
    expect(gone.status).toBe(404);
    expect(fake.backup(backup)).toBeUndefined();
  });

  it('keeps backups out of every mailbox', async () => {
    const fake = createFakeRelay();

    await fake.fetch(`/v1/backup/${mailbox}`, {
      method: 'PUT',
      headers: octets,
      body: new Uint8Array(65536),
    });

    expect(fake.blobs(mailbox)).toEqual([]);
  });
});

describe('the fake relay keeps #89’s push routes (#99)', () => {
  const json = { 'Content-Type': 'application/json' };
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
  const send = (fake: ReturnType<typeof createFakeRelay>, method: string, body: string) =>
    fake.fetch(`/v1/push/${mailbox}`, { method, headers: json, body });

  it('serves its key, and answers every push route push_unavailable once push is off', async () => {
    const fake = createFakeRelay();
    expect(await (await fake.fetch('/v1/push/key')).json()).toEqual({
      vapid_public_key: TEST_PUSH_KEY,
    });
    expect(TEST_PUSH_KEY).toMatch(/^[A-Za-z0-9_-]{87}$/);

    fake.pushKey = null;
    for (const response of [
      await fake.fetch('/v1/push/key'),
      await send(fake, 'PUT', JSON.stringify({ endpoint: ENDPOINT })),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'push_unavailable' });
    }
    expect(fake.endpoints(mailbox)).toEqual([]);
  });

  it('registers an endpoint once, forgets it, and refuses one off the push services', async () => {
    const fake = createFakeRelay();

    expect((await send(fake, 'PUT', JSON.stringify({ endpoint: ENDPOINT }))).status).toBe(204);
    await send(fake, 'PUT', JSON.stringify({ endpoint: ENDPOINT }));
    expect(fake.endpoints(mailbox)).toEqual([ENDPOINT]);
    const elsewhere = await send(fake, 'PUT', JSON.stringify({ endpoint: 'https://evil.test/x' }));
    expect(elsewhere.status).toBe(422);
    expect(await elsewhere.json()).toEqual({ error: 'push_endpoint_rejected' });
    expect((await send(fake, 'DELETE', JSON.stringify({ endpoint: ENDPOINT }))).status).toBe(204);
    expect(fake.endpoints(mailbox)).toEqual([]);
  });

  it.each([
    ['another key', JSON.stringify({ url: ENDPOINT })],
    ['a second key', JSON.stringify({ endpoint: ENDPOINT, group: 'Riverside' })],
    ['a number', JSON.stringify({ endpoint: 7 })],
    ['no JSON', 'endpoint'],
    ['an array', JSON.stringify([ENDPOINT])],
  ])('refuses a body with %s', async (_name, body) => {
    const fake = createFakeRelay();

    const response = await send(fake, 'PUT', body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses a body that isn’t JSON, or is over 2,048 bytes', async () => {
    const fake = createFakeRelay();
    const plain = await fake.fetch(`/v1/push/${mailbox}`, {
      method: 'PUT',
      body: JSON.stringify({ endpoint: ENDPOINT }),
    });
    const long = await send(
      fake,
      'PUT',
      JSON.stringify({ endpoint: `${ENDPOINT}${'x'.repeat(2048)}` }),
    );

    expect(plain.status).toBe(415);
    expect(long.status).toBe(413);
  });

  it('keeps each nudge as asked, up to 30 days ahead and 50 a mailbox', async () => {
    const fake = createFakeRelay({ minute: 1000 });
    const nudge = (minute: number) =>
      fake.fetch(`/v1/push/${mailbox}/nudge`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ not_before: minute }),
      });

    expect((await nudge(900)).status).toBe(204);
    expect((await nudge(1000 + 43_200)).status).toBe(204);
    expect(await (await nudge(1000 + 43_201)).json()).toEqual({ error: 'invalid_not_before' });
    expect((await nudge(-1)).status).toBe(400);
    expect(fake.nudges(mailbox)).toEqual([900, 44_200]);
    for (let i = 0; i < 48; i += 1) await nudge(2000 + i);
    expect(await (await nudge(5000)).json()).toEqual({ error: 'too_many_nudges' });
    expect((await fake.fetch(`/v1/push/${mailbox}/nudge`, { method: 'GET' })).status).toBe(405);
    expect((await fake.fetch('/v1/push/abc')).status).toBe(400);
    expect((await fake.fetch('/v1/push/a/b/c')).status).toBe(404);
  });

  it('takes wake=1 on a blob PUT, refuses any other wake, and records a keepalive request', async () => {
    const fake = createFakeRelay();
    const put = (query: string, keepalive = false) =>
      fake.fetch(`/v1/mailbox/${mailbox}${query}`, {
        method: 'PUT',
        headers: octets,
        body: new Uint8Array(1024),
        keepalive,
      });

    expect((await put('?wake=1')).status).toBe(201);
    expect(await (await put('?wake=yes')).json()).toEqual({ error: 'invalid_wake' });
    await put('', true);
    expect(fake.requests.map((request) => request.keepalive)).toEqual([undefined, undefined, true]);
  });

  it('forgets every endpoint and nudge on a fresh start', async () => {
    const fake = createFakeRelay();
    await send(fake, 'PUT', JSON.stringify({ endpoint: ENDPOINT }));

    fake.restart();

    expect(fake.endpoints(mailbox)).toEqual([]);
  });
});
