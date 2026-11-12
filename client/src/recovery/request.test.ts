/**
 * The new device's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0075 §4): it shows a code, polls the request mailbox, rebuilds the
 * backup key from any t shares of one split, and restores every group from
 * the relay backup, writing nothing until a backup opens. Real devices on
 * one fake relay, with every request captured.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { parseRecoveryCode, recoveryChannel, recoveryCheck, sealRelease } from '../crypto/recovery';
import { backupIdFor, newScrubBlob } from '../crypto/relayBackup';
import { xchachaSeal } from '../crypto/seal';
import { newSplitId, type RecoveryShare } from '../crypto/shares';
import { chooseContacts, openHeldShare } from '../store/recovery';
import { fetchRelayBackup } from '../store/relayBackup';
import { type TestDevice, testDevice } from '../test/appServices';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { groupOn, HOLD, keyOf, recoveryWorld, type RecoveryWorld } from '../test/recovery';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { approveRecovery } from './holder';
import { MAX_SUBSETS, recoverSession, startRecovery, stopRecovery } from './request';

freshIndexedDBPerTest();

const DEVICES = { timeout: 60_000 };

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Ana's world, and a fresh device that has started a request. */
async function setUp() {
  const fake = createFakeRelay();
  const world = await recoveryWorld(fake);
  const fresh = await testDevice(fake, 'fresh');
  opened.push(...world.devices, fresh);
  const shown = await startRecovery(fresh.services);
  const request = await fresh.services.store.getRecoverRequest();
  if (request === undefined) throw new Error('Expected a kept request.');
  return { fake, world, fresh, shown, request };
}

/** The share `contact` holds for Ana in `groupId`. */
async function heldBy(world: RecoveryWorld, contact: TestDevice, groupId: string) {
  const share = openHeldShare(await groupOn(contact, groupId), await keyOf(world.ana, groupId));
  if (share === null) throw new Error('Expected a held share.');
  return share;
}

/** Puts `share` in the request mailbox for the code `shown`, as a contact's device would. */
async function release(fake: FakeRelay, device: TestDevice, code: string, share: RecoveryShare) {
  const parsed = parseRecoveryCode(code);
  if (parsed === null) throw new Error('Expected a code.');
  const { mailbox, key } = recoveryChannel(parsed.seed);
  const box = sealRelease(parsed.publicKey, mailbox, share);
  await device.services.relay.putBlob(mailbox, xchachaSeal.seal(mailbox, key, box), 7);
  expect(fake.blobs(mailbox).length).toBeGreaterThan(0);
}

/** How many backup GETs the relay has answered. */
function backupReads(fake: FakeRelay): number {
  return fake.requests.filter((sent) => sent.method === 'GET' && sent.url.includes('/backup/'))
    .length;
}

/** Ana's relay backup key. */
async function anaKey(world: RecoveryWorld): Promise<Uint8Array> {
  const state = await world.ana.services.store.getRelayBackup();
  if (state === undefined) throw new Error('Expected Ana’s backup key.');
  return local(state.key);
}

