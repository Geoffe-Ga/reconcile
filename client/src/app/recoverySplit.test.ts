/**
 * The backup key and the recovery plan travel together (#272): one person's
 * latest choice of recovery contacts wins on every device that holds the key
 * it replaced.
 *
 * Ana's phone chooses Ben, Cal and Dee, and her laptop, linked to it (#96),
 * takes the phone's backup key and the split it was cut into, never the
 * contacts. When the phone chooses again, it overwrites the old key's relay
 * backup with random bytes, as before (#109). The laptop reads that id before
 * its next upload, finds no backup there, and stops: it forgets the old key
 * and never refreshes the backup the old shares open. The phone keeps the old
 * id overwritten, so a laptop upload that lands just after the overwrite, or
 * a device that comes back after the relay forgot it, is overwritten again
 * the next relay day. A device restored from a backup file (#78) holds the
 * file's key and split, and its first choice of contacts makes a key of its
 * own, retiring the file's, which the phone then stops refreshing.
 *
 * Everything runs through the app's real services on one fake relay: the
 * link's handshake, each device's sync loop with its daily refresh and
 * retired-id upkeep, and a passphrase backup file.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { backupIdFor, openRelayBackup, sealRelayBackup } from '../crypto/relayBackup';
import { combineShares, type RecoveryShare } from '../crypto/shares';
import { createRelay } from '../net/relay';
import { chooseContacts, openHeldShare, type RecoveryChoice } from '../store/recovery';
import { deviceSnapshot, encodeSnapshot, exportGroups, importGroups } from '../store/snapshot';
import { testDevice, type TestDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { linkDevice } from '../test/link';
import { members } from '../test/members';

freshIndexedDBPerTest();

/**
 * Each test runs four or five real devices: real stores, sync passes, relay
 * backups and crypto on the fake relay, which take longer than the default
 * 5 seconds on a busy machine.
 */
const DEVICES = { timeout: 30_000 };

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Minutes in a relay day. */
const DAY = 1440;

/** A passphrase for the backup file: long enough, and a cheap scrypt in tests. */
const PASSPHRASE = 'correct horse battery staple';

/** Ana's group with Ben, Cal and Dee, every device synced; Ana's device is her phone. */
async function anasGroup(fake: FakeRelay) {
  const made = await members(fake, ['Ana', 'Ben', 'Cal', 'Dee']);
  opened.push(...made.devices);
  const [phone, ben, cal, dee] = made.devices;
  if (phone === undefined || ben === undefined || cal === undefined || dee === undefined) {
    throw new Error('Expected four devices.');
  }
  return { groupId: made.groupId, phone, ben, cal, dee, everyone: made.devices };
}

/** The choice of `people` in `groupId`, 2 needed. */
async function twoOf(groupId: string, people: readonly TestDevice[]): Promise<RecoveryChoice> {
  const contacts = await Promise.all(
    people.map(async (person) => ({ groupId, member: await authorOn(person, groupId) })),
  );
  return { t: 2, contacts };
}

/** `device`'s member key in `groupId`. */
async function authorOn(device: TestDevice, groupId: string): Promise<string> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on the device.');
  return group.me.author;
}

/** Syncs each device once, then once more, so each sees what the others sent. */
async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await device.services.sync.syncOnce();
  for (const device of devices) await device.services.sync.syncOnce();
}

