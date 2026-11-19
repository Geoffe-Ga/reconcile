import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { signShelfBody } from '../shelf/record';
import { createFakeShelf, release } from '../test/fakeShelf';
import { STEWARD_ADDRESS } from '../test/steward';
import { type Fetch, RelayError } from './relay';
import { createShelf } from './shelf';

const keys = newSigningKeys();
const ADDRESS = base64url(keys.publicKey);
const ID = base64url(new Uint8Array(32).fill(3));
const WITHDRAW = signShelfBody(keys, { v: 1, kind: 'withdraw', id: ID });
const COVENANT = base64url(new Uint8Array(32).fill(9));

/** An open listing signed by `signer`: a record any shelf takes without another before it (#431). */
const listingBy = (signer = keys) =>
  signShelfBody(signer, {
    v: 1,
    kind: 'listing',
    open: true,
    name: 'Oak',
    skeleton: 'oak',
    covenant: COVENANT,
  });
const LISTING = listingBy();

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

describe('put', () => {
  it('PUTs the signed record under its address and returns its seq', async () => {
    const fake = createFakeShelf();
    const seq = await createShelf({ fetch: fake.fetch }).put(ADDRESS, LISTING);

    expect(seq).toBe(1);
    expect(fake.urls).toEqual([`/v1/shelf/${ADDRESS}`]);
    expect(Array.from(fake.records[0]?.data ?? [])).toEqual(Array.from(LISTING));
  });

  it('sends it as an octet stream with no cookies, referrer or cache', async () => {
    const seen: RequestInit[] = [];
    const fetch: Fetch = (_url, init) => {
      seen.push(init ?? {});
      return Promise.resolve(Response.json({ seq: 4 }, { status: 201 }));
    };
    await createShelf({ fetch }).put(ADDRESS, WITHDRAW);

    expect(seen[0]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });

  it('refuses an address that could rewrite the URL, before any request', async () => {
    const fake = createFakeShelf();
    const shelf = createShelf({ fetch: fake.fetch });

    await expect(shelf.put('../mailbox/x', WITHDRAW)).rejects.toThrow(RangeError);
    expect(fake.urls).toEqual([]);
  });

  it('rejects with the relay’s code, or bad_response for a 2xx without a seq', async () => {
    const forged = await rejection(
      createShelf({ fetch: answering({ error: 'bad_signature' }, 403) }).put(ADDRESS, WITHDRAW),
    );
    const odd = await rejection(createShelf({ fetch: answering({}, 201) }).put(ADDRESS, WITHDRAW));

    expect(forged).toEqual(new RelayError(403, 'bad_signature'));
    expect(odd).toEqual(new RelayError(201, 'bad_response'));
  });
});

describe('read', () => {
  it('reads every record in seq order, with its address and bytes', async () => {
    const fake = createFakeShelf({ minute: 500 });
    const shelf = createShelf({ fetch: fake.fetch });
    await shelf.put(ADDRESS, LISTING);
    await release(fake, ADDRESS);

    const page = await shelf.read();

    expect(page?.now).toBe(500);
    expect(page?.instance).toBe('fake-shelf-instance');
    expect(page?.records.map(({ seq, received, address }) => ({ seq, received, address }))).toEqual(
      [
        { seq: 1, received: 500, address: ADDRESS },
        { seq: 2, received: 500, address: STEWARD_ADDRESS },
      ],
    );
    expect(Array.from(page?.records[0]?.data ?? [])).toEqual(Array.from(LISTING));
    expect(fake.urls.at(-1)).toBe('/v1/shelf?after=0&limit=100');
  });

  it('reads the held records alone from their own route, for the steward’s console (#488)', async () => {
    const fake = createFakeShelf({ minute: 500 });
    const shelf = createShelf({ fetch: fake.fetch });
    await shelf.put(ADDRESS, LISTING);

    expect((await shelf.read())?.records).toEqual([]);
    const held = await shelf.readHeld();

    expect(held?.records.map(({ seq, address }) => ({ seq, address }))).toEqual([
      { seq: 1, address: ADDRESS },
    ]);
    expect(fake.urls.at(-1)).toBe('/v1/shelf/held?after=0&limit=100');
  });

  it('reads no held records while the relay has no shelf', async () => {
    const fake = createFakeShelf({ available: false });

    expect(await createShelf({ fetch: fake.fetch }).readHeld()).toBeNull();
  });

  it('pages 100 at a time until a page comes back short', async () => {
    const fake = createFakeShelf();
    const shelf = createShelf({ fetch: fake.fetch });
    for (let i = 0; i < 201; i += 1) {
      const door = newSigningKeys();
      await shelf.put(base64url(door.publicKey), listingBy(door));
    }

    const page = await shelf.readHeld();

    expect(page?.records.map((record) => record.seq)).toEqual(
      Array.from({ length: 201 }, (_, i) => i + 1),
    );
    expect(fake.urls.slice(-3)).toEqual([
      '/v1/shelf/held?after=0&limit=100',
      '/v1/shelf/held?after=100&limit=100',
      '/v1/shelf/held?after=200&limit=100',
    ]);
  });

  it('is null while the relay has no shelf: its 404 shelf_unavailable', async () => {
    const fake = createFakeShelf({ available: false });

    expect(await createShelf({ fetch: fake.fetch }).read()).toBeNull();
  });

  it('rejects any other refusal, a 404 included', async () => {
    const error = await rejection(
      createShelf({ fetch: answering({ error: 'not_found' }, 404) }).read(),
    );

    expect(error).toEqual(new RelayError(404, 'not_found'));
  });

  it('rejects a fresh relay met between pages', async () => {
    let call = 0;
    const record = { seq: 1, received: 1, address: ADDRESS, data: 'AA==' };
    const fetch: Fetch = () => {
      call += 1;
      const records = Array.from({ length: call === 1 ? 100 : 1 }, (_, i) => ({
        ...record,
        seq: i + 1 + (call - 1) * 100,
      }));
      return Promise.resolve(Response.json({ records, now: 1, instance: `i${String(call)}` }));
    };

    expect(await rejection(createShelf({ fetch }).read())).toEqual(
      new RelayError(200, 'instance_changed'),
    );
  });

  it.each([
    ['no records', { now: 1, instance: 'i' }],
    ['no now', { records: [], instance: 'i' }],
    ['no instance', { records: [], now: 1 }],
    [
      'a record with no address',
      { records: [{ seq: 1, received: 1, data: 'AA==' }], now: 1, instance: 'i' },
    ],
    [
      'a record with a bad address',
      { records: [{ seq: 1, received: 1, address: 'x', data: 'AA==' }], now: 1, instance: 'i' },
    ],
    [
      'a record whose data isn’t base64',
      { records: [{ seq: 1, received: 1, address: ADDRESS, data: '!' }], now: 1, instance: 'i' },
    ],
    [
      'a record with no seq',
      { records: [{ received: 1, address: ADDRESS, data: 'AA==' }], now: 1, instance: 'i' },
    ],
    [
      'records out of order',
      {
        records: [
          { seq: 2, received: 1, address: ADDRESS, data: 'AA==' },
          { seq: 2, received: 1, address: ADDRESS, data: 'AA==' },
        ],
        now: 1,
        instance: 'i',
      },
    ],
    ['records that aren’t a list', { records: {}, now: 1, instance: 'i' }],
    ['a list', []],
  ])('rejects an answer with %s', async (_name, body) => {
    expect(await rejection(createShelf({ fetch: answering(body) }).read())).toEqual(
      new RelayError(200, 'bad_response'),
    );
  });
});
