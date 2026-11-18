/**
 * The Bedfellows history's sealed slot (#480; ADR-0080 §5), on the real store
 * over fake-indexeddb: it lives only in the vault, at one fixed size, so a
 * locked device shows no sign of it; a device without a vault writes none;
 * a locked one refuses; and no snapshot, backup file, relay backup, device
 * link, Restore or erase carries it anywhere.
 */
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { backupIdFor, openRelayBackup } from '../crypto/relayBackup';
import { HISTORY_SEALED_BYTES, openHistory } from '../crypto/history';
import { vaultKeyFromPrf } from '../crypto/keyVault';
import { concat, local, text, utf8 } from '../test/bytes';
import { found } from '../test/coalitionDevices';
import { testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { linkDevice } from '../test/link';
import { scanDb } from '../test/scanDb';
import {
  BEDFELLOWS_CLEARED,
  type BedfellowsState,
  createBedfellowsHistory,
  decodeHistory,
  EMPTY_HISTORY,
} from './bedfellows';
import { DATABASE_NAME, openStore, type Store, VaultLocked } from './db';
import { eraseDevice } from './erase';
import { startRelayBackup } from './relayBackup';
import { newPersonalId } from './personal';
import { importSnapshot, takeSnapshot } from './snapshot';
import type { VaultLock } from './vault';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const WRONG_KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x22), SALT);
const LOCK: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };
const DAY = 86_400_000;
/** 2026-11-18 at 09:30 UTC. */
const NOW = Date.UTC(2026, 10, 18, 9, 30);
const TODAY = Math.floor(NOW / DAY);

/** Entry ids no other part of a test spells, so a scan that finds one found the history. */
const IDS = [
  'canary-entry-riverside-library',
  'canary-entry-deer-season',
  'canary-entry-ring-road',
];
/** The marks' own words, which only the history spells. */
const MARK_WORDS = ['common-ground', 'too-far'];

/** A history with every canary id shown and both marks set. */
const HISTORY: BedfellowsState = {
  dial: 5,
  lastStepWeek: 2919,
  seed: 31337,
  shown: [
    { id: IDS[0] ?? '', day: TODAY, mark: 'common-ground' },
    { id: IDS[1] ?? '', day: TODAY, mark: 'too-far' },
    { id: IDS[2] ?? '', day: TODAY - 3 },
  ],
};

const opened: Store[] = [];
const devices: TestDevice[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const device of devices.splice(0)) device.services.store.close();
});

/** Opens the app's store, closed after the test. */
async function store(name = DATABASE_NAME): Promise<Store> {
  const held = await openStore(name);
  opened.push(held);
  return held;
}

/** Every key and value in every object store of `name`, as raw bytes (`test/scanDb.ts`). */
async function rawDatabase(name = DATABASE_NAME): Promise<Uint8Array> {
  const { text: words, bytes } = await scanDb(name);
  return concat(utf8(words), ...bytes.flatMap((held) => [Uint8Array.of(0), held]));
}

/** Which of the canary ids and mark words `bytes` spell, as UTF-8. */
function historyWordsIn(bytes: Uint8Array): string[] {
  const all = text(bytes);
  return [...IDS, ...MARK_WORDS, '"dial"'].filter((word) => all.includes(word));
}

