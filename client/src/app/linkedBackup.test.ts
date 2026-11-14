/**
 * Two linked devices keep one relay backup (#247): Ana's phone keeps a
 * relay backup (#97), and her laptop, linked to it by scanning a code (#96),
 * takes its key, so both refresh the same relay copy. Each keeps its own
 * personal Documents (#93) after the link, so before each upload a device
 * merges the relay copy's into its own, and a device restored from the copy
 * after both are lost gets every Document either wrote, the later edit of
 * one both edited, and the share by link (#105) the phone made, which it
 * can then stop.
 *
 * Joins don't travel between linked devices either (#327): a group the phone
 * joins after the link stays on the phone. So the laptop carries the relay
 * copy's entry for it through its own uploads, sealed as it was, without
 * ever taking it in, and a restore brings it back whichever device uploaded
 * last. Once the phone leaves it, it stays out of the copy for good, even
 * when the phone is erased the same day.
 *
 * Someone else holding the backup key could plant a group entry in the copy
 * that doesn't check out (#336). A restore leaves it out, brings back every
 * other group and Document, and says how many it left out, and the laptop's
 * next upload leaves it out too, so it isn't carried for good.
 *
 * Everything runs through the app's real services on one fake relay: the
 * link's whole handshake, each device's sync loop with its daily refresh,
 * and the restore that recovery (#118) runs, `fetchRelayBackup` then
 * `importSnapshot`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { backupIdFor, sealRelayBackup } from '../crypto/relayBackup';
import { shareChannelOf } from '../crypto/share';
import { createRelay } from '../net/relay';
import {
  keepSharesAlive,
  readShare,
  SHARE_TTL_DAYS,
  type ShareLink,
  startSharing,
  stopSharing,
} from '../share/shareLink';
import type { PersonalDocument } from '../store/personal';
import { fetchRelayBackup, startRelayBackup } from '../store/relayBackup';
import { importSnapshot, type Restored } from '../store/snapshot';
import { TEST_NOW, testDevice, type TestDevice } from '../test/appServices';
import { local, text, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { linkDevice } from '../test/link';
import { members } from '../test/members';
import { LEVELS } from '../engine/capabilities';
import { createGroup, joinGroup, leaveGroup, lookupInvite, makeInvite } from './actions';
import { parseInviteLink } from './invite';

freshIndexedDBPerTest();

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

/** Minutes in a relay day. */
const DAY = 1440;

/** A statement both devices hold, since the phone wrote it before the link. */
const STATEMENT: PersonalDocument = {
  id: 'TGlua2VkIHN0YXRlbWVudA',
  title: 'What I stand for',
  text: 'I show up for my neighbors.\n',
  createdAt: 1_762_000_400_000,
  updatedAt: 1_762_000_500_000,
};

/** A Document written on one device after the link, `minutes` after the statement. */
function writtenLater(id: string, title: string, minutes: number): PersonalDocument {
  const at = STATEMENT.updatedAt + minutes * 60_000;
  return { id, title, text: `${title}, written on one device.\n`, createdAt: at, updatedAt: at };
}

/**
 * Ana's phone in a group of her own, holding the statement, with a relay
 * backup, then her laptop linked to it: both keep the same backup key.
 */
async function phoneAndLaptop(fake: FakeRelay): Promise<{ phone: TestDevice; laptop: TestDevice }> {
  const { devices } = await members(fake, ['Ana']);
  const [phone] = devices;
  if (phone === undefined) throw new Error('Expected Ana’s phone.');
  opened.push(phone);
  await phone.services.store.savePersonal(STATEMENT);
  await startRelayBackup(phone.services);
  const laptop = await linkDevice(fake, phone, 'ana-laptop');
  opened.push(laptop);
  const [phoneKey, laptopKey] = await Promise.all([keyOf(phone), keyOf(laptop)]);
  expect(laptopKey).toEqual(phoneKey);
  return { phone, laptop };
}

