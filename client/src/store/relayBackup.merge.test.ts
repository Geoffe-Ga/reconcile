/**
 * Two devices, one relay backup (#247): linked devices (#96) share #97's
 * backup key, so they keep one relay copy under one id, while each keeps
 * its own personal Documents (#93). Before each upload a device reads the
 * relay copy and merges its personal Documents into its own, so neither
 * device's upload drops the other's. Each keeps its own groups too, once one
 * joins a group after the link (#327), so an upload carries the copy's entry
 * for a group this device doesn't hold, and leaves out one it left.
 *
 * First the merge rules themselves (`mergePersonal`, `carriedGroups`), then
 * the refresh on real stores, the real seal and the fake relay: one GET a
 * refresh day, a Document deleted or a group left here leaving the copy, and
 * every way the read can fail falling back to uploading this device's own
 * copy, as before.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { backupIdFor, groupTagFor, sealRelayBackup } from '../crypto/relayBackup';
import { sha256 } from '../crypto/hash';
import { xchachaSeal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import type { SignedEvent } from '../engine/event';
import { base64url } from '../crypto/base64url';
import { createRelay, type Fetch } from '../net/relay';
import { SHARE_TTL_DAYS } from '../share/shareLink';
import { local, text, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { signedAs, testKeys } from '../test/keys';
import { openStore, type Store } from './db';
import type { PersonalDocument, ShareState } from './personal';
import {
  carriedGroups,
  fetchRelayBackup,
  mergePersonal,
  refreshRelayBackup,
  type RelayBackupServices,
  startRelayBackup,
} from './relayBackup';
import { importSnapshot, type RelayGroup, takeSnapshot } from './snapshot';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const TS = 1_762_650_000_000;
const DAY_MS = 86_400_000;
const DAY = 1440;
/** Noon UTC on a day, in relay minutes. */
const NOON = 20_400 * DAY + 720;

/** Three ids a device could make: 16 bytes each, in unpadded base64url. */
const A = 'Q2FuYXJ5IHN0YXRlbWVudA';
const B = 'UmVhZGluZyBsaXN0IGlkIQ';
const C = 'TmV3IGRvY3VtZW50IGlkIQ';

/** A personal Document `id`, titled `title`, made at `createdAt` and last edited at `updatedAt`. */
function doc(id: string, title: string, updatedAt: number, createdAt = 1): PersonalDocument {
  return { id, title, text: `${title}, as written.`, createdAt, updatedAt };
}

/** A share by link (#105), its seed filled with `fill`, last posted at `lastPostedAt`. */
function share(fill: number, lastPostedAt: number | null = TS): ShareState {
  const keys = newSigningKeys();
  return {
    seed: new Uint8Array(32).fill(fill),
    secretKey: keys.secretKey,
    publicKey: keys.publicKey,
    n: 1,
    lastPostedAt,
    pending: false,
  };
}

/** The merge at {@link TS}, with nothing uploaded from this device before unless named. */
function merge(
  own: readonly PersonalDocument[],
  relay: readonly PersonalDocument[],
  uploaded: readonly string[] = [],
  now = TS,
): PersonalDocument[] {
  return mergePersonal(own, relay, { uploaded: new Set(uploaded), now });
}