describe('recovering on a new device', DEVICES, () => {
  it('shows one code and check, kept across a restart, until it stops', async () => {
    const { fresh, shown, request } = await setUp();
    expect(shown.code).toMatch(/^RR1\.[A-Za-z0-9_-]{64}$/);
    expect(shown.check).toBe(recoveryCheck(shown.code));
    expect(local(parseRecoveryCode(shown.code)?.seed ?? new Uint8Array())).toEqual(
      local(request.seed),
    );
    expect(local(parseRecoveryCode(shown.code)?.publicKey ?? new Uint8Array())).toEqual(
      kxPublicKeyOf(request.secretKey),
    );
    expect(await startRecovery(fresh.services)).toEqual(shown);

    await stopRecovery(fresh.services);
    expect(await fresh.services.store.getRecoverRequest()).toBeUndefined();
    expect(await recoverSession(fresh.services).poll()).toEqual({ kind: 'stopped' });
    expect((await startRecovery(fresh.services)).code).not.toBe(shown.code);
  });

  it('shows one code, the one it keeps, for two starts at once, as React’s StrictMode makes them', async () => {
    const fake = createFakeRelay();
    const fresh = await testDevice(fake, 'twice');
    opened.push(fresh);
    const [one, two] = await Promise.all([
      startRecovery(fresh.services),
      startRecovery(fresh.services),
    ]);
    const kept = await fresh.services.store.getRecoverRequest();
    expect(two).toEqual(one);
    expect(local(parseRecoveryCode(one.code)?.seed ?? new Uint8Array())).toEqual(
      local(kept?.seed ?? new Uint8Array(1)),
    );
  });

  it('waits for t shares, then restores Ana’s groups and keeps her backup key, through real contacts', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({ kind: 'waiting', shares: 0, needed: null });

    const { ben, cal, groupId, allotment } = world;
    const approve = async (contact: TestDevice, where: string) =>
      approveRecovery(contact.services, {
        code: shown.code,
        groupId: where,
        person: await keyOf(world.ana, where),
        check: shown.check,
      });
    await approve(ben, groupId);
    await approve(cal, allotment);
    fake.minute += HOLD;
    await ben.services.sync.syncOnce();
    expect(await session.poll()).toEqual({ kind: 'waiting', shares: 1, needed: 2 });
    expect(await fresh.services.store.listGroups()).toEqual([]);
    await cal.services.sync.syncOnce();

    expect(await session.poll()).toEqual({ kind: 'restored', groups: 2 });
    const groups = await fresh.services.store.listGroups();
    expect(groups.map(({ groupId: id }) => id).sort()).toEqual([groupId, allotment].sort());
    for (const group of groups) {
      expect(group.me.author).toBe(await keyOf(world.ana, group.groupId));
      // No backup file holds them, so group home still suggests one.
      expect(group.backup).toBeUndefined();
    }
    expect(local((await fresh.services.store.getRelayBackup())?.key ?? new Uint8Array())).toEqual(
      await anaKey(world),
    );
    expect(await fresh.services.store.getRecoverRequest()).toBeUndefined();
    expect(await fresh.services.store.getRecoveredAt()).toBeTypeOf('number');
  });

  it('once recovered, choosing contacts makes a new key and overwrites the one the contacts held', async () => {
    const { fake, world, fresh, shown } = await setUp();
    await release(fake, world.ben, shown.code, await heldBy(world, world.ben, world.groupId));
    await release(fake, world.dee, shown.code, await heldBy(world, world.dee, world.groupId));
    expect(await recoverSession(fresh.services).poll()).toMatchObject({ kind: 'restored' });
    const old = await anaKey(world);
    await fresh.services.sync.syncOnce();

    const contact = async (device: TestDevice, where: string) => ({
      groupId: where,
      member: await keyOf(device, where),
    });
    await chooseContacts(fresh.services, {
      t: 2,
      contacts: [
        await contact(world.ben, world.groupId),
        await contact(world.dee, world.groupId),
        await contact(world.cal, world.allotment),
      ],
    });

    const now = (await fresh.services.store.getRelayBackup())?.key ?? new Uint8Array();
    expect(local(now)).not.toEqual(old);
    expect(fake.backup(backupIdFor(old))?.length).toBe(65536);
    expect(await fetchRelayBackup(fresh.services.relay, old)).toBeNull();
    expect(await fetchRelayBackup(fresh.services.relay, now)).not.toBeNull();
  });

  it('with two good shares and one corrupted, tries another subset and still restores', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const good = [
      await heldBy(world, world.ben, world.groupId),
      await heldBy(world, world.dee, world.groupId),
    ];
    const bad = await heldBy(world, world.cal, world.allotment);
    const corrupted = Uint8Array.from(bad.share);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await release(fake, world.cal, shown.code, { ...bad, share: corrupted });
    for (const share of good) await release(fake, world.ben, shown.code, share);

    expect(await recoverSession(fresh.services).poll()).toEqual({ kind: 'restored', groups: 2 });
    // The corrupted share with each good one, then the two good ones.
    expect(backupReads(fake)).toBe(3);
  });

  it('never combines shares from two splits, even ones that would rebuild the key', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const ben = await heldBy(world, world.ben, world.groupId);
    const dee = await heldBy(world, world.dee, world.groupId);
    await release(fake, world.ben, shown.code, ben);
    await release(fake, world.dee, shown.code, { ...dee, split: newSplitId() });

    expect(await recoverSession(fresh.services).poll()).toEqual({
      kind: 'waiting',
      shares: 1,
      needed: 2,
    });
    expect(backupReads(fake)).toBe(0);
    expect(await fresh.services.store.listGroups()).toEqual([]);
  });

  it('tries nothing until a split has t shares: two of a 3-of-5 split ask the relay nothing', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const split = newSplitId();
    for (let x = 1; x <= 2; x += 1) {
      const share = Uint8Array.from({ length: 33 }, (_, i) => (i === 32 ? x : (x * 5 + i) % 256));
      await release(fake, world.ben, shown.code, { split, t: 3, n: 5, share });
    }
    expect(await recoverSession(fresh.services).poll()).toEqual({
      kind: 'waiting',
      shares: 2,
      needed: 3,
    });
    expect(backupReads(fake)).toBe(0);
  });

  it('leaves the device empty when the backup won’t open, and keeps waiting', async () => {
    const { fake, world, fresh, shown } = await setUp();
    await world.ana.services.relay.putBackup(backupIdFor(await anaKey(world)), newScrubBlob());
    await release(fake, world.ben, shown.code, await heldBy(world, world.ben, world.groupId));
    await release(fake, world.dee, shown.code, await heldBy(world, world.dee, world.groupId));

    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({ kind: 'waiting', shares: 2, needed: 2 });
    expect(await fresh.services.store.listGroups()).toEqual([]);
    expect(await fresh.services.store.getRelayBackup()).toBeUndefined();
    expect(await fresh.services.store.getRecoveredAt()).toBeUndefined();
    expect(await fresh.services.store.getRecoverRequest()).toBeDefined();
    // The same pair isn't asked about twice.
    await session.poll();
    expect(backupReads(fake)).toBe(1);
  });

  it(`tries at most ${String(MAX_SUBSETS)} subsets, however many shares come`, async () => {
    const { fake, world, fresh, shown } = await setUp();
    const split = newSplitId();
    for (let x = 1; x <= 9; x += 1) {
      const share = Uint8Array.from({ length: 33 }, (_, i) => (i === 32 ? x : (x * 7 + i) % 256));
      await release(fake, world.ben, shown.code, { split, t: 3, n: 5, share });
    }
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({ kind: 'waiting', shares: 9, needed: 3 });
    await session.poll();
    expect(backupReads(fake)).toBe(MAX_SUBSETS);
  });

  it('sends no share, backup key, seed or key of its own in the clear in any request', async () => {
    const { fake, world, fresh, shown, request } = await setUp();
    const shares = [
      await heldBy(world, world.ben, world.groupId),
      await heldBy(world, world.dee, world.groupId),
    ];
    for (const share of shares) await release(fake, world.ben, shown.code, share);
    expect(await recoverSession(fresh.services).poll()).toMatchObject({ kind: 'restored' });

    const canaries = [
      ...keyCanaries('the seed', local(request.seed)),
      ...keyCanaries('the new device’s secret key', local(request.secretKey)),
      ...keyCanaries('the backup key', await anaKey(world)),
      ...shares.flatMap((share, i) => keyCanaries(`share ${String(i)}`, local(share.share))),
      textCanary('the code', shown.code.slice(4)),
    ];
    const sent = fake.requests.flatMap((each) => [
      new TextEncoder().encode(each.url),
      ...(each.body === null ? [] : [each.body]),
    ]);
    expect(sent.flatMap((bytes) => findCanaries(bytes, canaries))).toEqual([]);
    // The control: the request mailbox's id is in the URLs the new device polled.
    const { mailbox } = recoveryChannel(request.seed);
    const control = [textCanary('the request mailbox', mailbox)];
    expect(sent.flatMap((bytes) => findCanaries(bytes, control)).length).toBeGreaterThan(0);
    expect(base64url(request.seed)).not.toBe(mailbox);
  });
});
