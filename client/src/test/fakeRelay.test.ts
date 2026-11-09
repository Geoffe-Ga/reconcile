import { describe, expect, it } from 'vitest';

import { TEST_MAILBOX, createFakeRelay } from './fakeRelay';

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

  it('records requests as they reach it, and none while offline', async () => {
    const fake = createFakeRelay();
    fake.offline = true;

    await expect(fake.fetch('/v1/health')).rejects.toThrow(TypeError);
    expect(fake.requests).toEqual([]);
  });
});