describe('mergePersonal (#247)', () => {
  it('keeps a Document either side holds alone, but not one this device uploaded and then deleted', () => {
    const mine = doc(A, 'Mine', 5);
    const theirs = doc(B, 'Theirs', 5, 2);
    const deleted = doc(C, 'Deleted here', 5, 3);

    expect(merge([mine], [theirs, deleted], [A, C])).toEqual([mine, theirs]);
    expect(merge([mine], [theirs, deleted], [A])).toEqual([mine, theirs, deleted]);
    expect(merge([], [theirs])).toEqual([theirs]);
    expect(merge([mine], [])).toEqual([mine]);
  });

  it('keeps the later edit of a Document both hold, and this device’s on a tie, as a restore does', () => {
    const earlier = doc(A, 'Earlier', 5);
    const later = { ...doc(A, 'Later', 6), text: 'Edited later.' };
    const tie = { ...earlier, text: 'Edited on the other device at the same moment.' };

    expect(merge([earlier], [later])).toEqual([later]);
    expect(merge([later], [earlier])).toEqual([later]);
    expect(merge([earlier], [tie])).toEqual([earlier]);
  });

  it('keeps this device’s share, marked pending when the relay copy’s later words replace its own', () => {
    const held = share(1);
    const earlier = { ...doc(A, 'Earlier', 5), share: held };
    const later = doc(A, 'Later', 6);

    expect(merge([earlier], [later])).toEqual([{ ...later, share: { ...held, pending: true } }]);
    expect(merge([{ ...later, share: held }], [earlier])).toEqual([{ ...later, share: held }]);
    // Words that didn't change leave it as it was.
    expect(merge([{ ...earlier, share: held }], [{ ...earlier, updatedAt: 6 }])).toEqual([
      { ...earlier, updatedAt: 6, share: held },
    ]);
  });

  it('keeps this device’s share over another the relay copy holds on the same Document', () => {
    const mine = share(1);
    const theirs = share(2, TS + 1);

    expect(
      merge([{ ...doc(A, 'Same', 5), share: mine }], [{ ...doc(A, 'Same', 5), share: theirs }]),
    ).toEqual([{ ...doc(A, 'Same', 5), share: mine }]);
  });

  it('carries the relay copy’s share onto a Document this device holds unshared while its link may still open', () => {
    const ttl = SHARE_TTL_DAYS * DAY_MS;
    const live = share(3, TS - ttl + 1);
    const same = doc(A, 'Same', 5);

    expect(merge([same], [{ ...same, share: live }])).toEqual([{ ...same, share: live }]);
    // Its link has expired at the relay: nobody can read it, and this device may be the one that stopped it.
    expect(merge([same], [{ ...same, share: share(3, TS - ttl) }])).toEqual([same]);
    expect(merge([same], [{ ...same, share: share(3, null) }])).toEqual([same]);
    // Later words here mark it pending, so a device restored from the copy posts them to the link.
    const later = doc(A, 'Later here', 6);
    expect(merge([later], [{ ...same, share: live }])).toEqual([
      { ...later, share: { ...live, pending: true } },
    ]);
    // Later words in the relay copy keep it as the copy has it.
    expect(merge([same], [{ ...later, share: live }])).toEqual([{ ...later, share: live }]);
  });

  it('keeps a Document only the relay copy holds whole, however long ago its share last posted', () => {
    const old = share(4, TS - 400 * DAY_MS);
    const theirs = { ...doc(B, 'Theirs', 5), share: old };

    expect(merge([], [theirs])).toEqual([theirs]);
  });

  it('lists them oldest first, then by id, whichever side each came from', () => {
    const first = doc(C, 'First', 1, 1);
    const second = doc(A, 'Second', 2, 2);
    const third = doc(B, 'Third', 2, 2);

    expect(merge([third, first], [second]).map((document) => document.id)).toEqual([C, A, B]);
  });
});

describe('carriedGroups (#327)', () => {
  const KEY = new Uint8Array(32).fill(0x5c);
  /** Three group ids and two authors: 43 base64url characters each. */
  const [G1, G2, G3, ANA, ANA_AGAIN] = ['g1', 'g2', 'g3', 'a1', 'a2'].map((seed) =>
    base64url(sha256(utf8(seed))),
  ) as [string, string, string, string, string];

  /** The relay copy's entry for `groupId`, as member `author`. */
  function entry(groupId: string, author = ANA): RelayGroup {
    return { groupId, author, entry: { groupId, me: { author, name: 'Ana' }, log: [] } };
  }

  /** What an upload carries of `relay` when this device holds `held` and uploaded `left` before. */
  function carry(
    relay: readonly RelayGroup[],
    held: readonly string[] = [],
    left: readonly (readonly [string, string])[] = [],
  ): RelayGroup[] {
    const tags = left.map(([groupId, author]) => groupTagFor(KEY, groupId, author));
    return carriedGroups(relay, { held: new Set(held), left: new Set(tags), key: KEY });
  }

  it('carries each group this device neither holds nor uploaded before, whole and in the copy’s order', () => {
    expect(carry([entry(G3), entry(G1)])).toEqual([entry(G3), entry(G1)]);
    expect(carry([])).toEqual([]);
  });

  it('leaves out one this device holds, in any state, and one it uploaded and no longer holds', () => {
    expect(carry([entry(G1), entry(G2), entry(G3)], [G1], [[G2, ANA]])).toEqual([entry(G3)]);
  });

  it('carries a group rejoined under another author, though this device left it as the first', () => {
    expect(carry([entry(G1, ANA_AGAIN)], [], [[G1, ANA]])).toEqual([entry(G1, ANA_AGAIN)]);
  });
});

