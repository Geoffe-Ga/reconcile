/**
 * The steward's import and console (#488; listed-doors.md §6.2, §6.4),
 * against the fake shelf's held mode and the tests' pinned steward key.
 */
import { describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { createShelf } from '../net/shelf';
import { signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { VaultLocked } from '../store/db';
import { createFakeShelf, release } from '../test/fakeShelf';
import { STEWARD_ADDRESS, TEST_PINS, TEST_STEWARD_SECRET } from '../test/steward';
import { derivesPins, importStewardKey, readQueue, releaseListing, sendNotice } from './steward';

const COVENANT = base64url(new Uint8Array(32).fill(9));

/** An open listing under `name`, signed by `door`. */
const listingBy = (door: ReturnType<typeof newSigningKeys>, name: string) =>
  signShelfBody(door, {
    v: 1,
    kind: 'listing',
    open: true,
    name,
    skeleton: nameSkeleton(name),
    covenant: COVENANT,
  });

/** A store that keeps one secret, and hands a copy back. */
function keyStore(kept?: Uint8Array) {
  const store = {
    secret: kept,
    keepStewardKey: vi.fn((secret: Uint8Array) => {
      store.secret = Uint8Array.from(secret);
      return Promise.resolve();
    }),
    getStewardKey: () => Promise.resolve(store.secret && Uint8Array.from(store.secret)),
  };
  return store;
}

describe('derivesPins', () => {
  it('is true only for the secret whose two keys are pinned', () => {
    expect(derivesPins(TEST_STEWARD_SECRET)).toBe(true);
    expect(derivesPins(new Uint8Array(32).fill(1))).toBe(false);
    expect(derivesPins(TEST_STEWARD_SECRET, { ...TEST_PINS, box: TEST_PINS.sign })).toBe(false);
  });

  it('is false for every secret while the app pins none', () => {
    expect(derivesPins(TEST_STEWARD_SECRET, null)).toBe(false);
  });

  it('leaves the secret it was given as it was', () => {
    const secret = Uint8Array.from(TEST_STEWARD_SECRET);
    derivesPins(secret);
    expect(Array.from(secret)).toEqual(Array.from(TEST_STEWARD_SECRET));
  });
});

describe('importStewardKey', () => {
  it('keeps the pinned steward’s secret, read from the text the script printed', async () => {
    const store = keyStore();

    expect(await importStewardKey(store, ` ${base64url(TEST_STEWARD_SECRET)}\n`, 42)).toBe(
      'imported',
    );
    expect(store.keepStewardKey).toHaveBeenCalledWith(expect.any(Uint8Array), 42);
    expect(Array.from(store.secret ?? [])).toEqual(Array.from(TEST_STEWARD_SECRET));
  });

  it('keeps nothing that isn’t the pinned steward’s secret', async () => {
    const store = keyStore();

    expect(await importStewardKey(store, base64url(new Uint8Array(32).fill(1)), 42)).toBe('wrong');
    expect(await importStewardKey(store, 'not a key', 42)).toBe('wrong');
    expect(store.keepStewardKey).not.toHaveBeenCalled();
  });

  it('says a locked device must unlock first, and any other refusal failed', async () => {
    const text = base64url(TEST_STEWARD_SECRET);
    const locked = { keepStewardKey: () => Promise.reject(new VaultLocked()) };
    const broken = { keepStewardKey: () => Promise.reject(new Error('quota')) };

    expect(await importStewardKey(locked, text, 42)).toBe('locked');
    expect(await importStewardKey(broken, text, 42)).toBe('failed');
  });
});

describe('readQueue and sendNotice (#489)', () => {
  it('lists what stands, entries at once; holds one with its lapse; and leaves a held listing out of the waiting', async () => {
    const fake = createFakeShelf();
    const shelf = createShelf({ fetch: fake.fetch });
    const oak = newSigningKeys();
    const address = base64url(oak.publicKey);
    await shelf.put(address, listingBy(oak, 'Oak St Tenants'));
    await release(shelf, address);
    const id = base64url(new Uint8Array(32).fill(4));
    await shelf.put(
      address,
      signShelfBody(oak, { v: 1, kind: 'entry', id, title: 'Rent', text: '' }),
    );
    const store = keyStore(TEST_STEWARD_SECRET);

    const before = await readQueue(shelf);
    expect(typeof before === 'string' ? null : before.entries.map((e) => e.title)).toEqual([
      'Rent',
    ]);
    expect(typeof before === 'string' ? null : before.listings.map((l) => l.name)).toEqual([
      'Oak St Tenants',
    ]);
    const hold = { v: 1, kind: 'notice', act: 'hold', address, clause: 'C3' } as const;
    expect(await sendNotice(store, shelf, hold)).toBe(true);
    expect(await sendNotice(store, shelf, { v: 1, kind: 'notice', act: 'pause', on: true })).toBe(
      true,
    );

    const after = await readQueue(shelf);
    if (typeof after === 'string') throw new Error('a view');
    expect(after.waiting).toEqual([]);
    expect(after.listings).toEqual([]);
    expect(after.paused).toBe(true);
    expect(after.holds).toMatchObject([
      {
        hold: {
          address,
          id: null,
          clause: 'C3',
          until: fake.minute + 10_080,
        },
        name: 'Oak St Tenants',
        title: null,
      },
    ]);
  });
});

describe('readQueue and releaseListing', () => {
  it('lists each held listing beside the live one holding its name, and releases it', async () => {
    const fake = createFakeShelf();
    const shelf = createShelf({ fetch: fake.fetch });
    const birch = newSigningKeys();
    const oak = newSigningKeys();
    await shelf.put(base64url(birch.publicKey), listingBy(birch, 'Eastside Tenants Union'));
    await release(shelf, base64url(birch.publicKey));
    await shelf.put(base64url(oak.publicKey), listingBy(oak, 'EASTSIDE TENANTS UNI0N'));

    const queue = await readQueue(shelf);

    const waiting = typeof queue === 'string' ? [] : queue.waiting;
    expect(waiting.map((w) => [w.listing.name, w.holder?.name])).toEqual([
      ['EASTSIDE TENANTS UNI0N', 'Eastside Tenants Union'],
    ]);
    expect(
      await releaseListing(keyStore(TEST_STEWARD_SECRET), shelf, base64url(oak.publicKey)),
    ).toBe(true);
    expect(await readQueue(shelf)).toEqual(
      expect.objectContaining({ waiting: [], holds: [], paused: false }),
    );
    expect(fake.records.at(-1)?.address).toBe(STEWARD_ADDRESS);
  });

  it('reads unavailable while the relay has no shelf, and failed when a read fails', async () => {
    const off = createShelf({ fetch: createFakeShelf({ available: false }).fetch });
    const broken = {
      read: () => Promise.reject(new Error('offline')),
      readHeld: () => off.readHeld(),
    };

    expect(await readQueue(off)).toBe('unavailable');
    expect(await readQueue(broken)).toBe('failed');
  });

  it('releases nothing without a key that derives the pins, or when the relay refuses it', async () => {
    const fake = createFakeShelf();
    const shelf = createShelf({ fetch: fake.fetch });
    const address = base64url(newSigningKeys().publicKey);
    const refusing = { put: () => Promise.reject(new Error('offline')) };
    const locked = { getStewardKey: () => Promise.reject(new VaultLocked()) };

    expect(await releaseListing(keyStore(), shelf, address)).toBe(false);
    expect(await releaseListing(locked, shelf, address)).toBe(false);
    expect(await releaseListing(keyStore(new Uint8Array(32).fill(1)), shelf, address)).toBe(false);
    expect(await releaseListing(keyStore(TEST_STEWARD_SECRET), refusing, address)).toBe(false);
    expect(fake.records).toEqual([]);
  });
});
