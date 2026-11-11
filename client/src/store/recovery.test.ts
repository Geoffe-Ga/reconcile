/**
 * Recovery contacts (#109) across real devices: each a real store on
 * fake-indexeddb with the real sync loop, the real seal and the real relay
 * backup, on one fake relay, set up through the app's own Create group and
 * Join. Ana chooses contacts from her group; each contact's device opens
 * only the share sealed to it; nobody else, and nothing the relay keeps,
 * holds a share, the key or the list in the clear; and choosing again
 * leaves every older share opening nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { leaveGroup } from '../app/actions';
import { fromBase64url } from '../crypto/base64url';
import { backupIdFor, openRelayBackup } from '../crypto/relayBackup';
import { combineShares, type RecoveryShare } from '../crypto/shares';
import { fold } from '../engine/fold';
import { local } from '../test/bytes';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { foundAnother, joinLater, members } from '../test/members';
import { findCanaries, keyCanaries, textCanary, type Canary } from '../test/scan';
import type { Group } from './db';
import {
  chooseContacts,
  contactGroups,
  heldShares,
  heldSharesIn,
  openHeldShare,
  afterSyncPass,
  type RecoveryChoice,
  recoveryStatus,
} from './recovery';
import { fetchRelayBackup } from './relayBackup';

freshIndexedDBPerTest();

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Ana's group, joined by everyone named after her, every device synced. */
async function group(names: readonly string[], fake: FakeRelay = createFakeRelay()) {
  const made = await members(fake, names);
  opened.push(...made.devices);
  const byName = new Map(names.map((name, i) => [name, made.devices[i]] as const));
  const device = (name: string): TestDevice => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`No device for ${name}.`);
    return found;
  };
  return { fake, groupId: made.groupId, device, devices: made.devices };
}

/** The one group `device` keeps under `groupId`. */
async function groupOn(device: TestDevice, groupId: string): Promise<Group> {
  const kept = await device.services.store.getGroup(groupId);
  if (kept === undefined) throw new Error('Expected the group on the device.');
  return kept;
}

/** The member key of `device` in `groupId`. */
async function keyOf(device: TestDevice, groupId: string): Promise<string> {
  return (await groupOn(device, groupId)).me.author;
}

/** The choice of the named people in `groupId`, `t` needed. */
async function choice(
  groupId: string,
  t: number,
  people: readonly TestDevice[],
): Promise<RecoveryChoice> {
  const contacts = await Promise.all(
    people.map(async (person) => ({ groupId, member: await keyOf(person, groupId) })),
  );
  return { t, contacts };
}

/** Syncs every device once, each in turn, so each sees what the others sent. */
async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await device.services.sync.syncOnce();
  for (const device of devices) await device.services.sync.syncOnce();
}

/** What `device` holds, as Settings lists it: whose share, in which group. */
async function holding(device: TestDevice): Promise<string[]> {
  const groups = await device.services.store.listGroups();
  return heldShares(groups).map(({ name, groupName }) => `${name} (${groupName})`);
}

/** The share `holder` holds for `author` in `groupId`, opened. */
async function shareHeldBy(holder: TestDevice, groupId: string, author: string) {
  const share = openHeldShare(await groupOn(holder, groupId), author);
  if (share === null) throw new Error('Expected a held share.');
  return share;
}

/** Ana's backup key now. */
async function backupKeyOf(device: TestDevice): Promise<Uint8Array> {
  const state = await device.services.store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  return local(state.key);
}

/** Everything a device or the relay could leak through: every log record, request and stored blob. */
function everything(fake: FakeRelay, groups: readonly Group[]): Uint8Array[] {
  return [
    ...groups.flatMap((kept) => [...kept.log.map((record) => record.bytes), ...kept.outbox]),
    ...fake.requests.flatMap((request) => (request.body === null ? [] : [request.body])),
    ...fake.requests.map((request) => new TextEncoder().encode(request.url)),
  ];
}

/** Canaries for a share, its split and the key it rebuilds. */
function shareCanaries(label: string, share: RecoveryShare): Canary[] {
  return [
    ...keyCanaries(`${label}’s share`, local(share.share)),
    textCanary(`${label}’s split`, share.split),
  ];
}