const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
});

/** A device on the fake relay, with the relay backup's refresh after each complete pass. */
interface Device {
  readonly store: Store;
  readonly sync: Sync;
  readonly services: RelayBackupServices;
}

/**
 * Opens device `name`, whose relay client goes through `wrap` of the fake's
 * `fetch`, so a test can fail one route.
 */
async function openDevice(
  fake: FakeRelay,
  name: string,
  wrap: (fetch: Fetch) => Fetch = (fetch) => fetch,
): Promise<Device> {
  const store = await openStore(name);
  const relay = createRelay({ fetch: wrap(fake.fetch) });
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

/**
 * Ana founds group `name` on `device` and syncs, so the relay has a day for
 * the schedule; returns its id.
 */
async function found(device: Device, name = 'Riverside Tenants'): Promise<string> {
  const genesis: SignedEvent = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: { name, founder: 'Ana', title: 'House rules', atoms: ['Quiet.'] },
  });
  const { secretKey, author } = testKeys('ana');
  await device.store.addGroup({
    groupId: genesis.id,
    secret: sha256(utf8(`${name}'s secret`)),
    signingKey: secretKey,
    me: { author, name: 'Ana' },
  });
  await device.store.enqueue(genesis.id, genesis.record);
  expect(await device.sync.syncOnce()).toBe(true);
  return genesis.id;
}

/** `from`'s groups and backup key on `to`, as a link carries them (#96): the same backup. */
async function linked(from: Device, to: Device): Promise<void> {
  const { plaintext } = await takeSnapshot(from.store, 'link');
  await importSnapshot(to.store, plaintext, 'link');
}

/** The relay backup key `store` keeps. */
async function keyOf(store: Store): Promise<Uint8Array> {
  const state = await store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

/** The titles of the personal Documents the relay copy under `key` holds, in its order. */
async function titlesOnRelay(fake: FakeRelay, key: Uint8Array): Promise<string[]> {
  const plaintext = await fetchRelayBackup(createRelay({ fetch: fake.fetch }), key);
  if (plaintext === null) throw new Error('Expected a relay copy.');
  const copy = JSON.parse(text(plaintext)) as { personal: { title: string }[] };
  return copy.personal.map((document) => document.title);
}

/** The ids of the groups the relay copy under `key` holds, sorted. */
async function groupsOnRelay(fake: FakeRelay, key: Uint8Array): Promise<string[]> {
  const plaintext = await fetchRelayBackup(createRelay({ fetch: fake.fetch }), key);
  if (plaintext === null) throw new Error('Expected a relay copy.');
  const copy = JSON.parse(text(plaintext)) as { groups: { groupId: string }[] };
  return copy.groups.map((group) => group.groupId).sort();
}

/** The tags under `key` of groups `ids`, as Ana, sorted: what `uploadedGroups` notes (#327). */
function tagsOf(key: Uint8Array, ...ids: string[]): string[] {
  const { author } = testKeys('ana');
  return ids.map((id) => groupTagFor(key, id, author)).sort();
}

/** The backup requests the fake relay took, as their method. */
function backupCalls(fake: FakeRelay): string[] {
  return fake.requests
    .filter((request) => request.url.startsWith('/v1/backup/'))
    .map((request) => request.method);
}

/** The next relay day's first complete pass on `device`. */
async function nextDay(fake: FakeRelay, device: Device): Promise<void> {
  fake.minute += DAY;
  expect(await device.sync.syncOnce()).toBe(true);
}

/** A fetch whose GETs of a backup fail as an unreachable relay's do, while every other request goes through. */
function failingBackupReads(fetch: Fetch): Fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reading = (init?.method ?? 'GET') === 'GET' && url.includes('/v1/backup/');
    return reading ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init);
  };
}

