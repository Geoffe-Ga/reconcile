/**
 * The steward's import and console (#488; listed-doors.md §6.2, §6.4),
 * against the fake shelf's held mode and the tests' pinned steward key.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { verifyShelfRecord } from '../crypto/shelf';
import { newSigningKeys } from '../crypto/sign';
import { createShelf } from '../net/shelf';
import { parseShelfBody, signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { VaultLocked } from '../store/db';
import { createFakeShelf, release } from '../test/fakeShelf';
import { STEWARD_ADDRESS, TEST_PINS, TEST_STEWARD_SECRET } from '../test/steward';
import { createRelay } from '../net/relay';
import type { InboxKeep, KeptInbox } from '../shelf/inbox';
import { sendReport } from '../shelf/report';
import { createFakeRelay } from '../test/fakeRelay';
import {
  derivesPins,
  dismissItem,
  importStewardKey,
  readInbox,
  readFlags,
  readQueue,
  releaseListing,
  sendNotice,
} from './steward';
import { useShelfFlags } from './useSteward';

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

/** This device's clock as a relay minute: `sendNotice` stamps each notice with its UTC day. */
const deviceMinute = (): number => Math.floor(Date.now() / 60_000);

describe('readQueue and sendNotice (#489)', () => {
  it('lists what stands, entries at once; holds one with its lapse; and leaves a held listing out of the waiting', async () => {
    const fake = createFakeShelf({ minute: deviceMinute() });
    const shelf = createShelf({ fetch: fake.fetch });
    const oak = newSigningKeys();
    const address = base64url(oak.publicKey);
    await shelf.put(address, listingBy(oak, 'Oak St Tenants'));
    await release(fake, address);
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

describe('sendNotice stamps each notice (#490’s review)', () => {
  it('signs with this device’s UTC day and a fresh nonce, so the same act sent twice is two notices', async () => {
    const fake = createFakeShelf({ minute: deviceMinute() });
    const shelf = createShelf({ fetch: fake.fetch });
    const store = keyStore(TEST_STEWARD_SECRET);
    const pause = { v: 1, kind: 'notice', act: 'pause', on: true } as const;

    expect(await sendNotice(store, shelf, pause)).toBe(true);
    expect(await sendNotice(store, shelf, pause)).toBe(true);

    const bodies = fake.records.map(({ data }) => {
      const message = verifyShelfRecord(data, STEWARD_ADDRESS);
      return message === null ? null : parseShelfBody(message);
    });
    const day = Math.floor(fake.minute / 1440);
    expect(bodies).toMatchObject([
      { act: 'pause', on: true, day },
      { act: 'pause', on: true, day },
    ]);
    const [first, second] = bodies;
    expect(first?.kind === 'notice' && second?.kind === 'notice' && first.n !== second.n).toBe(
      true,
    );
  });

  it('says false when the relay finds the notice stale: this device’s clock is days behind', async () => {
    const fake = createFakeShelf({ minute: deviceMinute() + 2 * 1440 });
    const shelf = createShelf({ fetch: fake.fetch });
    const pause = { v: 1, kind: 'notice', act: 'pause', on: true } as const;

    expect(await sendNotice(keyStore(TEST_STEWARD_SECRET), shelf, pause)).toBe(false);
    expect(fake.records).toEqual([]);
  });
});

describe('readQueue and a lifted suspension (#490)', () => {
  it('lists a suspension that stands, and once lifted, the listing posted again waits for release', async () => {
    const fake = createFakeShelf({ minute: deviceMinute(), holds: true });
    const shelf = createShelf({ fetch: fake.fetch });
    const oak = newSigningKeys();
    const address = base64url(oak.publicKey);
    await shelf.put(address, listingBy(oak, 'Oak St Tenants'));
    await release(fake, address);
    const store = keyStore(TEST_STEWARD_SECRET);
    const suspend = { v: 1, kind: 'notice', act: 'suspend', address, clause: 'C2' } as const;
    expect(await sendNotice(store, shelf, suspend)).toBe(true);

    const suspended = await readQueue(shelf);
    if (typeof suspended === 'string') throw new Error('a view');
    expect(suspended.suspended).toMatchObject([{ address, id: null, clause: 'C2' }]);

    const lift = { v: 1, kind: 'notice', act: 'unsuspend', address } as const;
    expect(await sendNotice(store, shelf, lift)).toBe(true);
    await shelf.put(address, listingBy(oak, 'Oak St Tenants'));

    const lifted = await readQueue(shelf);
    if (typeof lifted === 'string') throw new Error('a view');
    expect(lifted.suspended).toEqual([]);
    expect(lifted.waiting.map(({ listing }) => listing.address)).toEqual([address]);
    expect(await sendNotice(store, shelf, lift)).toBe(false);
  });
});

describe('dismissItem (#490)', () => {
  it('dismisses the item in the store, and says false when the store refuses', async () => {
    const kept: KeptInbox = { inbox: 'i', instance: 'r', cursor: 1, items: [] };
    const item = {
      key: 'k',
      kind: 'report',
      seq: 1,
      received: 1,
      address: 'a',
      id: null,
      clause: 'C1',
      note: null,
    } as const;
    let held: KeptInbox | undefined = { ...kept, items: [item] };
    const store: InboxKeep = {
      getStewardInbox: () => Promise.resolve(held),
      keepStewardInbox: (next) => {
        held = next ?? undefined;
        return Promise.resolve();
      },
    };

    expect(await dismissItem(store, 'k')).toBe(true);
    expect((await store.getStewardInbox())?.dismissed).toEqual(['k']);
    const refusing = { ...store, getStewardInbox: () => Promise.reject(new Error('closed')) };
    expect(await dismissItem(refusing, 'k')).toBe(false);
  });
});

describe('readQueue and releaseListing', () => {
  it('lists each held listing beside the live one holding its name, and releases it', async () => {
    const fake = createFakeShelf({ minute: deviceMinute() });
    const shelf = createShelf({ fetch: fake.fetch });
    const birch = newSigningKeys();
    const oak = newSigningKeys();
    await shelf.put(base64url(birch.publicKey), listingBy(birch, 'Eastside Tenants Union'));
    await release(fake, base64url(birch.publicKey));
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

describe('readInbox and the console’s reports (#490)', () => {
  /** A keep in memory. */
  function keepIn(): InboxKeep {
    let held: KeptInbox | undefined;
    return {
      getStewardInbox: () => Promise.resolve(held),
      keepStewardInbox: (kept) => {
        held = kept ?? undefined;
        return Promise.resolve();
      },
    };
  }

  it('opens the inbox with the steward’s key, and the console lists what it found', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const address = base64url(newSigningKeys().publicKey);
    const id = base64url(new Uint8Array(32).fill(4));
    await sendReport({ relay }, { address, id, clause: 'C2', note: 'Spam' });
    const store = { ...keyStore(TEST_STEWARD_SECRET), ...keepIn() };
    const shelf = createShelf({ fetch: createFakeShelf().fetch });

    const queue = await readQueue(shelf, () => readInbox(store, relay));

    const inbox = typeof queue === 'string' ? [] : queue.inbox;
    expect(inbox).toMatchObject([{ kind: 'report', address, id, clause: 'C2', note: 'Spam' }]);
    expect(store.secret).toEqual(TEST_STEWARD_SECRET);
  });

  it('reads nothing on a device without the key, and fails the console when the inbox can’t be read', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const store = { ...keyStore(), ...keepIn() };
    expect(await readInbox(store, relay)).toEqual([]);
    expect(fake.requests).toEqual([]);

    fake.offline = true;
    const keyed = { ...keyStore(TEST_STEWARD_SECRET), ...keepIn() };
    const shelf = createShelf({ fetch: createFakeShelf().fetch });
    expect(await readQueue(shelf, () => readInbox(keyed, relay))).toBe('failed');
  });
});

describe('readFlags and useShelfFlags (#493; ADR-0082)', () => {
  const entryOf = (id: string, title: string) => ({
    address: 'A'.repeat(43),
    id,
    title,
    text: '',
    name: 'Elm Co-op',
    seq: 1,
    received: 29_000_000,
    early: false,
    listedSince: 29_000_000,
  });
  const VIEW = {
    waiting: [],
    listings: [],
    entries: [entryOf('d1', 'Potluck on Sunday'), entryOf('d2', 'Stand-in flagged entry')],
    holds: [],
    suspended: [],
    paused: false,
    inbox: [],
  };
  /** A classifier that flags `flagged` by the threat rule, recording each text. */
  const classifierFlagging = (flagged: string) => ({
    classify: vi.fn((text: string) =>
      Promise.resolve({ score: text === flagged ? 0.9 : 0, rule: 'threat', clause: 'C1' } as const),
    ),
  });

  it('is off, and classifies nothing, while the app’s classifier is switched off', async () => {
    expect(await readFlags(VIEW)).toBe('off');
    expect(await readFlags(VIEW, null)).toBe('off');
  });

  it('is off, and classifies nothing, for a console with nothing to show', async () => {
    const classifier = classifierFlagging('');
    expect(await readFlags('unavailable', classifier)).toBe('off');
    expect(await readFlags('failed', classifier)).toBe('off');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('flags the view’s entries, in its order', async () => {
    const classifier = classifierFlagging('Stand-in flagged entry');

    expect(await readFlags(VIEW, classifier)).toEqual([
      { address: 'A'.repeat(43), id: 'd2', rule: 'threat', clause: 'C1' },
    ]);
  });

  it('says it failed when the model can’t load, and flags nothing', async () => {
    const classifier = {
      classify: () => Promise.reject(new Error('The model file couldn’t be fetched.')),
    };
    expect(await readFlags(VIEW, classifier)).toBe('failed');
  });

  it('starts off, reads once the queue is read, and leaves the queue as it was', async () => {
    const read = vi.fn(() =>
      Promise.resolve([
        { address: 'A'.repeat(43), id: 'd2', rule: 'threat', clause: 'C1' },
      ] as const),
    );
    const { result, rerender } = renderHook(({ queue }) => useShelfFlags(queue, read), {
      initialProps: { queue: null as typeof VIEW | null },
    });

    expect(result.current).toBe('off');
    expect(read).not.toHaveBeenCalled();
    rerender({ queue: VIEW });
    await waitFor(() => {
      expect(result.current).toEqual([
        { address: 'A'.repeat(43), id: 'd2', rule: 'threat', clause: 'C1' },
      ]);
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(VIEW);
  });

  it('is off with the app’s classifier switched off', async () => {
    const { result } = renderHook(() => useShelfFlags(VIEW));
    await waitFor(() => {
      expect(result.current).toBe('off');
    });
  });
});
