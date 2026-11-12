/**
 * The store's key vault (#95): once a device seals its keys, IndexedDB holds
 * no secret outside the vault, every later write of key material goes into
 * it, and a new session reads nothing until the passkey's key unlocks it.
 */
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { fold } from '../engine/fold';
import { concat, local, text, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { findCanaries, keyCanaries } from '../test/scan';
import { scanDb } from '../test/scanDb';
import {
  type BackedUpGroup,
  DATABASE_NAME,
  type Group,
  type NewGroup,
  openStore,
  RELAY_BACKUP_CHANGED,
  type RelayBackupState,
  VaultLocked,
} from './db';
import { openKeys, type VaultLock, type VaultRecord } from './vault';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const WRONG_KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x22), SALT);
const LOCK: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

/** A group whose secret and signing key are bytes no other group's are. */
function newGroup(id: string, fill: number): NewGroup {
  return {
    groupId: id,
    secret: Uint8Array.from({ length: 32 }, (_, i) => (fill * 7 + i) % 256),
    signingKey: Uint8Array.from({ length: 32 }, (_, i) => (fill * 13 + i * 3 + 1) % 256),
    me: { author: `author-${id}`, name: `Name ${id}` },
  };
}

const ANA = newGroup('group-ana', 1);
const BEN = newGroup('group-ben', 2);

/** Every canary for `groups`' secrets: raw and base64url, as `test/scan.ts` spells them. */
function secretsOf(...groups: readonly NewGroup[]) {
  return groups.flatMap((group) => [
    ...keyCanaries(`${group.groupId} secret`, group.secret),
    ...keyCanaries(`${group.groupId} signing key`, group.signingKey),
  ]);
}

/** Every key and value in every object store of the app's database, as raw bytes (`test/scanDb.ts`). */
async function rawDatabase(): Promise<Uint8Array> {
  const { text: words, bytes } = await scanDb(DATABASE_NAME);
  return concat(utf8(words), ...bytes.flatMap((held) => [Uint8Array.of(0), held]));
}

/** The vault record as IndexedDB holds it, read with no store in between. */
async function rawVault(): Promise<VaultRecord | undefined> {
  const db = await openDB(DATABASE_NAME);
  try {
    return (await db.get('vault', 'vault')) as VaultRecord | undefined;
  } finally {
    db.close();
  }
}