/** Two devices with one backup key: Ana's phone, which made it, and her laptop, linked after. */
async function phoneAndLaptop(fake: FakeRelay, wrap?: (fetch: Fetch) => Fetch) {
  const phone = await openDevice(fake, 'phone');
  await found(phone);
  await startRelayBackup(phone.services);
  const laptop = await openDevice(fake, 'laptop', wrap);
  await linked(phone, laptop);
  return { phone, laptop, key: await keyOf(phone.store) };
}

/**
 * Ana's phone with one Document, 'Mine', and a relay backup, a day after
 * its first upload: the sync loop's own first changes (the encryption key
 * it posts, #98) are in, and a day with nothing changed uploads nothing.
 */
async function settledPhone(fake: FakeRelay): Promise<Device> {
  const phone = await openDevice(fake, 'phone');
  await found(phone);
  await phone.store.savePersonal(doc(A, 'Mine', TS, 1));
  await startRelayBackup(phone.services);
  await nextDay(fake, phone);
  const before = backupCalls(fake).length;
  await nextDay(fake, phone);
  expect(backupCalls(fake).slice(before)).toEqual(['GET']);
  return phone;
}

describe('the refresh merges the relay copy before it uploads (#247)', () => {
  it('reads the copy once each refresh day, before it writes, and uploads the union', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake);
    await phone.store.savePersonal(doc(A, 'Written on the phone', TS, 1));
    await laptop.store.savePersonal(doc(B, 'Written on the laptop', TS, 2));
    await nextDay(fake, phone);
    const before = backupCalls(fake).length;

    await nextDay(fake, laptop);
    expect(await laptop.sync.syncOnce()).toBe(true);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'PUT']);
    expect(await titlesOnRelay(fake, key)).toEqual([
      'Written on the phone',
      'Written on the laptop',
    ]);
  });

  it('leaves out a Document this device deleted, though the relay copy still holds it', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await openDevice(fake, 'phone');
    await found(phone);
    await phone.store.savePersonal(doc(A, 'Kept', TS, 1));
    await phone.store.savePersonal(doc(B, 'Deleted later', TS, 2));
    await startRelayBackup(phone.services);
    const key = await keyOf(phone.store);
    expect(await titlesOnRelay(fake, key)).toEqual(['Kept', 'Deleted later']);

    await phone.store.deletePersonal(B);
    await nextDay(fake, phone);

    expect(await titlesOnRelay(fake, key)).toEqual(['Kept']);
  });

  it('keeps it out even when a linked device’s upload, read before the delete, brings it back', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await openDevice(fake, 'phone');
    await found(phone);
    await phone.store.savePersonal(doc(A, 'Kept', TS, 1));
    await phone.store.savePersonal(doc(B, 'Deleted later', TS, 2));
    await startRelayBackup(phone.services);
    const key = await keyOf(phone.store);
    const stale = fake.backup(backupIdFor(key)) ?? new Uint8Array();
    await phone.store.deletePersonal(B);
    await nextDay(fake, phone);

    // The laptop read the copy before the delete, and its upload lands after the phone's.
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), Uint8Array.from(stale));
    expect(await titlesOnRelay(fake, key)).toEqual(['Kept', 'Deleted later']);
    await nextDay(fake, phone);

    expect(await titlesOnRelay(fake, key)).toEqual(['Kept']);
  });

  it('starts with the relay copy merged too, when the device already keeps a key', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake);
    await phone.store.savePersonal(doc(A, 'Written on the phone', TS, 1));
    await nextDay(fake, phone);
    const before = backupCalls(fake).length;

    expect(await startRelayBackup(laptop.services)).toBeNull();

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'PUT']);
    expect(await titlesOnRelay(fake, key)).toEqual(['Written on the phone']);
  });

  it('reads nothing first when it makes a new key, whose id holds nothing yet', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await openDevice(fake, 'phone');
    await found(phone);

    await startRelayBackup(phone.services);
    await startRelayBackup(phone.services, { newKey: true });

    expect(backupCalls(fake)).toEqual(['PUT', 'PUT']);
  });

  it('uploads nothing on a day neither device changed anything', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop } = await phoneAndLaptop(fake);
    await phone.store.savePersonal(doc(A, 'Written on the phone', TS, 1));
    await laptop.store.savePersonal(doc(B, 'Written on the laptop', TS, 2));
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    await nextDay(fake, phone);
    const before = backupCalls(fake).length;

    await nextDay(fake, laptop);
    await nextDay(fake, phone);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'GET']);
  });
});