describe('choosing recovery contacts', () => {
  it('gives each contact, and only each contact, a share they see as held for the person', async () => {
    const { fake, groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee', 'Eve']);
    const [ana, ben, cal, dee, eve] = [
      device('Ana'),
      device('Ben'),
      device('Cal'),
      device('Dee'),
      device('Eve'),
    ];

    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, eve]));
    await syncAll(devices);

    for (const contact of [ben, cal, eve]) {
      expect(await holding(contact)).toEqual(['Ana (Riverside Tenants)']);
    }
    expect(await holding(dee)).toEqual([]);
    expect(await holding(ana)).toEqual([]);
    const plan = await ana.services.store.getRecoveryPlan();
    expect(plan).toMatchObject({ t: 2, n: 3, retired: [] });
    expect(plan?.contacts.map(({ name, groupName }) => [name, groupName])).toEqual([
      ['Ben', 'Riverside Tenants'],
      ['Cal', 'Riverside Tenants'],
      ['Eve', 'Riverside Tenants'],
    ]);

    // Any two of the three rebuild the backup key, and the relay backup opens under it.
    const author = await keyOf(ana, groupId);
    const [fromBen, fromCal, fromEve] = await Promise.all(
      [ben, cal, eve].map((holder) => shareHeldBy(holder, groupId, author)),
    );
    if (!fromBen || !fromCal || !fromEve) throw new Error('Expected three shares.');
    expect(new Set([fromBen.split, fromCal.split, fromEve.split]).size).toBe(1);
    expect([fromBen.t, fromBen.n]).toEqual([2, 3]);
    const key = await backupKeyOf(ana);
    for (const pair of [
      [fromBen, fromCal],
      [fromCal, fromEve],
      [fromEve, fromBen],
    ]) {
      expect(
        local((await combineShares(pair.map((held) => held.share))) ?? new Uint8Array()),
      ).toEqual(key);
    }
    const plaintext = await fetchRelayBackup(ana.services.relay, key);
    expect(plaintext).not.toBeNull();

    // No event, no request and nothing the relay keeps holds a share, the split, the key or the list.
    const groups = (await Promise.all(devices.map((d) => d.services.store.listGroups()))).flat();
    const canaries = [
      ...shareCanaries('Ben', fromBen),
      ...shareCanaries('Cal', fromCal),
      ...shareCanaries('Eve', fromEve),
      ...keyCanaries('the backup key', key),
    ];
    const found = everything(fake, groups).flatMap((bytes) => findCanaries(bytes, canaries));
    expect(found).toEqual([]);
    const blob = fake.backup(backupIdFor(key));
    expect(blob === undefined ? [] : findCanaries(blob, canaries)).toEqual([]);
  });

  it('names no contact in any event: the rest of the group sees only an opaque box from the person', async () => {
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];

    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    await syncAll(devices);

    const state = fold((await groupOn(dee, groupId)).log, null);
    const author = await keyOf(ana, groupId);
    expect(state.recoveryShares.map(({ by }) => by)).toEqual([author, author, author]);
    const contacts = await Promise.all([ben, cal, dee].map((d) => keyOf(d, groupId)));
    for (const { box } of state.recoveryShares) {
      for (const contact of contacts) expect(box).not.toContain(contact);
    }
    // Nor do the records that carry them: no contact's key, raw or as text, and no name.
    const keys = contacts.flatMap((contact) =>
      keyCanaries('a contact’s key', fromBase64url(contact)),
    );
    const records = (await groupOn(dee, groupId)).log.slice(-3).map(({ bytes }) => bytes);
    expect(records.flatMap((bytes) => findCanaries(bytes.subarray(96), keys))).toEqual([]);
    const events = records.map((bytes) => new TextDecoder().decode(bytes.subarray(96)));
    expect(events.map((event) => JSON.parse(event) as object)).toEqual(
      state.recoveryShares.map(({ box }): unknown =>
        expect.objectContaining({ type: 'recovery-share', author, body: { box } }),
      ),
    );
    for (const event of events) expect(event).not.toMatch(/Ben|Cal|Dee/);
  });

  it('sends a share only in the group the contact shares, by their name there', async () => {
    const fake = createFakeRelay();
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal'], fake);
    const [ana, ben, cal] = [device('Ana'), device('Ben'), device('Cal')];
    const allotment = await foundAnother(ana, 'Ana in the allotment');
    const fay = await joinLater(fake, ana, allotment, 'Fay');
    opened.push(fay);
    await syncAll([...devices, fay]);

    const fayChoice = { groupId: allotment, member: await keyOf(fay, allotment) };
    const here = await choice(groupId, 2, [ben, cal]);
    await chooseContacts(ana.services, { t: 2, contacts: [...here.contacts, fayChoice] });
    await syncAll([...devices, fay]);

    expect(await holding(fay)).toEqual(['Ana in the allotment (Riverside Tenants)']);
    const riverside = fold((await groupOn(ana, groupId)).log, null);
    const garden = fold((await groupOn(ana, allotment)).log, null);
    expect([riverside.recoveryShares.length, garden.recoveryShares.length]).toEqual([2, 1]);
  });

  it('after choosing again without Cal, the old backup id no longer opens and Cal’s old share opens nothing new', async () => {
    const { fake, groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee', 'Eve']);
    const [ana, ben, cal, dee, eve] = [
      device('Ana'),
      device('Ben'),
      device('Cal'),
      device('Dee'),
      device('Eve'),
    ];
    const author = await keyOf(ana, groupId);

    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, eve]));
    await syncAll(devices);
    const oldKey = await backupKeyOf(ana);
    const oldBlob = fake.backup(backupIdFor(oldKey));
    const calsOld = await shareHeldBy(cal, groupId, author);
    const bensOld = await shareHeldBy(ben, groupId, author);
    expect(oldBlob).toBeDefined();

    await chooseContacts(ana.services, await choice(groupId, 2, [ben, dee, eve]));
    await syncAll(devices);
    const newKey = await backupKeyOf(ana);
    expect(newKey).not.toEqual(oldKey);

    // The old id holds 64 KiB of random bytes now, which open under no key.
    const scrubbed = fake.backup(backupIdFor(oldKey));
    expect(scrubbed).toHaveLength(65536);
    expect(scrubbed).not.toEqual(oldBlob);
    expect(openRelayBackup(oldKey, scrubbed ?? new Uint8Array())).toBeNull();
    expect(await fetchRelayBackup(ana.services.relay, oldKey)).toBeNull();
    expect((await ana.services.store.getRecoveryPlan())?.retired).toEqual([]);

    // Cal's old share, with Ben's old one, rebuilds only the old key, and with Ben's new one, nothing.
    const bensNew = await shareHeldBy(ben, groupId, author);
    expect(bensNew.split).not.toBe(bensOld.split);
    const oldPair = await combineShares([calsOld.share, bensOld.share]);
    expect(local(oldPair ?? new Uint8Array())).toEqual(oldKey);
    const mixed = await combineShares([calsOld.share, bensNew.share]);
    expect(local(mixed ?? new Uint8Array())).not.toEqual(newKey);
    expect(await fetchRelayBackup(ana.services.relay, mixed ?? new Uint8Array(32))).toBeNull();

    // The new contacts rebuild the new key, which opens the new backup.
    const deesNew = await shareHeldBy(dee, groupId, author);
    const rebuilt = await combineShares([bensNew.share, deesNew.share]);
    expect(local(rebuilt ?? new Uint8Array())).toEqual(newKey);
    expect(await fetchRelayBackup(ana.services.relay, newKey)).not.toBeNull();
    // Dee holds Ana's latest share; Cal still sees the old one, which no longer opens anything.
    expect(await holding(dee)).toEqual(['Ana (Riverside Tenants)']);
    expect(await holding(cal)).toEqual(['Ana (Riverside Tenants)']);
  });

  it('keeps an old id to overwrite while the relay can’t be reached, and overwrites it after a later pass', async () => {
    const { fake, groupId, device } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    const oldKey = await backupKeyOf(ana);
    const oldId = backupIdFor(oldKey);

    // Offline: every backup upload fails, and the sync pass that would send the shares can't run.
    const offline = () => Promise.reject(new TypeError('offline'));
    const services = {
      ...ana.services,
      relay: { ...ana.services.relay, putBackup: offline },
      sync: { syncOnce: () => Promise.resolve(false) },
    };
    await chooseContacts(services, await choice(groupId, 2, [ben, cal, dee]));
    expect((await ana.services.store.getRecoveryPlan())?.retired).toEqual([oldId]);
    expect(openRelayBackup(oldKey, fake.backup(oldId) ?? new Uint8Array())).not.toBeNull();
    expect((await groupOn(ana, groupId)).outbox).toHaveLength(3);

    // Back online, the next complete sync pass sends the shares, then overwrites the old id.
    await ana.services.sync.syncOnce();
    expect((await groupOn(ana, groupId)).outbox).toEqual([]);
    expect((await ana.services.store.getRecoveryPlan())?.retired).toEqual([]);
    expect(fake.backup(oldId)).toHaveLength(65536);
    expect(openRelayBackup(oldKey, fake.backup(oldId) ?? new Uint8Array())).toBeNull();
  });

  it('refuses a choice the picker never offers: yourself, a stranger, twice the same person, or a threshold outside the rule', async () => {
    const { groupId, device } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    const three = await choice(groupId, 2, [ben, cal, dee]);
    const me = { groupId, member: await keyOf(ana, groupId) };
    const stranger = { groupId, member: 'stranger-key-'.padEnd(43, '0') };
    const [first, second] = three.contacts;
    if (!first || !second) throw new Error('Expected contacts.');
    for (const bad of [
      { t: 2, contacts: [first, second, me] },
      { t: 2, contacts: [first, second, stranger] },
      { t: 2, contacts: [first, second, first] },
      { t: 2, contacts: [first, second, { ...first, groupId: 'no-such-group' }] },
      { t: 1, contacts: three.contacts },
      { t: 4, contacts: three.contacts },
      { t: 2, contacts: [first, second] },
    ]) {
      await expect(chooseContacts(ana.services, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(await ana.services.store.getRecoveryPlan()).toBeUndefined();
    expect(await ana.services.store.getRelayBackup()).toBeUndefined();
    expect((await groupOn(ana, groupId)).outbox).toEqual([]);
  });
});

describe('after each complete sync pass', () => {
  it('refreshes the relay backup, then overwrites every retired id the relay takes', async () => {
    const { groupId, device } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    const { store } = ana.services;
    const plan = await store.getRecoveryPlan();
    if (plan === undefined) throw new Error('Expected a plan.');
    await store.setRecoveryPlan({ ...plan, retired: ['taken-id-'.padEnd(43, '1'), 'refused'] });
    const put: string[] = [];
    const relay = {
      putBackup: (id: string, blob: Uint8Array) => {
        put.push(`${id} ${String(blob.length)}`);
        return id === 'refused' ? Promise.reject(new TypeError('offline')) : Promise.resolve();
      },
    };

    await afterSyncPass({ store, relay, now: ana.services.now });

    expect(put).toEqual([`${'taken-id-'.padEnd(43, '1')} 65536`, 'refused 65536']);
    expect((await store.getRecoveryPlan())?.retired).toEqual(['refused']);
  });

  it('does nothing while the device keeps no plan', async () => {
    const { device } = await group(['Ana', 'Ben', 'Cal']);
    const put: string[] = [];
    const relay = {
      putBackup: (id: string) => {
        put.push(id);
        return Promise.resolve();
      },
    };
    await afterSyncPass({ store: device('Ana').services.store, relay, now: () => 0 });
    expect(put).toEqual([]);
  });
});

describe('the picker’s groups and people', () => {
  it('lists each group’s current members by their name there, never yourself, nor a group you are leaving', async () => {
    const fake = createFakeRelay();
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal'], fake);
    const [ana, ben, cal] = [device('Ana'), device('Ben'), device('Cal')];
    const allotment = await foundAnother(ana, 'Ana');
    const fay = await joinLater(fake, ana, allotment, 'Fay');
    opened.push(fay);
    await syncAll([...devices, fay]);

    const listed = contactGroups(await ana.services.store.listGroups());
    const byId = new Map(listed.map((option) => [option.groupId, option] as const));
    expect(listed).toHaveLength(2);
    expect(byId.get(groupId)?.members.map((p) => p.name)).toEqual(['Ben', 'Cal']);
    expect(byId.get(allotment)?.members.map((p) => p.name)).toEqual(['Fay']);
    expect(byId.get(groupId)?.members.map((p) => p.member)).toEqual([
      await keyOf(ben, groupId),
      await keyOf(cal, groupId),
    ]);
    expect([byId.get(groupId)?.name, byId.get(allotment)?.name]).toEqual([
      'Riverside Tenants',
      'Riverside Tenants',
    ]);

    await leaveGroup(ana.services, allotment);
    const after = contactGroups(await ana.services.store.listGroups());
    expect(after.map((option) => option.groupId)).toEqual([groupId]);
  });
});

describe('where the person’s contacts stand', () => {
  it('says nothing before a choice, then n contacts with t needed', async () => {
    const { groupId, device } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    expect(recoveryStatus(undefined, await ana.services.store.listGroups())).toBeNull();

    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    const status = recoveryStatus(
      await ana.services.store.getRecoveryPlan(),
      await ana.services.store.listGroups(),
    );
    expect(status).toMatchObject({ t: 2, n: 3, chooseAgain: false });
    expect(status?.contacts.map(({ name, shared }) => [name, shared])).toEqual([
      ['Ben', true],
      ['Cal', true],
      ['Dee', true],
    ]);
  });

  it('marks a contact who left as no longer shared, and asks to choose again only below t', async () => {
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    const status = async () =>
      recoveryStatus(
        await ana.services.store.getRecoveryPlan(),
        await ana.services.store.listGroups(),
      );

    await leaveGroup(cal.services, groupId);
    await syncAll(devices);
    expect((await status())?.contacts.map(({ shared }) => shared)).toEqual([true, false, true]);
    // Exactly t are left: they can still help, so nothing asks yet.
    expect((await status())?.chooseAgain).toBe(false);

    await leaveGroup(dee.services, groupId);
    await syncAll(devices);
    expect((await status())?.contacts.map(({ shared }) => shared)).toEqual([true, false, false]);
    expect((await status())?.chooseAgain).toBe(true);
  });

  it('marks every contact in a group the person left as no longer shared', async () => {
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));

    await leaveGroup(ana.services, groupId);
    await syncAll(devices);
    const status = recoveryStatus(
      await ana.services.store.getRecoveryPlan(),
      await ana.services.store.listGroups(),
    );
    expect(status?.contacts.map(({ shared }) => shared)).toEqual([false, false, false]);
    expect(status?.chooseAgain).toBe(true);
  });
});