/** The relay backup's record (#97) as IndexedDB holds it, read with no store in between. */
async function rawRelayBackup(): Promise<Record<string, unknown> | undefined> {
  const db = await openDB(DATABASE_NAME);
  try {
    return (await db.get('device', 'relay-backup')) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

/** The relay backup's key in the vault, opened under {@link KEY}, in the test's realm. */
async function vaultBackupKey(): Promise<Uint8Array | undefined> {
  const vault = await rawVault();
  if (vault === undefined) throw new Error('Expected a vault.');
  const opened = openKeys(vault, KEY);
  if (opened === null) throw new Error('Expected the vault to open.');
  return opened.backupKey === undefined ? undefined : local(opened.backupKey);
}

/** The relay backup's state with its key in the test's realm, so `toEqual` can compare it. */
function backupOf(state: RelayBackupState | undefined) {
  return state === undefined ? undefined : { ...state, key: local(state.key) };
}

/** A fresh relay backup state for `key`, as `backupOf` spells it. */
function freshBackup(key: Uint8Array) {
  return {
    key: local(key),
    digest: null,
    checkedDay: null,
    uploadedAt: null,
    tooLarge: false,
    uploaded: [],
    uploadedGroups: [],
  };
}

/** A group's keys and name, in the test's realm, so `toEqual` can compare them. */
function keysOf(group: Pick<Group, 'groupId' | 'secret' | 'signingKey' | 'me'> | undefined) {
  if (group === undefined) return undefined;
  const { groupId, secret, signingKey, me } = group;
  return { groupId, secret: local(secret), signingKey: local(signingKey), me };
}

/** A backed-up copy of `group`, synced at `lastSyncAt`. */
function backedUp(group: NewGroup, lastSyncAt: number): BackedUpGroup {
  return {
    ...group,
    log: [{ seq: 1, received: 29_000_001, bytes: utf8('{"from":"file"}') }],
    cursor: 1,
    relayNow: 29_000_002,
    instance: 'relay-1',
    lastSyncAt,
    missingHistory: false,
  };
}

/** A device holding Ana's and Ben's groups, its keys sealed under {@link KEY}. */
async function sealedDevice() {
  const store = await openStore();
  await store.addGroup(ANA);
  await store.addGroup(BEN);
  await store.sealKeys(LOCK, KEY);
  return store;
}

describe('a device with no vault', () => {
  it('names no passkey, and keeps each group’s keys in its record as before', async () => {
    const store = await openStore();
    await store.addGroup(ANA);

    expect(await store.readVault()).toBeNull();
    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
    expect(findCanaries(await rawDatabase(), secretsOf(ANA)).length).toBeGreaterThan(0);
    expect(await rawVault()).toBeUndefined();
  });

  it('opens with nothing to unlock', async () => {
    const store = await openStore();

    expect(await store.unlock(KEY)).toBe(false);
    expect(await store.readVault()).toBeNull();
  });
});

describe('sealKeys', () => {
  it('leaves no secret outside the vault, in any spelling, and keeps every group readable', async () => {
    const store = await sealedDevice();

    expect(findCanaries(await rawDatabase(), secretsOf(ANA, BEN))).toEqual([]);
    const groups = await store.listGroups();
    expect(groups.map(keysOf)).toEqual([keysOf(ANA), keysOf(BEN)]);
    expect(keysOf(await store.getGroup(BEN.groupId))).toEqual(keysOf(BEN));
    const records = await openDB(DATABASE_NAME).then(async (db) => {
      const all = await db.getAll('groups');
      db.close();
      return all as Record<string, unknown>[];
    });
    expect(records.map((record) => ['secret' in record, 'signingKey' in record])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('names the passkey and salt in the clear, and seals the keys under the vault key', async () => {
    const store = await sealedDevice();

    const lock = await store.readVault();
    expect(lock === null ? null : [local(lock.credentialId), local(lock.prfSalt)]).toEqual([
      local(LOCK.credentialId),
      local(LOCK.prfSalt),
    ]);
    const vault = await rawVault();
    if (vault === undefined) throw new Error('Expected a vault.');
    const opened = openKeys(vault, KEY);
    expect([...(opened?.groups.keys() ?? [])]).toEqual([ANA.groupId, BEN.groupId]);
    expect(openKeys(vault, WRONG_KEY)).toBeNull();
  });

  it('refuses a second vault, changing nothing', async () => {
    const store = await sealedDevice();
    const before = await rawDatabase();

    await expect(store.sealKeys(LOCK, WRONG_KEY)).rejects.toThrow(
      'This device’s keys are already locked with a passkey.',
    );

    expect(local(await rawDatabase())).toEqual(local(before));
  });

  it('changes nothing when sealing fails partway: the plain copies go in the same transaction', async () => {
    const store = await openStore();
    await store.addGroup(ANA);
    // A record with no keys fails only after the new vault is written in the same transaction.
    const db = await openDB(DATABASE_NAME);
    await db.put('groups', { groupId: 'group-broken', me: ANA.me, log: [], outbox: [] });
    db.close();
    const before = await rawDatabase();

    await expect(store.sealKeys(LOCK, KEY)).rejects.toThrow(
      'A group’s keys are missing from this device.',
    );

    expect(local(await rawDatabase())).toEqual(local(before));
    expect(await store.readVault()).toBeNull();
    expect(await rawVault()).toBeUndefined();
  });

  it('refuses a key that isn’t 32 bytes, changing nothing', async () => {
    const store = await openStore();
    await store.addGroup(ANA);
    const before = await rawDatabase();

    await expect(store.sealKeys(LOCK, new Uint8Array(16))).rejects.toThrow(RangeError);

    expect(local(await rawDatabase())).toEqual(local(before));
    expect(await store.readVault()).toBeNull();
    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
  });

  it('seals an empty device, so the first group made after goes into the vault', async () => {
    const store = await openStore();
    await store.sealKeys(LOCK, KEY);

    await store.addGroup(ANA);

    expect(findCanaries(await rawDatabase(), secretsOf(ANA))).toEqual([]);
    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
  });
});

describe('a new session on a sealed device', () => {
  it('reads no group until the passkey’s key unlocks it', async () => {
    (await sealedDevice()).close();
    const store = await openStore();

    expect(await store.readVault()).not.toBeNull();
    await expect(store.listGroups()).rejects.toThrow(VaultLocked);
    await expect(store.getGroup(ANA.groupId)).rejects.toThrow(VaultLocked);
    await expect(store.addGroup(newGroup('group-cal', 3))).rejects.toThrow(VaultLocked);
    await expect(store.listGroups()).rejects.toThrow(
      'This device’s keys are locked with a passkey.',
    );
  });

  it('keeps nothing and writes nothing when another key fails to unlock it', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const before = await rawDatabase();

    expect(await store.unlock(WRONG_KEY)).toBe(false);

    expect(local(await rawDatabase())).toEqual(local(before));
    await expect(store.listGroups()).rejects.toThrow(VaultLocked);
  });

  it('reads every group with its keys once unlocked, writing nothing', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const before = await rawDatabase();

    expect(await store.unlock(KEY)).toBe(true);

    expect((await store.listGroups()).map(keysOf)).toEqual([keysOf(ANA), keysOf(BEN)]);
    expect(local(await rawDatabase())).toEqual(local(before));
  });

  it('keeps its own copy of the key, so the caller can zero theirs', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const key = Uint8Array.from(KEY);

    await store.unlock(key);
    key.fill(0);

    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
  });
});

describe('#98’s keys under the vault: the encryption key and each new epoch’s secret', () => {
  const NEXT_SECRET = new Uint8Array(32).fill(0xe1);
  const KX = new Uint8Array(32).fill(0xc5);
  const ADOPTED = new Uint8Array(32).fill(0xe2);

  it('seals a group’s encryption key with its other keys, never in its record', async () => {
    const store = await openStore();
    await store.addGroup({ ...ANA, kxKey: KX });
    await store.sealKeys(LOCK, KEY);
    store.close();
    const reopened = await openStore();
    await reopened.unlock(KEY);

    const canaries = [...secretsOf(ANA), ...keyCanaries('kx key', KX)];
    expect(findCanaries(await rawDatabase(), canaries)).toEqual([]);
    expect(local((await reopened.getGroup(ANA.groupId))?.kxKey ?? new Uint8Array())).toEqual(
      local(KX),
    );
  });

  it('keeps the encryption key ensureKx makes in the vault, and the first one two calls race to', async () => {
    const store = await sealedDevice();

    const kept = await store.ensureKx(ANA.groupId, KX);
    const again = await store.ensureKx(ANA.groupId, new Uint8Array(32).fill(0x77));

    expect([local(kept), local(again)]).toEqual([local(KX), local(KX)]);
    expect(findCanaries(await rawDatabase(), keyCanaries('kx key', KX))).toEqual([]);
    expect(local((await store.getGroup(ANA.groupId))?.kxKey ?? new Uint8Array())).toEqual(
      local(KX),
    );
  });

  it('seals the next epoch’s secret a pull moves to, keeping the rest of the pull', async () => {
    const store = await sealedDevice();
    const advance = { epoch: 1, secret: NEXT_SECRET, cursor: 0, repost: [utf8('{"again":1}')] };
    const pull = { records: [], cursor: 7, relayNow: 3, instance: 'r', lastSyncAt: 4, advance };

    await store.applyPull(ANA.groupId, pull, () => null);

    expect(findCanaries(await rawDatabase(), keyCanaries('next secret', NEXT_SECRET))).toEqual([]);
    const group = await store.getGroup(ANA.groupId);
    expect(local(group?.secret ?? new Uint8Array())).toEqual(local(NEXT_SECRET));
    expect([group?.epoch, group?.cursor, group?.outbox.map(text)]).toEqual([1, 0, ['{"again":1}']]);
    expect(local(group?.signingKey ?? new Uint8Array())).toEqual(local(ANA.signingKey));
  });

  it('seals an epoch an invite carried, and ignores one that isn’t later', async () => {
    const store = await sealedDevice();

    await store.adoptEpoch(ANA.groupId, { epoch: 2, secret: ADOPTED, cursor: 5, repost: [] });
    await store.adoptEpoch(ANA.groupId, { epoch: 1, secret: NEXT_SECRET, cursor: 9, repost: [] });

    expect(findCanaries(await rawDatabase(), keyCanaries('adopted', ADOPTED))).toEqual([]);
    const group = await store.getGroup(ANA.groupId);
    expect([local(group?.secret ?? new Uint8Array()), group?.epoch, group?.cursor]).toEqual([
      local(ADOPTED),
      2,
      5,
    ]);
  });

  it('refuses to move a locked group to a new epoch, writing nothing', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const before = await rawDatabase();
    const advance = { epoch: 1, secret: NEXT_SECRET, cursor: 0, repost: [] };

    await expect(
      store.applyPull(
        ANA.groupId,
        { records: [], cursor: 7, relayNow: 3, instance: 'r', lastSyncAt: 4, advance },
        () => null,
      ),
    ).rejects.toThrow(VaultLocked);
    await expect(store.ensureKx(ANA.groupId, KX)).rejects.toThrow(VaultLocked);
    await expect(store.adoptEpoch(ANA.groupId, { ...advance, cursor: 1 })).rejects.toThrow(
      VaultLocked,
    );

    expect(local(await rawDatabase())).toEqual(local(before));
  });
});

describe('requireUnlocked: the one check before anything hands keys on', () => {
  it('passes on a device with no vault, and once this session seals or unlocks the vault', async () => {
    const plain = await openStore();
    await expect(plain.requireUnlocked()).resolves.toBeUndefined();
    plain.close();

    const sealed = await sealedDevice();
    await expect(sealed.requireUnlocked()).resolves.toBeUndefined();
    sealed.close();

    const reopened = await openStore();
    await reopened.unlock(KEY);
    await expect(reopened.requireUnlocked()).resolves.toBeUndefined();
  });

  it('fails with VaultLocked in a session that hasn’t unlocked the vault, or holds the wrong key', async () => {
    (await sealedDevice()).close();
    const store = await openStore();

    await expect(store.requireUnlocked()).rejects.toThrow(VaultLocked);
    expect(await store.unlock(WRONG_KEY)).toBe(false);
    await expect(store.requireUnlocked()).rejects.toThrow(VaultLocked);
  });
});

describe('every later write of key material, with a vault', () => {
  it('seals a new group’s keys into the vault, never into its record', async () => {
    const store = await sealedDevice();
    const cal = newGroup('group-cal', 3);

    await store.addGroup(cal);

    expect(findCanaries(await rawDatabase(), secretsOf(ANA, BEN, cal))).toEqual([]);
    expect(keysOf(await store.getGroup(cal.groupId))).toEqual(keysOf(cal));
    await expect(store.addGroup({ ...cal, me: { author: 'x', name: 'Again' } })).rejects.toThrow(
      'This device already holds that group.',
    );
    expect((await store.getGroup(cal.groupId))?.me.name).toBe(cal.me.name);
  });

  it('takes a group’s keys out of the vault when the group leaves the device', async () => {
    const store = await sealedDevice();

    await store.purgeGroup(ANA.groupId);

    const vault = await rawVault();
    if (vault === undefined) throw new Error('Expected a vault.');
    expect([...(openKeys(vault, KEY)?.groups.keys() ?? [])]).toEqual([BEN.groupId]);
    expect((await store.listGroups()).map((group) => group.groupId)).toEqual([BEN.groupId]);
  });

  it('reseals a backup file’s keys with the session’s key on import', async () => {
    const store = await sealedDevice();
    const cal = newGroup('group-cal', 3);
    const newerAna = { ...newGroup(ANA.groupId, 4), me: ANA.me };

    await store.restoreGroups([backedUp(cal, 1), backedUp(newerAna, Number.MAX_SAFE_INTEGER)]);

    expect(findCanaries(await rawDatabase(), secretsOf(ANA, BEN, cal, newerAna))).toEqual([]);
    const groups = await store.listGroups();
    expect(groups.map(keysOf)).toEqual([keysOf(newerAna), keysOf(BEN), keysOf(cal)]);
    const vault = await rawVault();
    if (vault === undefined) throw new Error('Expected a vault.');
    expect([...(openKeys(vault, KEY)?.groups.keys() ?? [])].sort()).toEqual(
      [ANA.groupId, BEN.groupId, cal.groupId].sort(),
    );
  });

  it('keeps a group’s own keys when the device’s copy of it is the later one', async () => {
    const store = await sealedDevice();
    await store.applyPull(
      ANA.groupId,
      { records: [], cursor: 0, relayNow: 1, instance: 'relay-1', lastSyncAt: 50 },
      () => null,
    );

    await store.restoreGroups([backedUp({ ...newGroup(ANA.groupId, 4), me: ANA.me }, 10)]);

    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
    expect(findCanaries(await rawDatabase(), secretsOf(ANA, BEN))).toEqual([]);
  });

  it('never writes a key back into a record as the group syncs, queues and changes', async () => {
    const store = await sealedDevice();
    const record = utf8('{"n":1}');

    await store.enqueue(ANA.groupId, record);
    await store.applyPull(
      ANA.groupId,
      {
        records: [{ seq: 1, received: 2, bytes: record }],
        cursor: 1,
        relayNow: 3,
        instance: 'r',
        lastSyncAt: 4,
        sent: [record],
      },
      (bytes) => text(bytes),
    );
    await store.markBackup([ANA.groupId, BEN.groupId], 'saved');
    await store.writeDraft(ANA.groupId, 'atom-1', { title: 'T', why: 'W', text: 'X', link: '' });
    // A pull from a fresh relay instance starts every cursor over (#110), still writing no key.
    await store.applyPull(
      BEN.groupId,
      { records: [], cursors: { thisWeek: 1 }, relayNow: 3, instance: 'relay-2', lastSyncAt: 4 },
      (bytes) => text(bytes),
    );
    await store.markLeaving(BEN.groupId, utf8('{"leave":1}'));
    await store.markArchived(ANA.groupId, 'dissolved');
    await store.clearArchive(ANA.groupId, { at: 5, state: fold([], null), tallies: {} });

    expect(findCanaries(await rawDatabase(), secretsOf(ANA, BEN))).toEqual([]);
    expect((await store.listGroups()).map(keysOf)).toEqual([keysOf(ANA), keysOf(BEN)]);
  });

  it('refuses every write of key material while locked, writing nothing', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const before = await rawDatabase();

    await expect(store.addGroup(newGroup('group-cal', 3))).rejects.toThrow(VaultLocked);
    await expect(store.restoreGroups([backedUp(newGroup('group-cal', 3), 1)])).rejects.toThrow(
      VaultLocked,
    );
    await expect(store.purgeGroup(ANA.groupId)).rejects.toThrow(VaultLocked);

    expect(local(await rawDatabase())).toEqual(local(before));
  });
});

