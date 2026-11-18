/**
 * Reading the public shelf (#484, #431; docs/spec/listed-doors.md §5.2): the
 * whole shelf, 100 records a page, at most once an hour while the app is
 * open and across reloads, kept on the device with the earliest receipt it
 * read of each address's records, for "Listed since".
 */
import { describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf, type ShelfPage, type ShelfRecord } from '../net/shelf';
import { createFakeShelf } from '../test/fakeShelf';
import { createShelfReader, type KeptShelf, SHELF_READ_MS, type ShelfKeep } from './read';
import { signShelfBody } from './record';

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

/** A device's keep for the shelf's copy, in memory. */
function memoryKeep(start?: KeptShelf): ShelfKeep & { kept: KeptShelf | undefined } {
  const keep = {
    kept: start,
    getShelfCopy: () => Promise.resolve(keep.kept),
    keepShelfCopy: (copy: KeptShelf | null) => {
      keep.kept = copy ?? undefined;
      return Promise.resolve();
    },
  };
  return keep;
}

/** A record at `address`, received at `received`, with no body worth reading. */
const at = (seq: number, address: string, received: number): ShelfRecord => ({
  seq,
  received,
  address,
  data: new Uint8Array(65),
});

describe('createShelfReader', () => {
  it('reads what the relay serves, with the relay’s minute', async () => {
    const { fake, shelf } = await stocked();
    const read = await createShelfReader({ shelf, keep: memoryKeep(), now: () => 0 }).current();

    expect(read?.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(read?.now).toBe(fake.minute);
  });

  it('is null while the relay has no shelf, and keeps nothing', async () => {
    const fake = createFakeShelf({ available: false });
    const keep = memoryKeep();
    const reader = createShelfReader({
      shelf: createShelf({ fetch: fake.fetch }),
      keep,
      now: () => 0,
    });

    expect(await reader.current()).toBeNull();
    expect(keep.kept).toBeUndefined();
  });

  it('drops the device’s copy once the relay has no shelf', async () => {
    const { shelf } = await stocked();
    const keep = memoryKeep();
    let clock = 0;
    await createShelfReader({ shelf, keep, now: () => clock }).current();
    expect(keep.kept).toBeDefined();
    clock += SHELF_READ_MS;

    const off = { read: () => Promise.resolve(null) };
    expect(await createShelfReader({ shelf: off, keep, now: () => clock }).current()).toBeNull();
    expect(keep.kept).toBeUndefined();
  });

  it('reads the relay at most once an hour', async () => {
    const { fake, shelf } = await stocked();
    let clock = 1_000_000;
    const reader = createShelfReader({ shelf, keep: memoryKeep(), now: () => clock });
    const before = fake.urls.length;

    await reader.current();
    clock += SHELF_READ_MS - 1;
    await reader.current();
    expect(fake.urls.length - before).toBe(1);

    clock += 1;
    await reader.current();
    expect(fake.urls.length - before).toBe(2);
    expect(SHELF_READ_MS).toBe(60 * 60 * 1000);
  });

  it('serves the kept copy across a reload inside the hour, without asking the relay', async () => {
    const { fake, shelf } = await stocked();
    const keep = memoryKeep();
    let clock = 1_000_000;
    const first = await createShelfReader({ shelf, keep, now: () => clock }).current();
    const before = fake.urls.length;
    clock += SHELF_READ_MS - 1;

    const reloaded = await createShelfReader({ shelf, keep, now: () => clock }).current();

    expect(fake.urls.length).toBe(before);
    expect(reloaded).toEqual(first);
  });

  it('reads again after a reload past the hour, or when the device clock went back', async () => {
    const { fake, shelf } = await stocked();
    const keep = memoryKeep();
    await createShelfReader({ shelf, keep, now: () => 1_000_000 }).current();
    const before = fake.urls.length;

    await createShelfReader({ shelf, keep, now: () => 1_000_000 + SHELF_READ_MS }).current();
    await createShelfReader({ shelf, keep, now: () => 5 }).current();

    expect(fake.urls.length - before).toBe(2);
  });

  it('keeps the earliest receipt it read of each address, for Listed since', async () => {
    const other = 'B'.repeat(43);
    const pages: ShelfPage[] = [
      { records: [at(1, ADDRESS, 900), at(2, other, 950)], now: 1000, instance: 'i' },
      { records: [at(1, ADDRESS, 5000)], now: 6000, instance: 'i' },
    ];
    const read = vi.fn(() => Promise.resolve(pages.shift() ?? null));
    const keep = memoryKeep();
    let clock = 0;
    const reader = createShelfReader({ shelf: { read }, keep, now: () => clock });

    expect((await reader.current())?.since).toEqual(
      new Map([
        [ADDRESS, 900],
        [other, 950],
      ]),
    );
    clock += SHELF_READ_MS;
    // The listing's copy was renewed: its address keeps its earliest minute, and one gone is dropped.
    expect((await reader.current())?.since).toEqual(new Map([[ADDRESS, 900]]));
  });

  it('starts Listed since over on a new relay instance', async () => {
    const keep = memoryKeep({
      instance: 'old',
      now: 1000,
      records: [],
      readAt: 0,
      since: { [ADDRESS]: 10 },
    });
    const page: ShelfPage = { records: [at(1, ADDRESS, 5000)], now: 6000, instance: 'new' };
    const reader = createShelfReader({
      shelf: { read: () => Promise.resolve(page) },
      keep,
      now: () => SHELF_READ_MS,
    });

    expect((await reader.current())?.since).toEqual(new Map([[ADDRESS, 5000]]));
  });

  it('keeps no failed read, so the next visit asks again', async () => {
    const page: ShelfPage = { records: [], now: 5, instance: 'i' };
    const read = vi
      .fn<() => Promise<ShelfPage | null>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page);
    const reader = createShelfReader({ shelf: { read }, keep: memoryKeep(), now: () => 0 });

    await expect(reader.current()).rejects.toThrow('offline');
    expect(await reader.current()).toEqual({ records: [], now: 5, since: new Map() });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('still reads when the device can’t keep its copy', async () => {
    const { shelf } = await stocked();
    const keep: ShelfKeep = {
      getShelfCopy: () => Promise.reject(new Error('blocked')),
      keepShelfCopy: () => Promise.reject(new Error('blocked')),
    };

    const read = await createShelfReader({ shelf, keep, now: () => 0 }).current();

    expect(read?.records).toHaveLength(2);
  });
});