describe('when the relay copy can’t be read, the device uploads its own, as before (#247)', () => {
  it('uploads its own copy when the read fails, and never blocks the upload', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake, failingBackupReads);
    await phone.store.savePersonal(doc(A, 'Written on the phone', TS, 1));
    await nextDay(fake, phone);
    await laptop.store.savePersonal(doc(B, 'Written on the laptop', TS, 2));

    await nextDay(fake, laptop);

    expect(await titlesOnRelay(fake, key)).toEqual(['Written on the laptop']);
    expect((await laptop.store.getRelayBackup())?.uploadedAt).toBe(TS);
  });

  it('uploads its own copy over one sealed under another key, and only once its own changed', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await settledPhone(fake);
    const key = await keyOf(phone.store);
    const foreign = sealRelayBackup(new Uint8Array(32).fill(0xf0), utf8('{"format":2}'));
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), foreign);
    const before = backupCalls(fake).length;

    // Nothing changed here: as before #247, nothing is uploaded over it.
    await nextDay(fake, phone);
    expect(backupCalls(fake).slice(before)).toEqual(['GET']);

    await phone.store.savePersonal(doc(B, 'Written later', TS, 2));
    await nextDay(fake, phone);
    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'GET', 'PUT']);
    expect(await titlesOnRelay(fake, key)).toEqual(['Mine', 'Written later']);
  });

  it('uploads its own copy over one its key opens but it can’t read, and only once its own changed', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await settledPhone(fake);
    const key = await keyOf(phone.store);
    // As a later app's copy, in a format this one doesn't read, would be.
    const later = sealRelayBackup(key, utf8('{"format":99,"personal":[]}'));
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), later);
    const before = backupCalls(fake).length;

    await nextDay(fake, phone);
    expect(backupCalls(fake).slice(before)).toEqual(['GET']);

    await phone.store.savePersonal(doc(B, 'Written later', TS, 2));
    await nextDay(fake, phone);
    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'GET', 'PUT']);
    expect(await titlesOnRelay(fake, key)).toEqual(['Mine', 'Written later']);
  });

  it('uploads again when the relay holds nothing under its id, though nothing changed', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await settledPhone(fake);
    const key = await keyOf(phone.store);
    const before = backupCalls(fake).length;

    // The relay keeps a backup 180 days after its last write; nothing changed meanwhile.
    fake.minute += 181 * DAY;
    expect(fake.backup(backupIdFor(key))).toBeUndefined();
    expect(await phone.sync.syncOnce()).toBe(true);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'PUT']);
    expect(await titlesOnRelay(fake, key)).toEqual(['Mine']);
  });
});

