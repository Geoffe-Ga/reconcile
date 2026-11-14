/**
 * The new device's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0075 §4): it shows a code and a second number, polls the request
 * mailbox, drops each release without that number (#398), rebuilds the
 * backup key from any t shares of one split, and asks the person whether
 * the groups it found are theirs before it restores any, writing nothing
 * until they say yes. Real devices on one fake relay, with every request
 * captured.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { sealTo } from '../crypto/box';
import {
  parseRecoveryCode,
  RECOVERY_RELEASE_INFO,
  recoveryChannel,
  recoveryCheck,
  recoveryNumber,
  sealRelease,
} from '../crypto/recovery';
import { backupIdFor, newScrubBlob, sealRelayBackup } from '../crypto/relayBackup';
import { xchachaSeal } from '../crypto/seal';
import { newSplitId, type RecoveryShare, splitKey } from '../crypto/shares';
import { chooseContacts, openHeldShare } from '../store/recovery';
import { fetchRelayBackup, startRelayBackup } from '../store/relayBackup';
import { type TestDevice, testDevice } from '../test/appServices';
import { local, text, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { groupOn, HOLD, keyOf, recoveryWorld, type RecoveryWorld } from '../test/recovery';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { approveRecovery } from './holder';
import {
  MAX_SUBSETS,
  recoverSession,
  type RecoverSession,
  type ShownRequest,
  startRecovery,
  stopRecovery,
} from './request';

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

/**
 * Puts `share` in the request mailbox for the code `shown`, as a contact's
 * device would, with the second number the contact typed: `shown`'s unless
 * the test says otherwise.
 */
