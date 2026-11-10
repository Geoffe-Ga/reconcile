/**
 * The relay backup (#97): what the relay holds, when a device uploads, and
 * how a device that lost everything reads it back.
 *
 * A device here is a real store on fake-indexeddb with the real sync loop,
 * the real seal and a relay client on the fake relay, whose minute clock is
 * the relay time the schedule reads.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import { BACKUP_SEAL_INFO, backupIdFor, openRelayBackup } from '../crypto/relayBackup';
import { sha256 } from '../crypto/hash';
import { hkdf32 } from '../crypto/hkdf';
import { xchachaSeal } from '../crypto/seal';
import type { SignedEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { createRelay } from '../net/relay';
import { local, text, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { signedAs, testKeys } from '../test/keys';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { openStore, type Store } from './db';
import {
  fetchRelayBackup,
  refreshRelayBackup,
  relayBackupStatus,
  type RelayBackupServices,
  startRelayBackup,
} from './relayBackup';
import { importSnapshot } from './snapshot';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const CANARY = {
  group: 'Canary Street Commons',
  founder: 'Canaryana Founder',
  atom: 'Canary atom: the garden opens at dawn.',
  title: 'Canary title: open the garden',
};
const TS = 1_762_650_000_000;
const DAY = 1440;
/** Noon UTC on a day, in relay minutes. */
const NOON = 20_400 * DAY + 720;
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
});

/** A device: its store, its sync loop with the daily backup after each pass, and its services. */
interface Device {
  readonly store: Store;
  readonly sync: Sync;
  readonly services: RelayBackupServices;
}

/** Opens device `name` on `fake`, with the relay backup's schedule after each complete pass. */
async function openDevice(fake: FakeRelay, name: string): Promise<Device> {
  const store = await openStore(name);
  const relay = createRelay({ fetch: fake.fetch });
  const services = { store, relay, now: () => TS };
  const sync = createSync({
    store,
    relay,
    seal: xchachaSeal,
    clock: () => TS,
    afterPass: () => refreshRelayBackup(services),
  });
  opened.push(sync);
  return { store, sync, services };
}

/** A group's genesis by Ana, with `name` and the canary Atom. */
function genesisOf(name: string): SignedEvent {
  return signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: { name, founder: CANARY.founder, title: 'House rules', atoms: [CANARY.atom] },
  });
}

/** Ana's Proposal `title` on the group's first Atom. */
function proposalIn(founding: SignedEvent, title: string): SignedEvent {
  return signedAs('ana', {
    type: 'proposal',
    group: founding.id,
    ts: TS,
    body: { atom: `${founding.id}.0`, title, why: 'Why not.', text: 'New text.' },
  });
}

/** A group secret for the group named `name`, unlike any other test's. */
function secretFor(name: string): Uint8Array {
  return sha256(utf8(`group secret of ${name}`));
}

/** Ana founds `name` on `device` and syncs, so the relay has returned its genesis. */
async function found(device: Device, name = CANARY.group): Promise<SignedEvent> {
  const genesis = genesisOf(name);
  const { secretKey, author } = testKeys('ana');
  await device.store.addGroup({
    groupId: genesis.id,
    secret: secretFor(name),
    signingKey: secretKey,
    me: { author, name: CANARY.founder },
  });
  await device.store.enqueue(genesis.id, genesis.record);
  expect(await device.sync.syncOnce()).toBe(true);
  return genesis;
}

/** Ana proposes `title` in the group and syncs it out and back: one change. */
async function change(device: Device, founding: SignedEvent, title: string): Promise<void> {
  await device.store.enqueue(founding.id, proposalIn(founding, title).record);
  expect(await device.sync.syncOnce()).toBe(true);
}

/** The backup PUTs the relay has received, by id. */
function uploads(fake: FakeRelay): string[] {
  return fake.requests
    .filter((request) => request.method === 'PUT' && request.url.startsWith('/v1/backup/'))
    .map((request) => request.url.slice('/v1/backup/'.length));
}

/** What a device's store folds each of its groups to, by group id. */
async function folds(store: Store): Promise<unknown> {
  const groups = await store.listGroups();
  return Object.fromEntries(
    groups.map((group) => [group.groupId, fold(group.log, group.relayNow)]),
  );
}