/** The relay backup key `device` keeps. */
async function keyOf(device: TestDevice): Promise<Uint8Array> {
  const state = await device.services.store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

/** The first complete sync pass of the next relay day on `device`, which runs its daily refresh. */
async function nextDay(fake: FakeRelay, device: TestDevice): Promise<void> {
  fake.minute += DAY;
  expect(await device.services.sync.syncOnce()).toBe(true);
}

/**
 * A new device that restores the relay copy under `key` after every other
 * device is lost, as recovery (#118) does: it reads the copy, then keeps it.
 * Its clock reads `now`. Returns the device and what the restore said it
 * brought back (#336).
 */
async function restoring(
  fake: FakeRelay,
  key: Uint8Array,
  now = TEST_NOW,
): Promise<{ device: TestDevice; restored: Restored }> {
  const device = await testDevice(fake, `restored-${String(opened.length)}`, () => now);
  opened.push(device);
  const plaintext = await fetchRelayBackup(device.services.relay, key);
  if (plaintext === null) throw new Error('Expected the relay copy.');
  const restored = await importSnapshot(device.services.store, plaintext);
  return { device, restored };
}

/** The device {@link restoring} restores, its clock reading `now`. */
async function restoredFrom(fake: FakeRelay, key: Uint8Array, now = TEST_NOW): Promise<TestDevice> {
  return (await restoring(fake, key, now)).device;
}

/** The titles of `device`'s personal Documents, oldest first. */
async function titles(device: TestDevice): Promise<string[]> {
  return (await device.services.store.listPersonal()).map((document) => document.title);
}

describe('two linked devices and one relay backup (#247)', () => {
  it('keeps a Document written on each device, whichever refreshes last, and a restore brings both back', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    await phone.services.store.savePersonal(
      writtenLater('UGhvbmUgb25seSBub3RlIQ', 'On the phone', 1),
    );
    await laptop.services.store.savePersonal(
      writtenLater('TGFwdG9wIG9ubHkgbm90ZQ', 'On the laptop', 2),
    );

    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    const all = ['What I stand for', 'On the phone', 'On the laptop'];
    expect(await titles(await restoredFrom(fake, key))).toEqual(all);

    // The phone refreshes last now, with a change of its own: the laptop's Document stays.
    await phone.services.store.savePersonal({ ...STATEMENT, updatedAt: STATEMENT.updatedAt + 1 });
    await nextDay(fake, phone);
    expect(await titles(await restoredFrom(fake, key))).toEqual(all);
    // Neither device took in the other's Document: personal Documents still don't sync.
    expect(await titles(phone)).toEqual(['What I stand for', 'On the phone']);
    expect(await titles(laptop)).toEqual(['What I stand for', 'On the laptop']);
  });

  it('keeps the later edit of a Document edited on both, whichever device uploads first', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    const earlier = {
      ...STATEMENT,
      text: 'Edited on the phone first.\n',
      updatedAt: STATEMENT.updatedAt + 60_000,
    };
    const later = {
      ...STATEMENT,
      text: 'Edited on the laptop after.\n',
      updatedAt: STATEMENT.updatedAt + 120_000,
    };
    await phone.services.store.savePersonal(earlier);
    await laptop.services.store.savePersonal(later);

    // The later edit goes up first; the phone's refresh then keeps it over its own earlier one.
    await nextDay(fake, laptop);
    await nextDay(fake, phone);
    const restored = await restoredFrom(fake, key);
    expect(await restored.services.store.getPersonal(STATEMENT.id)).toEqual(later);

    // And the other way about: the phone edits last, so its edit wins, whoever uploads last.
    const latest = {
      ...STATEMENT,
      text: 'Edited on the phone last.\n',
      updatedAt: later.updatedAt + 60_000,
    };
    await phone.services.store.savePersonal(latest);
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    const again = await restoredFrom(fake, key);
    expect(await again.services.store.getPersonal(STATEMENT.id)).toEqual(latest);
  });

  it('keeps the phone’s share by link in the laptop’s upload, so a restored device can stop the link', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    const outcome = await startSharing(phone.services, STATEMENT.id);
    if (outcome.kind !== 'shared') throw new Error(`Expected a share, not ${outcome.kind}.`);
    const link: ShareLink = outcome.link;
    const phoneShare = (await phone.services.store.getPersonal(STATEMENT.id))?.share;
    // The laptop edits the statement later, where it holds no share (the link left it out).
    const edited = {
      ...STATEMENT,
      text: 'Edited on the laptop.\n',
      updatedAt: STATEMENT.updatedAt + 60_000,
    };
    await laptop.services.store.savePersonal(edited);
    expect((await laptop.services.store.getPersonal(STATEMENT.id))?.share).toBeUndefined();

    await nextDay(fake, phone);
    await nextDay(fake, laptop);

    // The later copy holds no share, so it keeps the phone's, marked pending; restored, it's paused (#328).
    // No backup carries the phone's own reading of the relay's clock (#347), so it comes back without one.
    const { seenAt, ...carried } = phoneShare ?? {};
    expect(seenAt).toBeDefined();
    const restored = await restoredFrom(fake, key);
    const held = await restored.services.store.getPersonal(STATEMENT.id);
    expect(held).toEqual({ ...edited, share: { ...carried, pending: true, paused: true } });
    expect(local(held?.share?.seed ?? new Uint8Array())).toEqual(local(link.seed));
    expect(await stopSharing(restored.services, STATEMENT.id)).toBe('stopped');
    expect(await readShare(phone.services, link)).toEqual({ kind: 'gone' });
  });

  it('pauses a share the phone stopped, which the copy still holds, so a restore after its tombstone lapses posts nothing (#328)', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    const outcome = await startSharing(phone.services, STATEMENT.id);
    if (outcome.kind !== 'shared') throw new Error(`Expected a share, not ${outcome.kind}.`);
    const { mailbox } = shareChannelOf(outcome.link.seed);
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    expect(await stopSharing(phone.services, STATEMENT.id)).toBe('stopped');
    // The phone can't tell the laptop's copy of its share from a linked device's live link (#247).
    await nextDay(fake, phone);

    // Both devices are lost, and recovery runs once the tombstone has lapsed at the relay.
    const lapsed = SHARE_TTL_DAYS + 2;
    fake.minute += lapsed * DAY;
    expect(fake.blobs(mailbox)).toEqual([]);
    const restored = await restoredFrom(fake, key, TEST_NOW + lapsed * DAY * 60_000);
    const posts = fake.requests.filter(({ url }) => url.startsWith(`/v1/mailbox/${mailbox}?`));

    expect((await restored.services.store.getPersonal(STATEMENT.id))?.share?.paused).toBe(true);
    expect(await keepSharesAlive(restored.services)).toEqual([]);
    expect(fake.requests.filter(({ url }) => url.startsWith(`/v1/mailbox/${mailbox}?`))).toEqual(
      posts,
    );
    expect(await readShare(restored.services, outcome.link)).toEqual({ kind: 'gone' });
  });
});