async function release(
  fake: FakeRelay,
  device: TestDevice,
  shown: ShownRequest,
  share: RecoveryShare,
  number = shown.number,
) {
  const parsed = parseRecoveryCode(shown.code);
  if (parsed === null) throw new Error('Expected a code.');
  const { mailbox, key } = recoveryChannel(parsed.seed);
  const box = sealRelease(parsed.publicKey, mailbox, share, number);
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

/** A six-digit number that isn't `number`. */
function otherThan(number: string): string {
  return String((Number(number) + 1) % 1_000_000).padStart(6, '0');
}

/** How many request-mailbox GETs the relay has answered. */
function mailboxReads(fake: FakeRelay, shown: ShownRequest): number {
  const seed = parseRecoveryCode(shown.code)?.seed ?? new Uint8Array();
  const { mailbox } = recoveryChannel(seed);
  return fake.requests.filter((sent) => sent.method === 'GET' && sent.url.includes(mailbox)).length;
}

/**
 * Mallory, who holds `code`, plants a relay backup of her own group under a
 * key she chose, then posts two shares of that key to the request mailbox,
 * under `split` (a new one unless named), each in two forms: as releases
 * were before #398, and with `number` as the second number. Returns her
 * group's id and her backup's.
 */
async function plantAsMallory(
  fake: FakeRelay,
  code: string,
  number: string,
  split = newSplitId(),
): Promise<{ planted: string; backup: string }> {
  const made = await members(fake, ['Mallory']);
  const [mallory] = made.devices;
  if (mallory === undefined) throw new Error('Expected Mallory’s device.');
  opened.push(mallory);
  await startRelayBackup(mallory.services, { newKey: true, split });
  const key = local((await mallory.services.store.getRelayBackup())?.key ?? new Uint8Array());
  const parsed = parseRecoveryCode(code);
  if (parsed === null) throw new Error('Expected a code.');
  const { mailbox, key: sealKey } = recoveryChannel(parsed.seed);
  const shares = await splitKey(key, 3, 2);
  for (const share of shares.slice(0, 2)) {
    const body = { split, t: 2, n: 3, share: base64url(share) };
    for (const plaintext of [body, { v: 2, ...body, number }]) {
      const box = sealTo(
        parsed.publicKey,
        utf8(JSON.stringify(plaintext)),
        RECOVERY_RELEASE_INFO,
        utf8(mailbox),
      );
      await mallory.services.relay.putBlob(mailbox, xchachaSeal.seal(mailbox, sealKey, box), 7);
    }
  }
  return { planted: made.groupId, backup: backupIdFor(key) };
}

/** The shares Ben and Dee hold for Ana in Riverside Tenants, released with `shown`'s second number. */
async function releaseRiverside(fake: FakeRelay, world: RecoveryWorld, shown: ShownRequest) {
  await release(fake, world.ben, shown, await heldBy(world, world.ben, world.groupId));
  await release(fake, world.dee, shown, await heldBy(world, world.dee, world.groupId));
}

/** Polls `session` until it finds a backup, then says yes: what restoring brought back. */
async function confirmed(session: RecoverSession) {
  expect(await session.poll()).toMatchObject({ kind: 'found' });
  return session.confirm();
}

/** What a device that has written nothing holds: no groups, no backup key, and its request. */
async function untouched(fresh: TestDevice) {
  return {
    groups: await fresh.services.store.listGroups(),
    key: await fresh.services.store.getRelayBackup(),
    request: (await fresh.services.store.getRecoverRequest()) !== undefined,
    recovered: await fresh.services.store.getRecoveredAt(),
  };
}

const NOTHING_WRITTEN = { groups: [], key: undefined, request: true, recovered: undefined };

describe('a recovery someone else holds the code to (#398)', DEVICES, () => {
  it('restores nothing a holder of the code alone planted, never fetches it, and keeps the request', async () => {
    const { fake, fresh, shown } = await setUp();
    const { planted } = await plantAsMallory(fake, shown.code, otherThan(shown.number));

    const session = recoverSession(fresh.services);
    for (let pass = 0; pass < 2; pass += 1) {
      // Her two releases with a wrong number opened, so they count; her two old-format ones don't.
      expect(await session.poll()).toEqual({
        kind: 'waiting',
        shares: 0,
        needed: null,
        mismatched: 2,
      });
    }
    expect(await fresh.services.store.getGroup(planted)).toBeUndefined();
    expect(await untouched(fresh)).toEqual(NOTHING_WRITTEN);
    expect(backupReads(fake)).toBe(0);
  });

  it('spends no tries on releases with the wrong number, however many come, and still recovers', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const split = newSplitId();
    const wrong = otherThan(shown.number);
    // Nine shares of a 3-of-5 split would use up every try, were they combined.
    for (let x = 1; x <= 9; x += 1) {
      const share = Uint8Array.from({ length: 33 }, (_, i) => (i === 32 ? x : (x * 7 + i) % 256));
      await release(fake, world.ben, shown, { split, t: 3, n: 5, share }, wrong);
    }
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 0,
      needed: null,
      mismatched: 9,
    });
    expect(backupReads(fake)).toBe(0);

    await releaseRiverside(fake, world, shown);
    expect(await confirmed(session)).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 0,
    });
    expect(backupReads(fake)).toBe(1);
  });

  it('counts a mistyped number, and takes the same share sent again with the right one', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const ben = await heldBy(world, world.ben, world.groupId);
    await release(fake, world.ben, shown, ben, otherThan(shown.number));
    await release(fake, world.dee, shown, await heldBy(world, world.dee, world.groupId));
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 1,
      needed: 2,
      mismatched: 1,
    });
    expect(backupReads(fake)).toBe(0);

    // The number stays the same until the recovery ends, so Ben can send again.
    expect((await startRecovery(fresh.services)).number).toBe(shown.number);
    await release(fake, world.ben, shown, ben);
    expect(await confirmed(session)).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 0,
    });
  });

  it('asks before restoring what a contact who heard the number planted, and No keeps the request', async () => {
    const { fake, world, fresh, shown } = await setUp();
    // Mallory is one of Ana's contacts: she heard the number, and posts under the real split.
    const real = await heldBy(world, world.cal, world.allotment);
    const { planted, backup } = await plantAsMallory(fake, shown.code, shown.number, real.split);
    const hers = () =>
      fake.requests.filter((sent) => sent.method === 'GET' && sent.url.includes(backup)).length;
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({ kind: 'found', groups: ['Riverside Tenants'] });
    // Asked again, it answers the same without reading the relay.
    const reads = mailboxReads(fake, shown);
    expect(await session.poll()).toEqual({ kind: 'found', groups: ['Riverside Tenants'] });
    expect(mailboxReads(fake, shown)).toBe(reads);
    expect(await untouched(fresh)).toEqual(NOTHING_WRITTEN);

    session.decline();
    expect(await session.poll()).toMatchObject({ kind: 'waiting', shares: 2, needed: 2 });
    expect(await fresh.services.store.getGroup(planted)).toBeUndefined();
    expect(await untouched(fresh)).toEqual(NOTHING_WRITTEN);
    expect(hers()).toBe(1);

    // Ana's real contacts' shares still bring her back, past Mallory's in the same split.
    await releaseRiverside(fake, world, shown);
    expect(await session.poll()).toEqual({
      kind: 'found',
      groups: ['Riverside Tenants', 'Riverside Tenants'],
    });
    expect(await session.confirm()).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 0,
    });
    expect(await fresh.services.store.getGroup(planted)).toBeUndefined();
    const held = (await fresh.services.store.listGroups()).map(({ groupId }) => groupId);
    expect(held.sort()).toEqual([world.groupId, world.allotment].sort());
    expect(local((await fresh.services.store.getRelayBackup())?.key ?? new Uint8Array())).toEqual(
      await anaKey(world),
    );
    // Mallory's backup was fetched once, and never again after No.
    expect(hers()).toBe(1);
  });

  it('restores nothing when the request stops while a backup waits for an answer', async () => {
    const { fake, world, fresh, shown } = await setUp();
    await releaseRiverside(fake, world, shown);
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toMatchObject({ kind: 'found' });

    await stopRecovery(fresh.services);
    expect(await session.confirm()).toEqual({ kind: 'stopped' });
    expect(await fresh.services.store.listGroups()).toEqual([]);
    expect(await fresh.services.store.getRelayBackup()).toBeUndefined();
    expect(await session.poll()).toEqual({ kind: 'stopped' });
  });

  it('answers a Yes or No with nothing found as a poll would', async () => {
    const { fresh } = await setUp();
    const session = recoverSession(fresh.services);
    session.decline();
    expect(await session.confirm()).toEqual({
      kind: 'waiting',
      shares: 0,
      needed: null,
      mismatched: 0,
    });
    expect(await untouched(fresh)).toEqual(NOTHING_WRITTEN);
  });
});