/** The relay backup key `device` keeps. */
async function keyOf(device: TestDevice): Promise<Uint8Array> {
  const state = await device.services.store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

/** The share `holder` holds from `author` in `groupId`, opened. */
async function shareFrom(
  holder: TestDevice,
  groupId: string,
  author: string,
): Promise<RecoveryShare> {
  const group = await holder.services.store.getGroup(groupId);
  const share = group === undefined ? null : openHeldShare(group, author);
  if (share === null) throw new Error('Expected a held share.');
  return share;
}

/** Moves the fake relay's clock on a day, then runs one complete sync pass on each device in turn. */
async function nextDay(fake: FakeRelay, devices: readonly TestDevice[]): Promise<void> {
  fake.minute += DAY;
  for (const device of devices) expect(await device.services.sync.syncOnce()).toBe(true);
}

/** Whether the relay holds a backup under `key`'s id that `key` opens: what old shares would restore. */
function opensUnder(fake: FakeRelay, key: Uint8Array): boolean {
  const blob = fake.backup(backupIdFor(key));
  return blob !== undefined && openRelayBackup(key, blob) !== null;
}

describe('a linked device after the person chooses contacts again (#272)', DEVICES, () => {
  it('takes the key and its split, never the contacts, then stops once the old key is retired', async () => {
    const fake = createFakeRelay();
    const { groupId, phone, ben, cal, dee, everyone } = await anasGroup(fake);
    const author = await authorOn(phone, groupId);
    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll(everyone);
    const plan = await phone.services.store.getRecoveryPlan();
    if (plan === undefined) throw new Error('Expected the phone’s plan.');

    const laptop = await linkDevice(fake, phone, 'ana-laptop');
    opened.push(laptop);
    const oldKey = await keyOf(phone);
    expect(await keyOf(laptop)).toEqual(oldKey);
    // The link carries the split the key was cut into, and no contact.
    expect((await laptop.services.store.getRelayBackup())?.split).toBe(plan.split);
    expect(await laptop.services.store.getRecoveryPlan()).toBeUndefined();
    const oldShares = [
      await shareFrom(ben, groupId, author),
      await shareFrom(cal, groupId, author),
    ];

    await chooseContacts(phone.services, await twoOf(groupId, [ben, dee, cal]));
    await syncAll([phone, ben, cal, dee]);
    expect(await keyOf(phone)).not.toEqual(oldKey);
    expect(opensUnder(fake, oldKey)).toBe(false);

    // The laptop's next refresh finds the old id overwritten, and stops for good.
    await nextDay(fake, [laptop]);
    expect(await laptop.services.store.getRelayBackup()).toBeUndefined();
    expect(await laptop.services.store.getRelayBackupRetiredAt()).toBe(laptop.services.now());
    expect((await deviceSnapshot(laptop.services.store)).backupKey).toBeUndefined();
    for (let day = 0; day < 3; day += 1) {
      await nextDay(fake, [laptop, phone]);
      expect(opensUnder(fake, oldKey)).toBe(false);
    }

    // The old contacts' shares still rebuild the old key, which opens no backup.
    const rebuilt = await combineShares(oldShares.map(({ share }) => share));
    expect(local(rebuilt ?? new Uint8Array())).toEqual(oldKey);
    expect(opensUnder(fake, oldKey)).toBe(false);
  });

  it('overwrites the old id again the next relay day when the laptop’s upload lands just after the overwrite', async () => {
    const fake = createFakeRelay();
    const { groupId, phone, ben, cal, dee, everyone } = await anasGroup(fake);
    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll(everyone);
    const laptop = await linkDevice(fake, phone, 'ana-laptop');
    opened.push(laptop);
    const oldKey = await keyOf(phone);
    const laptopCopy = encodeSnapshot(await deviceSnapshot(laptop.services.store));

    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll([phone, ben, cal, dee]);
    // The laptop read the old id before the overwrite, and its upload lands after it.
    const relay = createRelay({ fetch: fake.fetch });
    await relay.putBackup(backupIdFor(oldKey), sealRelayBackup(oldKey, laptopCopy));
    expect(opensUnder(fake, oldKey)).toBe(true);

    // The phone's next complete pass of a new relay day overwrites it again.
    await nextDay(fake, [phone]);
    expect(opensUnder(fake, oldKey)).toBe(false);
    // The laptop's next refresh then finds it retired, and never uploads under it again.
    await nextDay(fake, [laptop]);
    expect(await laptop.services.store.getRelayBackup()).toBeUndefined();
    await nextDay(fake, [laptop, phone]);
    expect(opensUnder(fake, oldKey)).toBe(false);
  });

  it('keeps the old id overwritten after the relay forgets it, so a device back after 180 days finds it retired', async () => {
    const fake = createFakeRelay();
    const { groupId, phone, ben, cal, dee, everyone } = await anasGroup(fake);
    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll(everyone);
    const laptop = await linkDevice(fake, phone, 'ana-laptop');
    opened.push(laptop);
    // The laptop hears from the group once, then goes unused while the phone chooses again.
    await nextDay(fake, [laptop]);
    const oldKey = await keyOf(phone);
    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll([phone, ben, cal, dee]);

    // The relay keeps a backup 180 days after its last write; the phone keeps the old id written.
    fake.minute += 200 * DAY;
    await nextDay(fake, [phone]);
    expect(fake.backup(backupIdFor(oldKey))).toHaveLength(65536);
    // The laptop, away all that time, finds the old id retired, not empty.
    await nextDay(fake, [laptop]);
    expect(await laptop.services.store.getRelayBackup()).toBeUndefined();
    expect(opensUnder(fake, oldKey)).toBe(false);
  });
});

describe('a device restored from a backup file (#272)', DEVICES, () => {
  it('holds the file’s key and split, and its first choice makes a key of its own, which the phone then gives way to', async () => {
    const fake = createFakeRelay();
    const { groupId, phone, ben, cal, dee, everyone } = await anasGroup(fake);
    await chooseContacts(phone.services, await twoOf(groupId, [ben, cal, dee]));
    await syncAll(everyone);
    const plan = await phone.services.store.getRecoveryPlan();
    const fileKey = await keyOf(phone);
    const { file } = await exportGroups(phone.services.store, PASSPHRASE, 4);

    const restored = await testDevice(fake, 'ana-restored');
    opened.push(restored);
    await importGroups(restored.services.store, file, PASSPHRASE);
    await restored.services.sync.syncOnce();
    expect(await keyOf(restored)).toEqual(fileKey);
    // The file carries the split the key was cut into, and no contact.
    expect((await restored.services.store.getRelayBackup())?.split).toBe(plan?.split);
    expect(await restored.services.store.getRecoveryPlan()).toBeUndefined();

    // Other copies of the file hold its key, so the first choice here makes a new one.
    await chooseContacts(restored.services, await twoOf(groupId, [ben, cal, dee]));
    const ownKey = await keyOf(restored);
    expect(ownKey).not.toEqual(fileKey);
    expect(opensUnder(fake, fileKey)).toBe(false);
    expect(opensUnder(fake, ownKey)).toBe(true);
    expect((await restored.services.store.getRelayBackup())?.split).toBe(
      (await restored.services.store.getRecoveryPlan())?.split,
    );

    // The phone's next refresh finds its key retired: the latest choice wins, and its plan says so.
    await nextDay(fake, [phone]);
    expect(await phone.services.store.getRelayBackup()).toBeUndefined();
    expect((await phone.services.store.getRecoveryPlan())?.supersededAt).toBe(phone.services.now());
    await nextDay(fake, [phone, restored]);
    expect(opensUnder(fake, fileKey)).toBe(false);
    expect(opensUnder(fake, ownKey)).toBe(true);
  });
});