/** The key the device keeps for its relay backup. */
async function keyOf(store: Store): Promise<Uint8Array> {
  const state = await store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

describe('what the relay holds', () => {
  it('is one blob of a backup size, with no name, text, key or secret in any spelling', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const founding = await found(device);
    await change(device, founding, CANARY.title);

    await startRelayBackup(device.services);

    const key = await keyOf(device.store);
    const id = backupIdFor(key);
    const blob = fake.backup(id);
    if (blob === undefined) throw new Error('Expected the backup on the relay.');
    const secret = secretFor(CANARY.group);
    const keys = [
      ...keyCanaries('signing key', testKeys('ana').secretKey),
      ...keyCanaries('group secret', secret),
      ...keyCanaries('group seal key', deriveSealKey(secret)),
      ...keyCanaries('backup key', key),
      ...keyCanaries('backup seal key', hkdf32(key, BACKUP_SEAL_INFO)),
    ];
    const words = [
      textCanary('group name', CANARY.group),
      textCanary('founder’s name', CANARY.founder),
      textCanary('Atom text', CANARY.atom),
      textCanary('Proposal title', CANARY.title),
    ];
    expect([65536, 262144, 1048576, 4194304, 16777216]).toContain(blob.length);
    expect(findCanaries(blob, [...words, ...keys])).toEqual([]);
    // The plaintext inside holds every word, key and secret but the backup key's own, so the
    // scan can't pass by looking at nothing, and the relay's copy never carries its key.
    const plaintext = openRelayBackup(key, blob) ?? new Uint8Array();
    const inside = new Set(
      findCanaries(plaintext, [...words, ...keys]).map((l) => l.split(',')[0]),
    );
    expect([...inside].sort()).toEqual(
      [
        'Atom text',
        'Proposal title',
        'founder’s name',
        'group name',
        'group secret (base64url)',
        'group secret (raw)',
        'signing key (base64url)',
        'signing key (raw)',
      ].sort(),
    );
    expect(Object.keys(JSON.parse(text(plaintext)) as object)).toEqual(['format', 'groups']);
  });

  it('lives under an id that is no mailbox’s, and the request names nothing else', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    await found(device);

    await startRelayBackup(device.services);

    const [id] = uploads(fake);
    const mailbox = deriveMailboxId(secretFor(CANARY.group));
    expect(id).toBe(backupIdFor(await keyOf(device.store)));
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(mailbox);
    expect(fake.blobs(id ?? '')).toEqual([]);
    const put = fake.requests.find((request) => request.url === `/v1/backup/${id ?? ''}`);
    expect(put?.contentType).toBe('application/octet-stream');
  });
});

describe('the schedule', () => {
  it('uploads at once, then at most once a relay day, and only when something changed', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const founding = await found(device);

    await startRelayBackup(device.services);
    expect(uploads(fake)).toHaveLength(1);

    // Three changes and syncs in the same relay day: no second upload.
    for (const title of ['One', 'Two', 'Three']) await change(device, founding, title);
    fake.minute = NOON + 600; // 22:00 the same UTC day
    expect(await device.sync.syncOnce()).toBe(true);
    expect(uploads(fake)).toHaveLength(1);

    // The next relay day's first sync uploads once, and its later syncs don't.
    fake.minute = NOON + DAY - 720; // 00:00 the next day
    expect(await device.sync.syncOnce()).toBe(true);
    expect(uploads(fake)).toHaveLength(2);
    await change(device, founding, 'Four');
    expect(uploads(fake)).toHaveLength(2);

    // The day after, the first sync uploads Four; a day with no change then uploads nothing.
    fake.minute += DAY;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(uploads(fake)).toHaveLength(3);
    fake.minute += DAY;
    expect(await device.sync.syncOnce()).toBe(true);
    fake.minute += DAY;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(uploads(fake)).toHaveLength(3);

    // What the relay holds is the latest upload: it opens to all four Proposals.
    const key = await keyOf(device.store);
    const held = text(
      openRelayBackup(key, fake.backup(backupIdFor(key)) ?? new Uint8Array()) ?? new Uint8Array(),
    );
    expect(held).toContain(
      `"cursor":${String((await device.store.getGroup(founding.id))?.cursor)}`,
    );
  });

  it('uploads nothing before a key exists', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const founding = await found(device);

    fake.minute += DAY;
    await change(device, founding, 'One');

    expect(uploads(fake)).toEqual([]);
    expect(await device.store.getRelayBackup()).toBeUndefined();
  });

  it('waits for a pass in which every group synced', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const founding = await found(device);
    await startRelayBackup(device.services);
    await change(device, founding, 'One');
    fake.minute += DAY;

    // A second group that can't sync (its secret is a byte short): the pass doesn't complete.
    await device.store.addGroup({
      groupId: 'broken-group',
      secret: new Uint8Array(31),
      signingKey: testKeys('ana').secretKey,
      me: { author: testKeys('ana').author, name: 'Ana' },
    });
    expect(await device.sync.syncOnce()).toBe(false);
    expect(uploads(fake)).toHaveLength(1);

    await device.store.purgeGroup('broken-group');
    expect(await device.sync.syncOnce()).toBe(true);
    expect(uploads(fake)).toHaveLength(2);
  });

  it('keeps the key and tries again after the next complete pass when an upload fails', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    await found(device);
    fake.offline = true;

    expect(await startRelayBackup(device.services)).toBeNull();
    const key = await keyOf(device.store);
    expect(relayBackupStatus(await device.store.getRelayBackup())).toEqual({ kind: 'waiting' });

    fake.offline = false;
    expect(await device.sync.syncOnce()).toBe(true);

    expect(uploads(fake)).toEqual([backupIdFor(key)]);
    expect(relayBackupStatus(await device.store.getRelayBackup())).toEqual({
      kind: 'saved',
      at: TS,
    });
  });

  it('makes a new key on request, uploads under its new id, and hands back the old id', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    await found(device);

    const none = await startRelayBackup(device.services);
    const first = await keyOf(device.store);
    const again = await startRelayBackup(device.services);
    const previous = await startRelayBackup(device.services, { newKey: true });
    const second = await keyOf(device.store);

    expect([none, again]).toEqual([null, null]);
    expect(previous).toBe(backupIdFor(first));
    expect(uploads(fake)).toEqual([backupIdFor(first), backupIdFor(first), backupIdFor(second)]);
    expect(backupIdFor(second)).not.toBe(backupIdFor(first));
    expect(
      openRelayBackup(second, fake.backup(backupIdFor(second)) ?? new Uint8Array()),
    ).not.toBeNull();
  });

  it('keeps the last good backup when the groups grow past 16 MiB, and says so', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const founding = await found(device);
    await startRelayBackup(device.services);
    const key = await keyOf(device.store);
    const good = fake.backup(backupIdFor(key));
    // The next relay day's pull brings 200 records of 64,000 bytes: about 17.1 MB once
    // written as base64url, past 16 MiB. The refresh runs as a complete pass would run it.
    const big = Array.from({ length: 200 }, (_, i) => ({
      seq: 1000 + i,
      received: NOON,
      bytes: new Uint8Array(64_000).fill(i % 251),
    }));
    const pull = {
      records: big,
      cursor: 2000,
      relayNow: NOON + DAY,
      instance: fake.instance,
      lastSyncAt: TS,
    };
    await device.store.applyPull(founding.id, pull, (bytes) => `big-${String(bytes[0])}`);

    await refreshRelayBackup(device.services);

    expect(uploads(fake)).toHaveLength(1);
    expect(fake.backup(backupIdFor(key))).toEqual(good);
    expect(relayBackupStatus(await device.store.getRelayBackup())).toEqual({ kind: 'too-large' });
  });
});