describe('recovering on a new device', DEVICES, () => {
  it('shows one code, check and second number, kept across a restart, until it stops', async () => {
    const { fresh, shown, request } = await setUp();
    expect(shown.code).toMatch(/^RR1\.[A-Za-z0-9_-]{64}$/);
    expect(shown.check).toBe(recoveryCheck(shown.code));
    // The second number comes from the secret key, which the code doesn't carry (#398).
    expect(shown.number).toBe(recoveryNumber(request.secretKey));
    expect(shown.number).toMatch(/^[0-9]{6}$/);
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
    const again = await startRecovery(fresh.services);
    expect(again.code).not.toBe(shown.code);
    expect(again.number).not.toBe(shown.number);
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
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 0,
      needed: null,
      mismatched: 0,
    });

    const { ben, cal, groupId, allotment } = world;
    const approve = async (contact: TestDevice, where: string) =>
      approveRecovery(contact.services, {
        code: shown.code,
        groupId: where,
        person: await keyOf(world.ana, where),
        check: shown.check,
        number: shown.number,
      });
    await approve(ben, groupId);
    await approve(cal, allotment);
    fake.minute += HOLD;
    await ben.services.sync.syncOnce();
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 1,
      needed: 2,
      mismatched: 0,
    });
    expect(await fresh.services.store.listGroups()).toEqual([]);
    await cal.services.sync.syncOnce();

    // Found, and nothing written until Ana says these are her groups (#398).
    expect(await session.poll()).toEqual({
      kind: 'found',
      groups: ['Riverside Tenants', 'Riverside Tenants'],
    });
    expect(await untouched(fresh)).toEqual(NOTHING_WRITTEN);
    expect(await session.confirm()).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 0,
    });
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
    // The key comes with the split the contacts' shares came from (#272).
    expect((await fresh.services.store.getRelayBackup())?.split).toBe(
      (await world.ana.services.store.getRecoveryPlan())?.split,
    );
    expect(await fresh.services.store.getRecoverRequest()).toBeUndefined();
    expect(await fresh.services.store.getRecoveredAt()).toBeTypeOf('number');
  });

  it('once recovered, choosing contacts makes a new key and overwrites the one the contacts held', async () => {
    const { fake, world, fresh, shown } = await setUp();
    await releaseRiverside(fake, world, shown);
    expect(await confirmed(recoverSession(fresh.services))).toMatchObject({ kind: 'restored' });
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
    await release(fake, world.cal, shown, { ...bad, share: corrupted });
    for (const share of good) await release(fake, world.ben, shown, share);

    expect(await confirmed(recoverSession(fresh.services))).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 0,
    });
    // The corrupted share with each good one, then the two good ones.
    expect(backupReads(fake)).toBe(3);
  });

  it('never combines shares from two splits, even ones that would rebuild the key', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const ben = await heldBy(world, world.ben, world.groupId);
    const dee = await heldBy(world, world.dee, world.groupId);
    await release(fake, world.ben, shown, ben);
    await release(fake, world.dee, shown, { ...dee, split: newSplitId() });

    expect(await recoverSession(fresh.services).poll()).toEqual({
      kind: 'waiting',
      shares: 1,
      needed: 2,
      mismatched: 0,
    });
    expect(backupReads(fake)).toBe(0);
    expect(await fresh.services.store.listGroups()).toEqual([]);
  });

  it('tries nothing until a split has t shares: two of a 3-of-5 split ask the relay nothing', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const split = newSplitId();
    for (let x = 1; x <= 2; x += 1) {
      const share = Uint8Array.from({ length: 33 }, (_, i) => (i === 32 ? x : (x * 5 + i) % 256));
      await release(fake, world.ben, shown, { split, t: 3, n: 5, share });
    }
    expect(await recoverSession(fresh.services).poll()).toEqual({
      kind: 'waiting',
      shares: 2,
      needed: 3,
      mismatched: 0,
    });
    expect(backupReads(fake)).toBe(0);
  });

  it('leaves out a group entry someone planted in the relay copy, restores the rest and counts it (#336)', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const key = await anaKey(world);
    const copy = await fetchRelayBackup(world.ana.services.relay, key);
    if (copy === null) throw new Error('Expected Ana’s relay copy.');
    const json = JSON.parse(text(copy)) as { groups: unknown[] };
    const planted = { groupId: base64url(new Uint8Array(32).fill(0x50)), log: 'not a log' };
    const groups = [planted, ...json.groups];
    await world.ana.services.relay.putBackup(
      backupIdFor(key),
      sealRelayBackup(key, utf8(JSON.stringify({ ...json, groups }))),
    );
    await releaseRiverside(fake, world, shown);

    // The planted entry isn't named, so Ana is asked only about her own groups.
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({
      kind: 'found',
      groups: ['Riverside Tenants', 'Riverside Tenants'],
    });
    expect(await session.confirm()).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 1,
      skippedDocuments: 0,
    });
    const held = (await fresh.services.store.listGroups()).map(({ groupId }) => groupId);
    expect(held.sort()).toEqual([world.groupId, world.allotment].sort());
    expect(local((await fresh.services.store.getRelayBackup())?.key ?? new Uint8Array())).toEqual(
      key,
    );
    expect(await fresh.services.store.getRecoveredAt()).toBeTypeOf('number');
  });

  it('leaves out a personal Document someone planted in the relay copy, restores the rest and counts it (#351)', async () => {
    const { fake, world, fresh, shown } = await setUp();
    const key = await anaKey(world);
    const copy = await fetchRelayBackup(world.ana.services.relay, key);
    if (copy === null) throw new Error('Expected Ana’s relay copy.');
    const json = JSON.parse(text(copy)) as { personal?: unknown[] };
    const personal = [{ id: 'not an id', title: '' }, ...(json.personal ?? [])];
    await world.ana.services.relay.putBackup(
      backupIdFor(key),
      sealRelayBackup(key, utf8(JSON.stringify({ ...json, personal }))),
    );
    await releaseRiverside(fake, world, shown);

    expect(await confirmed(recoverSession(fresh.services))).toEqual({
      kind: 'restored',
      groups: 2,
      skipped: 0,
      skippedDocuments: 1,
    });
    expect(await fresh.services.store.listPersonal()).toEqual([]);
    expect(await fresh.services.store.getRecoveredAt()).toBeTypeOf('number');
  });

  it('leaves the device empty when the backup won’t open, and keeps waiting', async () => {
    const { fake, world, fresh, shown } = await setUp();
    await world.ana.services.relay.putBackup(backupIdFor(await anaKey(world)), newScrubBlob());
    await releaseRiverside(fake, world, shown);

    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 2,
      needed: 2,
      mismatched: 0,
    });
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
      await release(fake, world.ben, shown, { split, t: 3, n: 5, share });
    }
    const session = recoverSession(fresh.services);
    expect(await session.poll()).toEqual({
      kind: 'waiting',
      shares: 9,
      needed: 3,
      mismatched: 0,
    });
    await session.poll();
    expect(backupReads(fake)).toBe(MAX_SUBSETS);
  });

  it('sends no share, backup key, seed or key of its own in the clear in any request', async () => {
    const { fake, world, fresh, shown, request } = await setUp();
    const shares = [
      await heldBy(world, world.ben, world.groupId),
      await heldBy(world, world.dee, world.groupId),
    ];
    for (const share of shares) await release(fake, world.ben, shown, share);
    expect(await confirmed(recoverSession(fresh.services))).toMatchObject({ kind: 'restored' });

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
