import { describe, expect, it } from 'vitest';

import { local } from '../test/bytes';
import { TEST_MAILBOX, createFakeRelay } from '../test/fakeRelay';
import { RelayError, createRelay } from './relay';
import type { Fetch } from './relay';

const mailbox = TEST_MAILBOX;

/** A 1 KiB blob whose first byte is `marker`, so tests can tell blobs apart. */
function blob(marker: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(1024);
  bytes[0] = marker;
  return bytes;
}

/** A fetch that answers every request with `body` as JSON and `status`. */
function answering(body: unknown, status = 200): Fetch {
  return () => Promise.resolve(Response.json(body, { status }));
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('putBlob', () => {
  it('PUTs the raw blob as application/octet-stream and returns its seq', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });

    const seq = await relay.putBlob(mailbox, blob(7), 30);

    expect(seq).toBe(1);
    expect(fake.requests).toEqual([
      {
        method: 'PUT',
        url: `/v1/mailbox/${mailbox}?ttl_days=30`,
        contentType: 'application/octet-stream',
        body: blob(7),
      },
    ]);
  });

  it('leaves ttl_days to the relay when none is given', async () => {
    const fake = createFakeRelay();

    await createRelay({ fetch: fake.fetch }).putBlob(mailbox, blob(1));

    expect(fake.requests[0]?.url).toBe(`/v1/mailbox/${mailbox}`);
  });

  it('asks the relay to wake the mailbox with wake=1 only when told to (#99)', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });

    await relay.putBlob(mailbox, blob(1), 30, { wake: true });
    await relay.putBlob(mailbox, blob(2), 30, { wake: false });
    await relay.putBlob(mailbox, blob(3), undefined, { wake: true });

    expect(fake.requests.map((request) => request.url)).toEqual([
      `/v1/mailbox/${mailbox}?ttl_days=30&wake=1`,
      `/v1/mailbox/${mailbox}?ttl_days=30`,
      `/v1/mailbox/${mailbox}?wake=1`,
    ]);
  });

  it('turns a refusal into a RelayError carrying the status and code', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });

    const error = await rejection(relay.putBlob(mailbox, new Uint8Array(1000)));

    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_size' });
  });

  it('refuses a PUT answer without a whole-number seq', async () => {
    const relay = createRelay({ fetch: answering({ seq: 'one' }, 201) });

    const error = await rejection(relay.putBlob(mailbox, blob(1)));

    expect(error).toMatchObject({ status: 201, code: 'bad_response' });
  });
});