describe('the shares a device holds', () => {
  it('keeps the latest share per person and group, and drops one from someone who has left', async () => {
    const { groupId, device, devices } = await group(['Ana', 'Ben', 'Cal', 'Dee']);
    const [ana, ben, cal, dee] = [device('Ana'), device('Ben'), device('Cal'), device('Dee')];
    await chooseContacts(ana.services, await choice(groupId, 2, [ben, cal, dee]));
    await chooseContacts(dee.services, await choice(groupId, 2, [ana, ben, cal]));
    await syncAll(devices);
    const first = heldSharesIn(await groupOn(ben, groupId));
    expect(first.map(({ name }) => name)).toEqual(['Ana', 'Dee']);

    await chooseContacts(ana.services, await choice(groupId, 3, [ben, cal, dee]));
    await syncAll(devices);
    const second = heldSharesIn(await groupOn(ben, groupId));
    expect(second.map(({ name }) => name)).toEqual(['Dee', 'Ana']);
    expect(second.find(({ name }) => name === 'Ana')?.id).not.toBe(
      first.find(({ name }) => name === 'Ana')?.id,
    );
    expect(openHeldShare(await groupOn(ben, groupId), await keyOf(ana, groupId))?.t).toBe(3);

    const deeKey = await keyOf(dee, groupId);
    expect(openHeldShare(await groupOn(ben, groupId), deeKey)).not.toBeNull();
    await leaveGroup(dee.services, groupId);
    await syncAll(devices);
    expect(heldSharesIn(await groupOn(ben, groupId)).map(({ name }) => name)).toEqual(['Ana']);
    expect(openHeldShare(await groupOn(ben, groupId), deeKey)).toBeNull();
  });
});
