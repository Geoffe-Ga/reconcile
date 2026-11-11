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
 * Everything runs through the app's real services on one fake relay: the
 * link's whole handshake, each device's sync loop with its daily refresh,
 * and the restore that recovery (#118) runs, `fetchRelayBackup` then
 * `importSnapshot`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { shareChannelOf } from '../crypto/share';
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
import { importSnapshot } from '../store/snapshot';
import { TEST_NOW, testDevice, type TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { linkDevice } from '../test/link';
import { members } from '../test/members';

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
 * Its clock reads `now`.
 */
async function restoredFrom(fake: FakeRelay, key: Uint8Array, now = TEST_NOW): Promise<TestDevice> {
  const device = await testDevice(fake, `restored-${String(opened.length)}`, () => now);
  opened.push(device);
  const plaintext = await fetchRelayBackup(device.services.relay, key);
  if (plaintext === null) throw new Error('Expected the relay copy.');
  await importSnapshot(device.services.store, plaintext);
  return device;
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
    const restored = await restoredFrom(fake, key);
    const held = await restored.services.store.getPersonal(STATEMENT.id);
    expect(held).toEqual({ ...edited, share: { ...phoneShare, pending: true, paused: true } });
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