/** The level Ana joins Bea's group at: the creating level, as the test helpers join. */
const [, , CREATING] = LEVELS;

/** The ids of the groups `device` holds, sorted. */
async function groupIds(device: TestDevice): Promise<string[]> {
  return (await device.services.store.listGroups()).map((group) => group.groupId).sort();
}

/** `ids`, sorted, as {@link groupIds} lists them. */
function sorted(...ids: string[]): string[] {
  return ids.sort();
}

/**
 * Bea founds a group on a device of her own, and Ana's phone joins it from
 * Bea's invite, after the phone and laptop linked: the laptop never holds it.
 */
async function joinedOnThePhone(fake: FakeRelay, phone: TestDevice): Promise<string> {
  const bea = await testDevice(fake, 'bea');
  opened.push(bea);
  const created = await createGroup(bea.services, {
    groupName: 'Allotment Society',
    yourName: 'Bea',
    documents: [{ title: 'Plot rules', text: 'Water before nine.' }],
    chat: null,
  });
  if (created.outcome !== 'created') throw new Error('Expected Bea’s group.');
  await bea.services.sync.syncOnce();
  const seed = parseInviteLink(await makeInvite(bea.services, created.groupId, 'https://r.test'));
  if (seed === null) throw new Error('Expected an invite link.');
  const found = await lookupInvite(phone.services, seed);
  if (found.kind !== 'found') throw new Error('Expected the invite to open.');
  await joinGroup(phone.services, found.group, 'Ana', CREATING);
  expect(await phone.services.sync.syncOnce()).toBe(true);
  return created.groupId;
}

/** The ids of the groups a device restored from the relay copy under `key` holds. */
async function restoredGroups(fake: FakeRelay, key: Uint8Array): Promise<string[]> {
  return groupIds(await restoredFrom(fake, key));
}