describe('relayBackupStatus', () => {
  const key = new Uint8Array(32);
  const state = { key, digest: null, checkedDay: null, uploadedAt: null, tooLarge: false };

  it('reads off with no key, waiting before an upload, saved after one, and too large first', () => {
    expect(relayBackupStatus(undefined)).toEqual({ kind: 'off' });
    expect(relayBackupStatus(state)).toEqual({ kind: 'waiting' });
    expect(relayBackupStatus({ ...state, uploadedAt: 5 })).toEqual({ kind: 'saved', at: 5 });
    expect(relayBackupStatus({ ...state, uploadedAt: 5, tooLarge: true })).toEqual({
      kind: 'too-large',
    });
  });
});

describe('fetchRelayBackup', () => {
  it('brings every group back on a fresh device, folding as the source does', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    const first = await found(device);
    await change(device, first, CANARY.title);
    await found(device, 'Second Street Garden');
    await startRelayBackup(device.services);
    const key = await keyOf(device.store);

    const relay = createRelay({ fetch: fake.fetch });
    const plaintext = await fetchRelayBackup(relay, key);
    const fresh = await openStore('fresh');
    const restored = await importSnapshot(fresh, plaintext ?? new Uint8Array());

    expect(restored).toBe(2);
    expect(await folds(fresh)).toEqual(await folds(device.store));
    expect(await fresh.getRelayBackup()).toBeUndefined();
  });

  it('reads null for a backup the relay doesn’t hold, a changed byte, or a blob of another key', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const device = await openDevice(fake, 'ana');
    await found(device);
    await startRelayBackup(device.services);
    const key = await keyOf(device.store);
    const id = backupIdFor(key);
    const relay = createRelay({ fetch: fake.fetch });
    const blob = Uint8Array.from(fake.backup(id) ?? new Uint8Array());

    const unknown = await fetchRelayBackup(relay, new Uint8Array(32).fill(3));
    blob[100] = (blob[100] ?? 0) ^ 1;
    await relay.putBackup(id, blob);
    const changed = await fetchRelayBackup(relay, key);
    await relay.putBackup(id, new Uint8Array(65536).fill(7));
    const framed = await fetchRelayBackup(relay, key);

    expect([unknown, changed, framed]).toEqual([null, null, null]);
  });

  it('passes on a relay it can’t reach, so “no backup” and “offline” read differently', async () => {
    const fake = createFakeRelay({ minute: NOON });
    fake.offline = true;

    await expect(
      fetchRelayBackup(createRelay({ fetch: fake.fetch }), new Uint8Array(32)),
    ).rejects.toThrow(TypeError);
  });
});