describe('a relay backup kept before #247', () => {
  it('takes the relay copy’s Documents as its own, so one it deleted meanwhile stays out', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const before = await openDevice(fake, 'phone');
    await found(before);
    await before.store.savePersonal(doc(A, 'Kept', TS, 1));
    await before.store.savePersonal(doc(B, 'Deleted after the last upload', TS, 2));
    await startRelayBackup(before.services);
    const key = await keyOf(before.store);
    expect((await before.store.getRelayBackup())?.uploaded).toEqual([A, B]);
    before.sync.stop();
    before.store.close();
    await withoutField('phone', 'uploaded');
    const phone = await openDevice(fake, 'phone');
    expect(await phone.store.getRelayBackup()).not.toHaveProperty('uploaded');

    await phone.store.deletePersonal(B);
    await nextDay(fake, phone);

    expect(await titlesOnRelay(fake, key)).toEqual(['Kept']);
    expect((await phone.store.getRelayBackup())?.uploaded).toEqual([A]);
  });
});

describe('the refresh keeps a group only the relay copy holds, and never one this device left (#327)', () => {
  it('carries a group joined on the other device after the link, never taking it in, and notes only its own tags', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake);
    const [first] = (await phone.store.listGroups()).map((group) => group.groupId);
    if (first === undefined) throw new Error('Expected the group both hold.');
    const joined = await found(phone, 'Allotment Society');
    await nextDay(fake, phone);

    await nextDay(fake, laptop);

    expect(await groupsOnRelay(fake, key)).toEqual([first, joined].sort());
    expect(await laptop.store.getGroup(joined)).toBeUndefined();
    const [laptopState, phoneState] = await Promise.all([
      laptop.store.getRelayBackup(),
      phone.store.getRelayBackup(),
    ]);
    expect(laptopState?.uploadedGroups).toEqual(tagsOf(key, first));
    expect(phoneState?.uploadedGroups).toEqual(tagsOf(key, first, joined));
    // A tag names no group: the record never holds a group's id.
    expect(JSON.stringify(phoneState?.uploadedGroups)).not.toContain(joined);
    expect(JSON.stringify(phoneState?.uploadedGroups)).not.toContain(first);
  });

  it('uploads nothing on a day neither device changed anything, with a group carried', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop } = await phoneAndLaptop(fake);
    await found(phone, 'Allotment Society');
    for (let day = 0; day < 3; day += 1) {
      await nextDay(fake, phone);
      await nextDay(fake, laptop);
    }
    const before = backupCalls(fake).length;

    await nextDay(fake, phone);
    await nextDay(fake, laptop);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'GET']);
  });

  it('uploads nothing more for a carried group whose entry moved only by when the other device last synced', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop } = await phoneAndLaptop(fake);
    await found(phone, 'Allotment Society');
    for (let day = 0; day < 3; day += 1) {
      await nextDay(fake, phone);
      await nextDay(fake, laptop);
    }
    // The laptop writes a Document, so the phone's next upload merges it, its groups only synced since.
    await laptop.store.savePersonal(doc(B, 'Written on the laptop', TS, 2));
    await nextDay(fake, laptop);
    await nextDay(fake, phone);
    const before = backupCalls(fake).length;

    await nextDay(fake, laptop);

    expect(backupCalls(fake).slice(before)).toEqual(['GET']);
  });

  it('uploads again when a linked device’s late upload lacks a group it holds, though nothing changed here', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, key } = await phoneAndLaptop(fake);
    const without = Uint8Array.from(fake.backup(backupIdFor(key)) ?? []);
    const joined = await found(phone, 'Allotment Society');
    await nextDay(fake, phone);
    await nextDay(fake, phone);
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), without);
    expect(await groupsOnRelay(fake, key)).not.toContain(joined);
    const before = backupCalls(fake).length;

    await nextDay(fake, phone);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'PUT']);
    expect(await groupsOnRelay(fake, key)).toContain(joined);
  });

  it('leaves out a group it holds as a read-only copy (#108), and once removed, even from a late upload that brings it back', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake);
    const joined = await found(phone, 'Allotment Society');
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    const stale = Uint8Array.from(fake.backup(backupIdFor(key)) ?? []);

    await phone.store.markArchived(joined, 'dissolved');
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    expect(await groupsOnRelay(fake, key)).not.toContain(joined);

    // Remove from this device, then the laptop's late upload lands: the same day's next pass reads again.
    await phone.store.purgeGroup(joined);
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), stale);
    const before = backupCalls(fake).length;
    expect(await phone.sync.syncOnce()).toBe(true);

    expect(backupCalls(fake).slice(before)).toEqual(['GET', 'PUT']);
    expect(await groupsOnRelay(fake, key)).not.toContain(joined);
    await nextDay(fake, laptop);
    expect(await groupsOnRelay(fake, key)).not.toContain(joined);
  });

  it('lets a group’s tag go once a read finds the copy without it, so nothing on the device marks it', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await openDevice(fake, 'phone');
    const first = await found(phone);
    const left = await found(phone, 'Allotment Society');
    await startRelayBackup(phone.services);
    const key = await keyOf(phone.store);
    expect((await phone.store.getRelayBackup())?.uploadedGroups).toEqual(tagsOf(key, first, left));

    await phone.store.purgeGroup(left);
    expect(await phone.sync.syncOnce()).toBe(true);
    // The copy it read still held the group, so a late upload could bring it back: the tag stays.
    expect(await groupsOnRelay(fake, key)).toEqual([first]);
    expect((await phone.store.getRelayBackup())?.uploadedGroups).toEqual(tagsOf(key, first, left));

    await nextDay(fake, phone);
    expect((await phone.store.getRelayBackup())?.uploadedGroups).toEqual(tagsOf(key, first));
  });

  it('keeps every tag, and uploads its own groups as before, when it can’t read the copy', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const phone = await openDevice(fake, 'phone', failingBackupReads);
    const first = await found(phone);
    const left = await found(phone, 'Allotment Society');
    await startRelayBackup(phone.services);
    const key = await keyOf(phone.store);

    await phone.store.purgeGroup(left);
    expect(await phone.sync.syncOnce()).toBe(true);
    await nextDay(fake, phone);

    expect(await groupsOnRelay(fake, key)).toEqual([first]);
    expect((await phone.store.getRelayBackup())?.uploadedGroups).toEqual(tagsOf(key, first, left));
  });

  it('carries nothing on the first upload of a state kept before #327, then carries as it should', async () => {
    const fake = createFakeRelay({ minute: NOON });
    const { phone, laptop, key } = await phoneAndLaptop(fake);
    const [first] = (await laptop.store.listGroups()).map((group) => group.groupId);
    if (first === undefined) throw new Error('Expected the group both hold.');
    const joined = await found(phone, 'Allotment Society');
    await nextDay(fake, phone);
    laptop.sync.stop();
    laptop.store.close();
    await withoutField('laptop', 'uploadedGroups');
    const before = await openDevice(fake, 'laptop');
    expect(await before.store.getRelayBackup()).not.toHaveProperty('uploadedGroups');

    // It can't tell a group it left from one the phone joined, so it keeps only its own, as before.
    await nextDay(fake, before);
    expect(await groupsOnRelay(fake, key)).toEqual([first]);
    expect((await before.store.getRelayBackup())?.uploadedGroups).toEqual(tagsOf(key, first));
    await nextDay(fake, phone);
    await nextDay(fake, before);

    expect(await groupsOnRelay(fake, key)).toEqual([first, joined].sort());
  });
});

/** Opens the IndexedDB database `name` as it is, with no upgrade. */
function rawDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Expected the database.'));
    };
  });
}

/**
 * Rewrites database `name`'s relay backup record without `field`, as an app
 * from before #247 kept it (`uploaded`), or from before #327 (`uploadedGroups`).
 */
async function withoutField(name: string, field: 'uploaded' | 'uploadedGroups'): Promise<void> {
  const db = await rawDatabase(name);
  const tx = db.transaction('device', 'readwrite');
  const records = tx.objectStore('device');
  const read = records.get('relay-backup');
  await new Promise<void>((resolve, reject) => {
    read.onsuccess = () => {
      const record = Object.fromEntries(
        Object.entries(read.result as Record<string, unknown>).filter(([name]) => name !== field),
      );
      records.put(record, 'relay-backup');
    };
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Expected the write.'));
    };
  });
  db.close();
}