describe('#97’s relay backup key under the vault', () => {
  const BACKUP_KEY = new Uint8Array(32).fill(0xb7);
  const NEW_BACKUP_KEY = new Uint8Array(32).fill(0xb8);
  const backupCanaries = [
    ...keyCanaries('backup key', BACKUP_KEY),
    ...keyCanaries('new backup key', NEW_BACKUP_KEY),
  ];

  it('moves the backup key into the vault when the device seals its keys, keeping the rest of its state', async () => {
    const store = await openStore();
    await store.addGroup(ANA);
    await store.setRelayBackupKey(BACKUP_KEY);
    await store.updateRelayBackup(BACKUP_KEY, { digest: 'd1', checkedDay: 7, uploadedAt: 9 });

    await store.sealKeys(LOCK, KEY);

    expect(findCanaries(await rawDatabase(), [...secretsOf(ANA), ...backupCanaries])).toEqual([]);
    expect(Object.keys((await rawRelayBackup()) ?? {}).sort()).toEqual([
      'checkedDay',
      'digest',
      'tooLarge',
      'uploaded',
      'uploadedAt',
      'uploadedGroups',
    ]);
    expect(await vaultBackupKey()).toEqual(local(BACKUP_KEY));
    expect(backupOf(await store.getRelayBackup())).toEqual({
      ...freshBackup(BACKUP_KEY),
      digest: 'd1',
      checkedDay: 7,
      uploadedAt: 9,
    });
  });

  it('sets the day back when a group is purged (#327), leaving the key in the vault', async () => {
    const store = await sealedDevice();
    await store.adoptRelayBackupKey(BACKUP_KEY);
    await store.updateRelayBackup(BACKUP_KEY, { digest: 'd1', checkedDay: 7, uploadedAt: 9 });

    await store.purgeGroup(ANA.groupId);

    expect(findCanaries(await rawDatabase(), [...secretsOf(ANA), ...backupCanaries])).toEqual([]);
    expect(await vaultBackupKey()).toEqual(local(BACKUP_KEY));
    expect(backupOf(await store.getRelayBackup())).toEqual({
      ...freshBackup(BACKUP_KEY),
      digest: 'd1',
      uploadedAt: 9,
    });
  });

  it('seals every later backup key into the vault, adopted, updated or replaced, and never writes it plain', async () => {
    const store = await sealedDevice();
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    expect(await store.adoptRelayBackupKey(BACKUP_KEY)).toBe(true);
    expect(await store.adoptRelayBackupKey(NEW_BACKUP_KEY)).toBe(false);
    expect(await store.updateRelayBackup(NEW_BACKUP_KEY, { digest: 'other' })).toBe(false);
    expect(await store.updateRelayBackup(BACKUP_KEY, { digest: 'd1', uploadedAt: 9 })).toBe(true);
    expect(findCanaries(await rawDatabase(), backupCanaries)).toEqual([]);
    expect(await vaultBackupKey()).toEqual(local(BACKUP_KEY));
    const replaced = await store.setRelayBackupKey(NEW_BACKUP_KEY);

    expect(backupOf(replaced)).toEqual({ ...freshBackup(BACKUP_KEY), digest: 'd1', uploadedAt: 9 });
    expect(findCanaries(await rawDatabase(), [...secretsOf(ANA, BEN), ...backupCanaries])).toEqual(
      [],
    );
    expect(await vaultBackupKey()).toEqual(local(NEW_BACKUP_KEY));
    expect(backupOf(await store.getRelayBackup())).toEqual(freshBackup(NEW_BACKUP_KEY));
    expect((await store.listGroups()).map(keysOf)).toEqual([keysOf(ANA), keysOf(BEN)]);
    expect(heard).toEqual([RELAY_BACKUP_CHANGED, RELAY_BACKUP_CHANGED, RELAY_BACKUP_CHANGED]);
  });

  it('keeps its own copy of a key it seals, so the caller can zero theirs', async () => {
    const store = await sealedDevice();
    const key = Uint8Array.from(BACKUP_KEY);

    await store.setRelayBackupKey(key);
    key.fill(0);

    expect(backupOf(await store.getRelayBackup())).toEqual(freshBackup(BACKUP_KEY));
  });

  it('refuses to read or write the backup key while locked, writing nothing, and reads it once unlocked', async () => {
    const sealed = await sealedDevice();
    await sealed.setRelayBackupKey(BACKUP_KEY);
    sealed.close();
    const store = await openStore();
    const before = await rawDatabase();

    await expect(store.getRelayBackup()).rejects.toThrow(VaultLocked);
    await expect(store.setRelayBackupKey(NEW_BACKUP_KEY)).rejects.toThrow(VaultLocked);
    await expect(store.adoptRelayBackupKey(NEW_BACKUP_KEY)).rejects.toThrow(VaultLocked);
    await expect(store.updateRelayBackup(BACKUP_KEY, { digest: 'd1' })).rejects.toThrow(
      VaultLocked,
    );

    expect(local(await rawDatabase())).toEqual(local(before));
    expect(await store.unlock(KEY)).toBe(true);
    expect(backupOf(await store.getRelayBackup())).toEqual(freshBackup(BACKUP_KEY));
  });

  it('refuses while locked even on a device that keeps no backup key yet, so a lock never reads as no backup', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const before = await rawDatabase();

    await expect(store.getRelayBackup()).rejects.toThrow(VaultLocked);
    await expect(store.adoptRelayBackupKey(BACKUP_KEY)).rejects.toThrow(VaultLocked);

    expect(local(await rawDatabase())).toEqual(local(before));
  });

  it('drops the relay backup’s state when a backup file replaces the vault, since its key went with it', async () => {
    const sealed = await sealedDevice();
    await sealed.setRelayBackupKey(BACKUP_KEY);
    sealed.close();
    const store = await openStore();

    await store.replaceGroups([backedUp(newGroup('group-cal', 3), 1)]);

    expect(await store.getRelayBackup()).toBeUndefined();
    expect(await rawRelayBackup()).toBeUndefined();
    expect(await store.adoptRelayBackupKey(NEW_BACKUP_KEY)).toBe(true);
    expect(backupOf(await store.getRelayBackup())).toEqual(freshBackup(NEW_BACKUP_KEY));
  });
});