describe('a group joined on one linked device after the link (#327)', () => {
  it.each([
    ['the laptop', 'phone', 'laptop'],
    ['the phone', 'laptop', 'phone'],
  ] as const)(
    'comes back in a restore when %s uploads last, and the laptop never takes it in',
    async (_, first, last) => {
      const fake = createFakeRelay();
      const devices = await phoneAndLaptop(fake);
      const { phone, laptop } = devices;
      const key = await keyOf(phone);
      const founded = await groupIds(phone);
      const joined = await joinedOnThePhone(fake, phone);
      expect(await groupIds(laptop)).toEqual(founded);

      await nextDay(fake, devices[first]);
      await nextDay(fake, devices[last]);
      expect(await restoredGroups(fake, key)).toEqual(sorted(...founded, joined));

      // A day later, the first refreshes last: still there.
      await nextDay(fake, devices[first]);
      expect(await restoredGroups(fake, key)).toEqual(sorted(...founded, joined));
      // The laptop carried it through sealed, and never held, read or synced it.
      expect(await groupIds(laptop)).toEqual(founded);
      expect(await laptop.services.store.getGroup(joined)).toBeUndefined();
    },
  );

  it('stays out once the phone leaves it, even when the laptop’s late upload brings it back', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    const founded = await groupIds(phone);
    const joined = await joinedOnThePhone(fake, phone);
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    await nextDay(fake, phone);
    // The laptop read the copy before the leave, and its upload lands after it.
    const stale = Uint8Array.from(fake.backup(backupIdFor(key)) ?? []);

    // Later on the phone's refresh day, it leaves: the leave's own pass takes the group out.
    await leaveGroup(phone.services, joined);
    expect(await phone.services.sync.syncOnce()).toBe(true);
    expect(await groupIds(phone)).toEqual(founded);
    expect(await restoredGroups(fake, key)).toEqual(founded);
    await createRelay({ fetch: fake.fetch }).putBackup(backupIdFor(key), stale);
    expect(await restoredGroups(fake, key)).toEqual(sorted(...founded, joined));

    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    expect(await restoredGroups(fake, key)).toEqual(founded);
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    expect(await restoredGroups(fake, key)).toEqual(founded);
  });

  it('stays out when the phone leaves it and is erased the same day', async () => {
    const fake = createFakeRelay();
    const { phone, laptop } = await phoneAndLaptop(fake);
    const key = await keyOf(phone);
    const founded = await groupIds(phone);
    const joined = await joinedOnThePhone(fake, phone);
    await nextDay(fake, phone);
    await nextDay(fake, laptop);
    await nextDay(fake, phone);

    // Later on the phone's refresh day, it leaves, and then Erase deletes everything on it.
    await leaveGroup(phone.services, joined);
    expect(await phone.services.sync.syncOnce()).toBe(true);
    await erased(phone, 'ana');

    await nextDay(fake, laptop);
    expect(await restoredGroups(fake, key)).toEqual(founded);
  });
});

/**
 * Erases `device`, whose database is `name`, as Erase does (#78): its sync
 * loop halted and its store closed, then its database deleted, with nothing
 * sent. Erase itself deletes every database the origin holds, which here
 * would take the other devices' too.
 */
async function erased(device: TestDevice, name: string): Promise<void> {
  await device.services.sync.halt();
  device.services.store.close();
  opened.splice(opened.indexOf(device), 1);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Expected ${name} to go.`));
    };
  });
}

/**
 * A group entry someone else holding the backup key could plant in the relay
 * copy (#336): its id and author are well formed, so a linked device's carry
 * reads them (#327), and nothing else in it is, so no restore can keep it.
 */
const PLANTED = {
  groupId: base64url(new Uint8Array(32).fill(0x50)),
  me: { author: base64url(new Uint8Array(32).fill(0x51)), name: 'Planted' },
  log: 'not a log',
};

/**
 * Puts `entry` into the relay copy under `key`, after its first group, and
 * seals it again, as anyone else holding the key could.
 */
async function plant(fake: FakeRelay, key: Uint8Array, entry: unknown): Promise<void> {
  const relay = createRelay({ fetch: fake.fetch });
  const plaintext = await fetchRelayBackup(relay, key);
  if (plaintext === null) throw new Error('Expected the relay copy.');
  const copy = JSON.parse(text(plaintext)) as { groups: unknown[] };
  const [first, ...rest] = copy.groups;
  const groups = [first, entry, ...rest];
  await relay.putBackup(
    backupIdFor(key),
    sealRelayBackup(key, utf8(JSON.stringify({ ...copy, groups }))),
  );
}

describe('a group entry planted in the relay copy that doesn’t check out (#336)', () => {
  it.each([
    ['with a well-formed id and author', PLANTED],
    ['that isn’t a group entry at all', 'not a group'],
  ])(
    'is left out of a restore, which brings back the rest and says so, and of the laptop’s next upload: %s',
    async (_, entry) => {
      const fake = createFakeRelay();
      const { phone, laptop } = await phoneAndLaptop(fake);
      const key = await keyOf(phone);
      const founded = await groupIds(phone);
      const joined = await joinedOnThePhone(fake, phone);
      await nextDay(fake, phone);
      await nextDay(fake, laptop);
      const all = sorted(...founded, joined);
      await plant(fake, key, entry);

      const { device, restored } = await restoring(fake, key);
      expect(restored).toEqual({ groups: 2, skipped: 1, skippedDocuments: 0 });
      expect(await groupIds(device)).toEqual(all);
      expect(await titles(device)).toEqual(['What I stand for']);

      // The laptop holds neither the planted group nor the phone's join: it carries the join, not the plant.
      await nextDay(fake, laptop);
      expect((await restoring(fake, key)).restored).toEqual({
        groups: 2,
        skipped: 0,
        skippedDocuments: 0,
      });
      await nextDay(fake, phone);
      const again = await restoring(fake, key);
      expect(again.restored).toEqual({ groups: 2, skipped: 0, skippedDocuments: 0 });
      expect(await groupIds(again.device)).toEqual(all);
    },
  );
});
