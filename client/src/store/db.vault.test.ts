/**
 * The store's key vault (#95): once a device seals its keys, IndexedDB holds
 * no secret outside the vault, every later write of key material goes into
 * it, and a new session reads nothing until the passkey's key unlocks it.
 */
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { local, text, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { findCanaries, keyCanaries } from '../test/scan';
import { type BackedUpGroup, DATABASE_NAME, type Group, type NewGroup, openStore } from './db';
import { openKeys, type VaultLock, type VaultRecord } from './vault';
import { VaultLocked } from './db';

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

/** Every byte and string in `value`, concatenated, so a scan sees all of it. */
function bytesIn(value: unknown, into: number[] = []): number[] {
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    const view = value as Uint8Array;
    into.push(...new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 0);
  } else if (typeof value === 'string') {
    into.push(...new TextEncoder().encode(value), 0);
  } else if (typeof value === 'object' && value !== null) {
    for (const [field, inner] of Object.entries(value)) {
      bytesIn(field, into);
      bytesIn(inner, into);
    }
  }
  return into;
}

/** Every record in every object store of the app's database, as raw bytes. */
async function rawDatabase(): Promise<Uint8Array> {
  const db = await openDB(DATABASE_NAME);
  try {
    const all: number[] = [];
    for (const name of db.objectStoreNames) bytesIn(await db.getAll(name), all);
    return Uint8Array.from(all);
  } finally {
    db.close();
  }
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
    expect([...(opened?.keys() ?? [])]).toEqual([ANA.groupId, BEN.groupId]);
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
    expect([...(openKeys(vault, KEY)?.keys() ?? [])]).toEqual([BEN.groupId]);
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
    expect([...(openKeys(vault, KEY)?.keys() ?? [])].sort()).toEqual(
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
      },
      (bytes) => text(bytes),
    );
    await store.markSent(ANA.groupId, record);
    await store.markBackup([ANA.groupId, BEN.groupId], 'saved');
    await store.writeDraft(ANA.groupId, 'atom-1', { title: 'T', why: 'W', text: 'X', link: '' });
    await store.resetCursor(BEN.groupId, 'relay-2');
    await store.markLeaving(BEN.groupId, utf8('{"leave":1}'));

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
