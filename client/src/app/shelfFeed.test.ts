/**
 * The shelf as Discover reads it (#484): read from the relay at most once an
 * hour, folded, and null while the relay has no shelf.
 */
import { describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf, type ShelfPage } from '../net/shelf';
import { signShelfBody } from '../shelf/record';
import { createFakeShelf } from '../test/fakeShelf';
import { createShelfFeed, SHELF_READ_MS } from './shelfFeed';

const door = newSigningKeys();
const ADDRESS = base64url(door.publicKey);
const COVENANT = base64url(new Uint8Array(32).fill(9));
const ID = base64url(new Uint8Array(32).fill(1));

/** A fake shelf holding Oak St Tenants' listing and one entry. */
async function stocked() {
  const fake = createFakeShelf();
  const shelf = createShelf({ fetch: fake.fetch });
  await shelf.put(
    ADDRESS,
    signShelfBody(door, {
      v: 1,
      kind: 'listing',
      open: true,
      name: 'Oak St Tenants',
      skeleton: 'oaksttenants',
      covenant: COVENANT,
    }),
  );
  await shelf.put(
    ADDRESS,
    signShelfBody(door, { v: 1, kind: 'entry', id: ID, title: 'Rent strike vote', text: '' }),
  );
  return { fake, shelf };
}

describe('createShelfFeed', () => {
  it('folds what the relay serves', async () => {
    const { shelf } = await stocked();
    const state = await createShelfFeed({ shelf, now: () => 0 }).current();

    expect(state?.entries.map(({ name, title }) => ({ name, title }))).toEqual([
      { name: 'Oak St Tenants', title: 'Rent strike vote' },
    ]);
  });

  it('is null while the relay has no shelf', async () => {
    const fake = createFakeShelf({ available: false });
    const feed = createShelfFeed({ shelf: createShelf({ fetch: fake.fetch }), now: () => 0 });

    expect(await feed.current()).toBeNull();
  });

  it('reads the relay at most once an hour', async () => {
    const { fake, shelf } = await stocked();
    let clock = 1_000_000;
    const feed = createShelfFeed({ shelf, now: () => clock });
    const before = fake.urls.length;

    await feed.current();
    clock += SHELF_READ_MS - 1;
    await feed.current();
    expect(fake.urls.length - before).toBe(1);

    clock += 1;
    await feed.current();
    expect(fake.urls.length - before).toBe(2);
    expect(SHELF_READ_MS).toBe(60 * 60 * 1000);
  });

  it('keeps no failed read, so the next visit asks again', async () => {
    const page: ShelfPage = { records: [], now: 5, instance: 'i' };
    const read = vi
      .fn<() => Promise<ShelfPage | null>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page);
    const feed = createShelfFeed({ shelf: { read }, now: () => 0 });

    await expect(feed.current()).rejects.toThrow('offline');
    expect(await feed.current()).toEqual({
      listings: [],
      entries: [],
      tombstones: [],
      paused: false,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