describe('getBlobs', () => {
  it('returns the decoded records after a seq, with the relay time and instance', async () => {
    const fake = createFakeRelay({ minute: 29_000_000 });
    const relay = createRelay({ fetch: fake.fetch });
    await relay.putBlob(mailbox, blob(1));
    fake.minute += 2;
    await relay.putBlob(mailbox, blob(2));

    const page = await relay.getBlobs(mailbox, 1);

    expect(page.now).toBe(29_000_002);
    expect(page.instance).toBe(fake.instance);
    expect(page.records.map((record) => ({ ...record, data: local(record.data) }))).toEqual([
      { seq: 2, received: 29_000_002, data: blob(2) },
    ]);
  });

  it('pages 100 records at a time until a page comes back short', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    for (let i = 0; i < 250; i += 1) {
      await relay.putBlob(mailbox, blob(i % 256));
    }
    fake.requests.length = 0;

    const page = await relay.getBlobs(mailbox, 0);

    expect(page.records.map((record) => record.seq)).toEqual(
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
    expect(fake.requests.map((request) => request.url)).toEqual([
      `/v1/mailbox/${mailbox}?after=0&limit=100`,
      `/v1/mailbox/${mailbox}?after=100&limit=100`,
      `/v1/mailbox/${mailbox}?after=200&limit=100`,
    ]);
  });

  it('asks once more after a full last page, and stops at the empty one', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    for (let i = 0; i < 100; i += 1) {
      await relay.putBlob(mailbox, blob(1));
    }
    fake.requests.length = 0;

    const page = await relay.getBlobs(mailbox, 0);

    expect(page.records).toHaveLength(100);
    expect(fake.requests).toHaveLength(2);
  });

  it('keeps only its own mailbox, even though seqs are shared across mailboxes', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const other = 'Z'.repeat(43);
    await relay.putBlob(other, blob(1));
    await relay.putBlob(mailbox, blob(2));

    const page = await relay.getBlobs(mailbox, 0);

    expect(page.records.map((record) => record.seq)).toEqual([2]);
  });

  it('refuses pages from two relay instances', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    for (let i = 0; i < 100; i += 1) {
      await relay.putBlob(mailbox, blob(1));
    }
    const restartAfterFirstPage: Fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      fake.restart({ keep: true });
      return response;
    };

    const error = await rejection(
      createRelay({ fetch: restartAfterFirstPage }).getBlobs(mailbox, 0),
    );

    expect(error).toMatchObject({ code: 'instance_changed' });
  });

  it.each([
    ['a body that is not an object', [1, 2]],
    ['records that are not a list', { records: {}, now: 1, instance: 'i' }],
    ['a missing now', { records: [], instance: 'i' }],
    ['a fractional now', { records: [], now: 1.5, instance: 'i' }],
    ['a missing instance', { records: [], now: 1 }],
    ['a record that is not an object', { records: [7], now: 1, instance: 'i' }],
    ['a record without data', { records: [{ seq: 1, received: 1 }], now: 1, instance: 'i' }],
    [
      'a record whose data is not base64',
      { records: [{ seq: 1, received: 1, data: '!!' }], now: 1, instance: 'i' },
    ],
    [
      'a record at or before the cursor',
      { records: [{ seq: 5, received: 1, data: '' }], now: 1, instance: 'i' },
    ],
    [
      'records out of order',
      {
        records: [
          { seq: 7, received: 1, data: '' },
          { seq: 6, received: 1, data: '' },
        ],
        now: 1,
        instance: 'i',
      },
    ],
  ])('refuses %s', async (_name, body) => {
    const relay = createRelay({ fetch: answering(body) });

    const error = await rejection(relay.getBlobs(mailbox, 5));

    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('refuses an answer that is not JSON', async () => {
    const relay = createRelay({ fetch: () => Promise.resolve(new Response('<html>')) });

    const error = await rejection(relay.getBlobs(mailbox, 0));

    expect(error).toMatchObject({ code: 'bad_response' });
  });
});

describe('every request', () => {
  it('goes to /v1 on the same origin by default, or to the base it is given', async () => {
    const fake = createFakeRelay();

    await createRelay({ fetch: fake.fetch }).getBlobs(mailbox, 0);
    await createRelay({ fetch: fake.fetch, baseUrl: 'http://127.0.0.1:8787/v1' }).getBlobs(
      mailbox,
      0,
    );

    expect(fake.requests.map((request) => request.url)).toEqual([
      `/v1/mailbox/${mailbox}?after=0&limit=100`,
      `http://127.0.0.1:8787/v1/mailbox/${mailbox}?after=0&limit=100`,
    ]);
  });

  it('omits credentials and the referrer, and bypasses the HTTP cache', async () => {
    const fake = createFakeRelay();
    const seen: (RequestInit | undefined)[] = [];
    const spy: Fetch = (input, init) => {
      seen.push(init);
      return fake.fetch(input, init);
    };
    const relay = createRelay({ fetch: spy });

    await relay.putBlob(mailbox, blob(1));
    await relay.getBlobs(mailbox, 0);

    expect(seen).toHaveLength(2);
    for (const init of seen) {
      expect(init).toMatchObject({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    }
  });

  it('refuses a mailbox id that is not 43 base64url characters, sending nothing', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });

    const errors = await Promise.all([
      rejection(relay.putBlob('../health', blob(1))),
      rejection(relay.getBlobs(`${mailbox}x`, 0)),
    ]);

    expect(errors.every((error) => error instanceof RangeError)).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it('passes a network failure on as a rejection', async () => {
    const fake = createFakeRelay();
    fake.offline = true;

    const error = await rejection(createRelay({ fetch: fake.fetch }).getBlobs(mailbox, 0));

    expect(error).toBeInstanceOf(TypeError);
  });

  it('names an error with no code in its body by its status', async () => {
    const relay = createRelay({ fetch: () => Promise.resolve(new Response('', { status: 502 })) });

    const error = await rejection(relay.getBlobs(mailbox, 0));

    expect(error).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('never echoes the mailbox id in an error message', async () => {
    const relay = createRelay({ fetch: answering({ error: 'storage_full' }, 507) });

    const error = await rejection(relay.putBlob(mailbox, blob(1)));

    expect(error).toMatchObject({ status: 507, code: 'storage_full' });
    expect(String(error)).not.toContain(mailbox);
  });
});