/** Every record of the vault store, raw. */
async function rawVaultStore(name = DATABASE_NAME): Promise<Record<string, unknown>[]> {
  const db = await openDB(name);
  try {
    return (await db.getAll('vault')) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** The sealed slot as IndexedDB holds it, or undefined. */
async function rawSlot(name = DATABASE_NAME): Promise<Uint8Array | undefined> {
  const records = await rawVaultStore(name);
  const slot = records.find((record) => record.id === 'history');
  return slot === undefined ? undefined : local(slot.sealed as Uint8Array);
}

describe('the sealed Bedfellows history (#480)', () => {
  it('writes nothing on a device with no vault, and reads none', async () => {
    const held = await store();
    expect(await held.readBedfellows()).toBeNull();
    expect(await held.keepBedfellows(HISTORY)).toBe(false);
    expect(await rawVaultStore()).toEqual([]);
    expect(historyWordsIn(await rawDatabase())).toEqual([]);
  });

  it('gives every new vault an empty slot of 64 KiB, and keeps the history only sealed in it', async () => {
    const held = await store();
    // The control: these words in a record IndexedDB keeps plainly, which the scan finds.
    const control = newPersonalId();
    await held.savePersonal({
      id: control,
      title: IDS.join(' '),
      text: `${MARK_WORDS.join(' ')} "dial"`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(historyWordsIn(await rawDatabase()).sort()).toEqual(
      [...IDS, ...MARK_WORDS, '"dial"'].sort(),
    );
    await held.deletePersonal(control);

    await held.sealKeys(LOCK, KEY);
    const empty = await rawSlot();
    expect(empty?.length).toBe(HISTORY_SEALED_BYTES);
    expect(decodeHistory(openHistory(KEY, empty ?? new Uint8Array()) ?? new Uint8Array())).toEqual(
      EMPTY_HISTORY,
    );

    expect(await held.keepBedfellows(HISTORY)).toBe(true);
    const full = await rawSlot();
    // An empty history and a full one are the same size: the slot's size says nothing.
    expect(full?.length).toBe(HISTORY_SEALED_BYTES);
    expect(full).not.toEqual(empty);
    expect(historyWordsIn(await rawDatabase())).toEqual([]);
    expect(await held.readBedfellows()).toEqual(HISTORY);
  });

  it('opens the slot for a later session only once it unlocks, and refuses a write while locked', async () => {
    const first = await store();
    await first.sealKeys(LOCK, KEY);
    await first.keepBedfellows(HISTORY);
    first.close();
    const before = await rawSlot();

    const later = await store();
    await expect(later.readBedfellows()).rejects.toBeInstanceOf(VaultLocked);
    await expect(later.keepBedfellows(EMPTY_HISTORY)).rejects.toBeInstanceOf(VaultLocked);
    await expect(later.clearBedfellows()).rejects.toBeInstanceOf(VaultLocked);
    expect(await rawSlot()).toEqual(before);
    expect(await later.unlock(WRONG_KEY)).toBe(false);
    await expect(later.readBedfellows()).rejects.toBeInstanceOf(VaultLocked);

    expect(await later.unlock(KEY)).toBe(true);
    expect(await later.readBedfellows()).toEqual(HISTORY);
  });

  it('gives a vault sealed before #480 its slot at the next unlock, so no vault goes without one', async () => {
    const first = await store();
    await first.sealKeys(LOCK, KEY);
    first.close();
    const db = await openDB(DATABASE_NAME);
    await db.delete('vault', 'history');
    db.close();

    const later = await store();
    expect(await later.unlock(KEY)).toBe(true);
    expect((await rawSlot())?.length).toBe(HISTORY_SEALED_BYTES);
    expect(await later.readBedfellows()).toEqual(EMPTY_HISTORY);
  });

  it('reads a slot that doesn’t open or check out as an empty history', async () => {
    const held = await store();
    await held.sealKeys(LOCK, KEY);
    const db = await openDB(DATABASE_NAME);
    await db.put('vault', { id: 'history', sealed: new Uint8Array(HISTORY_SEALED_BYTES) });
    db.close();
    expect(await held.readBedfellows()).toEqual(EMPTY_HISTORY);
  });

  it('clears by overwriting the slot with an empty history, and says so to listeners', async () => {
    const held = await store();
    await held.sealKeys(LOCK, KEY);
    await held.keepBedfellows(HISTORY);
    const heard: string[] = [];
    held.subscribe((changed) => heard.push(changed));
    const before = await rawSlot();
    await held.clearBedfellows();
    const after = await rawSlot();
    expect(after?.length).toBe(HISTORY_SEALED_BYTES);
    expect(after).not.toEqual(before);
    expect(await held.readBedfellows()).toEqual(EMPTY_HISTORY);
    expect(heard).toEqual([BEDFELLOWS_CLEARED]);
  });

  it('clears a device with no vault by telling listeners, writing nothing', async () => {
    const held = await store();
    const heard: string[] = [];
    held.subscribe((changed) => heard.push(changed));
    await held.clearBedfellows();
    expect(heard).toEqual([BEDFELLOWS_CLEARED]);
    expect(await rawVaultStore()).toEqual([]);
  });

  it('sweeps by the device clock with the store’s other expiries, writing only when a record went', async () => {
    const held = await store();
    await held.sealKeys(LOCK, KEY);
    await held.keepBedfellows(HISTORY);
    const kept = await rawSlot();
    await held.sweepBedfellows(NOW);
    expect(await rawSlot()).toEqual(kept);
    // 30 days after the start of TODAY - 3, the oldest record goes; the others stay.
    await held.sweepBedfellows((TODAY - 3 + 30) * DAY);
    expect((await held.readBedfellows())?.shown.map(({ id }) => id)).toEqual(IDS.slice(0, 2));
  });

  it('names no group, so a group added, then left or dissolved and purged, changes nothing in it', async () => {
    const held = await store();
    await held.sealKeys(LOCK, KEY);
    await held.keepBedfellows(HISTORY);
    const slot = await rawSlot();
    const group = await held.addGroup({
      groupId: 'group-ana',
      secret: new Uint8Array(32).fill(7),
      signingKey: new Uint8Array(32).fill(8),
      me: { author: 'author-ana', name: 'Ana' },
    });
    await held.purgeGroup(group.groupId);
    expect(await rawSlot()).toEqual(slot);
    expect(await held.readBedfellows()).toEqual(HISTORY);
  });

  it('sweeps nothing on a device with no vault or a locked one, and doesn’t fail', async () => {
    const plain = await store('plain');
    await expect(plain.sweepBedfellows(NOW)).resolves.toBeUndefined();
    const first = await store();
    await first.sealKeys(LOCK, KEY);
    await first.keepBedfellows(HISTORY);
    first.close();
    const before = await rawSlot();
    const locked = await store();
    await expect(locked.sweepBedfellows(NOW + 60 * DAY)).resolves.toBeUndefined();
    expect(await rawSlot()).toEqual(before);
  });
});

describe('the history stays on one device (#480)', () => {
  /** A store with a vault, every canary id in its history, and a personal Document. */
  async function heldHistory(name = DATABASE_NAME): Promise<Store> {
    const held = await store(name);
    await held.savePersonal({
      id: newPersonalId(),
      title: 'Water at dusk',
      text: 'Tools back on the hook.',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await held.sealKeys(LOCK, KEY);
    await held.keepBedfellows(HISTORY);
    return held;
  }

  it('no backup file’s or link bundle’s plaintext carries it', async () => {
    const held = await heldHistory();
    for (const to of ['backup', 'link'] as const) {
      const { plaintext } = await takeSnapshot(held, to);
      // The control: the snapshot carries the device's Document, so it isn't empty.
      expect(text(plaintext)).toContain('Tools back on the hook.');
      expect(historyWordsIn(plaintext)).toEqual([]);
    }
  });

  it('a device restored or linked from a snapshot starts with no history and the dial at 0', async () => {
    const held = await heldHistory();
    const { plaintext } = await takeSnapshot(held);
    const fresh = await store('fresh');
    await fresh.sealKeys(LOCK, KEY);
    await importSnapshot(fresh, plaintext, 'backup');
    await importSnapshot(fresh, (await takeSnapshot(held, 'link')).plaintext, 'link');
    expect(await fresh.readBedfellows()).toEqual(EMPTY_HISTORY);
    expect(historyWordsIn(await rawDatabase('fresh'))).toEqual([]);
  });

  it('Restore over a lost passkey takes the slot with the vault, so the device keeps none', async () => {
    const held = await heldHistory();
    await held.replaceGroups([]);
    expect(await rawSlot()).toBeUndefined();
    expect(await held.readBedfellows()).toBeNull();
  });

  it('Erase this device leaves no slot and no history', async () => {
    const held = await heldHistory();
    await eraseDevice(
      { sync: { halt: () => Promise.resolve() }, store: held },
      {
        indexedDB,
        caches: undefined,
        storages: [],
        serviceWorker: undefined,
        replace: () => undefined,
      },
    );
    const after = await store();
    expect(await after.readVault()).toBeNull();
    expect(await after.readBedfellows()).toBeNull();
    expect(historyWordsIn(await rawDatabase())).toEqual([]);
  });
});

describe('a device with history, end to end through a fake relay (#480)', () => {
  /** Ana's phone with a group, a vault and the canary history. */
  async function phone(fake: FakeRelay): Promise<TestDevice> {
    const device = await testDevice(fake, 'ana-phone', () => NOW);
    devices.push(device);
    await found(device, 'Canary Lane Allotments', 'Ana');
    await device.services.store.sealKeys(LOCK, KEY);
    await device.services.store.keepBedfellows(HISTORY);
    return device;
  }

  /** Every request `fake` saw, its URL and body, as bytes. */
  function requestBytes(fake: FakeRelay): Uint8Array {
    return concat(
      ...fake.requests.flatMap((request) => [utf8(request.url), request.body ?? new Uint8Array()]),
    );
  }

  it('sends nothing while it shows, marks, sweeps and clears, and no request ever carries it', async () => {
    const fake = createFakeRelay();
    const device = await phone(fake);
    const { store: held, sync } = device.services;
    const history = createBedfellowsHistory(held, { now: () => NOW });
    const before = fake.requests.length;

    await history.open([...IDS, 'canary-entry-new']);
    await history.showed(['canary-entry-new']);
    await history.mark(IDS[2] ?? '', 'too-far');
    await history.mark(IDS[0] ?? '', null);
    await history.setDial(7);
    await history.sweep(IDS);
    await history.flush();
    // Not one request while the history changed.
    expect(fake.requests.length).toBe(before);

    // A sync pass sweeps it too, and then the history is cleared; still nothing carries it.
    await sync.syncOnce();
    await history.clear();
    await sync.syncOnce();
    expect(fake.requests.length).toBeGreaterThan(before);
    expect(historyWordsIn(requestBytes(fake))).toEqual([]);
    history.close();
  });

  it('forgets what expired by the device clock after a sync pass, as the store’s other expiries run', async () => {
    const fake = createFakeRelay();
    let now = NOW;
    const device = await testDevice(fake, 'ana-phone', () => now);
    devices.push(device);
    await found(device, 'Canary Lane Allotments', 'Ana');
    await device.services.store.sealKeys(LOCK, KEY);
    await device.services.store.keepBedfellows(HISTORY);
    now = (TODAY - 3 + 30) * DAY;
    await device.services.sync.syncOnce();
    const held = await device.services.store.readBedfellows();
    expect(held?.shown.map(({ id }) => id)).toEqual(IDS.slice(0, 2));
  });

  it('no relay backup carries it', async () => {
    const fake = createFakeRelay();
    const device = await phone(fake);
    const { store: held } = device.services;
    await startRelayBackup({ store: held, relay: device.services.relay, now: () => NOW });
    const state = await held.getRelayBackup();
    if (state === undefined) throw new Error('Expected a relay backup.');
    const blob = fake.backup(backupIdFor(state.key)) ?? new Uint8Array();
    const plaintext = openRelayBackup(state.key, blob) ?? new Uint8Array();
    // The control: the relay's copy holds the group.
    const [group] = await held.listGroups();
    expect(text(plaintext)).toContain(group?.groupId ?? 'a group');
    expect(historyWordsIn(plaintext)).toEqual([]);
  });

  it('a linked device starts with no history and the dial at 0', async () => {
    const fake = createFakeRelay();
    const from = await phone(fake);
    const laptop = await linkDevice(fake, from, 'ana-laptop');
    devices.push(laptop);
    expect((await laptop.services.store.listGroups()).length).toBe(1);
    expect(await laptop.services.store.readBedfellows()).toBeNull();
    await laptop.services.store.sealKeys(LOCK, KEY);
    expect(await laptop.services.store.readBedfellows()).toEqual(EMPTY_HISTORY);
    expect(historyWordsIn(await rawDatabase('ana-laptop'))).toEqual([]);
    expect(historyWordsIn(requestBytes(fake))).toEqual([]);
  });
});