describe('replaceGroups: a backup file in place of a vault that won’t open', () => {
  it('replaces every group and the vault with the file’s groups, kept plain, in one go', async () => {
    (await sealedDevice()).close();
    const store = await openStore();
    const cal = newGroup('group-cal', 3);
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await store.replaceGroups([backedUp(cal, 1)]);

    expect(await store.readVault()).toBeNull();
    expect(await rawVault()).toBeUndefined();
    const groups = await store.listGroups();
    expect(groups.map(keysOf)).toEqual([keysOf(cal)]);
    expect(groups[0]).toMatchObject({ outbox: [], backup: 'saved', cursor: 1, lastSyncAt: 1 });
    expect(heard).toEqual([cal.groupId]);
  });

  it('works on a device with no vault too', async () => {
    const store = await openStore();
    await store.addGroup(ANA);

    await store.replaceGroups([backedUp(BEN, 1)]);

    expect((await store.listGroups()).map(keysOf)).toEqual([keysOf(BEN)]);
  });
});

describe('the database upgrade that adds the vault', () => {
  it('keeps version 5’s groups, personal Documents and relay backup state (#97), and seals the backup key with the rest', async () => {
    const backupKey = new Uint8Array(32).fill(0xb9);
    const old = await openDB(DATABASE_NAME, 5, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        database.createObjectStore('personal', { keyPath: 'id' });
        database.createObjectStore('device');
      },
    });
    const stored: Group = {
      ...ANA,
      kxKey: new Uint8Array(32).fill(0xc6),
      log: [],
      cursor: 3,
      relayNow: 29_000_002,
      instance: 'relay-1',
      outbox: [],
      lastSyncAt: 4,
    };
    const statement = {
      id: 'personal-1',
      title: 'Mine',
      text: 'Kind.',
      createdAt: 1,
      updatedAt: 2,
    };
    const state = {
      key: backupKey,
      digest: 'd5',
      checkedDay: 20_000,
      uploadedAt: 8,
      tooLarge: false,
    };
    await old.put('groups', stored);
    await old.put('personal', statement);
    await old.put('device', state, 'relay-backup');
    old.close();

    const store = await openStore();

    expect(await store.readVault()).toBeNull();
    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
    expect(await store.listPersonal()).toEqual([statement]);
    expect(backupOf(await store.getRelayBackup())).toEqual(backupOf(state));
    await store.sealKeys(LOCK, KEY);
    const canaries = [
      ...secretsOf(ANA),
      ...keyCanaries('kx key', stored.kxKey ?? new Uint8Array()),
      ...keyCanaries('backup key', backupKey),
    ];
    expect(findCanaries(await rawDatabase(), canaries)).toEqual([]);
    store.close();
    const reopened = await openStore();
    await reopened.unlock(KEY);
    expect(keysOf(await reopened.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
    expect(backupOf(await reopened.getRelayBackup())).toEqual(backupOf(state));
    expect(await reopened.listPersonal()).toEqual([statement]);
  });

  it('keeps version 4’s groups and personal Documents', async () => {
    const old = await openDB(DATABASE_NAME, 4, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        database.createObjectStore('personal', { keyPath: 'id' });
      },
    });
    const stored: Group = {
      ...ANA,
      log: [],
      cursor: 2,
      relayNow: null,
      instance: null,
      outbox: [],
      lastSyncAt: null,
    };
    const statement = {
      id: 'personal-1',
      title: 'Mine',
      text: 'Kind.',
      createdAt: 1,
      updatedAt: 2,
    };
    await old.put('groups', stored);
    await old.put('personal', statement);
    old.close();

    const store = await openStore();

    expect(await store.readVault()).toBeNull();
    expect(keysOf(await store.getGroup(ANA.groupId))).toEqual(keysOf(ANA));
    expect(await store.listPersonal()).toEqual([statement]);
  });

  it('keeps version 3’s groups, keys and all', async () => {
    const old = await openDB(DATABASE_NAME, 3, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    const stored: Group = {
      ...ANA,
      log: [],
      cursor: 7,
      relayNow: null,
      instance: null,
      outbox: [],
      lastSyncAt: null,
    };
    await old.put('groups', stored);
    old.close();

    const store = await openStore();

    expect(await store.readVault()).toBeNull();
    const [kept] = await store.listGroups();
    expect(keysOf(kept)).toEqual(keysOf(ANA));
    expect(kept?.cursor).toBe(7);
  });
});
