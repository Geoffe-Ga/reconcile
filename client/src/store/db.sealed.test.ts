/**
 * Share keys (#255) and reply keys (#265) under the passkey vault (#95): once
 * a device seals its keys, IndexedDB holds no shared personal Document's
 * seed, signing key or public key, and no sent application's reply seed,
 * reply key or invite seed, outside the vault. Every write of them goes
 * through the one key-writing path, every read that hands them back opens the
 * vault, a locked device refuses both, and records kept before #255 and #265
 * move into the vault the first time the device seals or unlocks.
 */
import { IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { REPLY_INFO, replyMailboxOf, sealPadded } from '../crypto/door';
import { sealVault, vaultKeyFromPrf } from '../crypto/keyVault';
import { publicKeyOf } from '../crypto/sign';
import { checkReplies } from '../door/apply';
import { createRelay } from '../net/relay';
import { concat, local, utf8 } from '../test/bytes';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { type Canary, findCanaries, keyCanaries } from '../test/scan';
import { scanDb } from '../test/scanDb';
import { SENT_CHANGED, type SentApplication } from './applications';
import { DATABASE_NAME, type NewGroup, openStore, type Store, VaultLocked } from './db';
import { deviceSnapshot } from './snapshot';
import type { PersonalDocument, ShareState } from './personal';
import { openKeys, type VaultLock, type VaultRecord } from './vault';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const WRONG_KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x22), SALT);
const LOCK: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

/** 32 bytes no other key in these tests holds, from `fill`. */
const bytes32 = (fill: number) => Uint8Array.from({ length: 32 }, (_, i) => (fill * 11 + i) % 256);

const GROUP: NewGroup = {
  groupId: 'group-ana',
  secret: bytes32(1),
  signingKey: bytes32(2),
  me: { author: 'author-ana', name: 'Ana' },
};

/** A share whose keys are bytes no other share's are. */
function shareOf(fill: number, n = 1): ShareState {
  return {
    seed: bytes32(fill),
    secretKey: bytes32(fill + 1),
    publicKey: publicKeyOf(bytes32(fill + 1)),
    n,
    lastPostedAt: 100 * n,
    pending: false,
  };
}

/** Personal Document `id`, 16 bytes of `fill` in base64url, shared when `share` is given. */
function documentOf(fill: number, share?: ShareState): PersonalDocument {
  const id = base64url(new Uint8Array(16).fill(fill));
  const words = {
    id,
    title: `Doc ${String(fill)}`,
    text: 'Kind.',
    createdAt: fill,
    updatedAt: fill,
  };
  return share === undefined ? words : { ...words, share };
}

const SHARED = documentOf(1, shareOf(10));
const OTHER_SHARED = documentOf(2, shareOf(20));
const PLAIN_DOC = documentOf(3);

/** An application this device sent, its reply seed and key bytes no other's are. */
function sentOf(id: string, fill: number, invite?: Uint8Array): SentApplication {
  return {
    id,
    door: `door-${id}`,
    groupName: 'Riverside Tenants',
    seed: bytes32(fill),
    replyKey: bytes32(fill + 1),
    sentAt: fill,
    ...(invite === undefined ? {} : { invite }),
  };
}

const INVITE = bytes32(40);
const SENT = sentOf('app-1', 30);
const INVITED = sentOf('app-2', 50, INVITE);

/** Every spelling of a share's seed, signing key and public key. */
function shareCanaries(...documents: readonly PersonalDocument[]): Canary[] {
  return documents.flatMap(({ id, share }) =>
    share === undefined
      ? []
      : [
          ...keyCanaries(`${id} seed`, share.seed),
          ...keyCanaries(`${id} signing key`, share.secretKey),
          ...keyCanaries(`${id} public key`, share.publicKey),
        ],
  );
}

/** Every spelling of an application's reply seed and key, and its invite's seed. */
function replyCanaries(...applications: readonly SentApplication[]): Canary[] {
  return applications.flatMap(({ id, seed, replyKey, invite }) => [
    ...keyCanaries(`${id} reply seed`, seed),
    ...keyCanaries(`${id} reply key`, replyKey),
    ...(invite === undefined ? [] : keyCanaries(`${id} invite`, invite)),
  ]);
}

/** Every key and value in every object store of the app's database, as raw bytes. */
async function rawDatabase(): Promise<Uint8Array> {
  const { text: words, bytes } = await scanDb(DATABASE_NAME);
  return concat(utf8(words), ...bytes.flatMap((held) => [Uint8Array.of(0), held]));
}

/** Every canary the raw database holds, in each spelling it holds it. */
async function found(canaries: readonly Canary[]): Promise<string[]> {
  return findCanaries(await rawDatabase(), canaries);
}

/** The label of each of `canaries` the raw database holds in some spelling. */
async function labelsFound(canaries: readonly Canary[]): Promise<string[]> {
  const lines = await found(canaries);
  return canaries
    .map(({ label }) => label)
    .filter((label) => lines.some((line) => line.startsWith(`${label}, as `)));
}

/** The labels of `canaries`' raw bytes: what a scan of keys kept as bytes finds. */
const rawLabels = (canaries: readonly Canary[]): string[] =>
  canaries.map(({ label }) => label).filter((label) => label.endsWith('(raw)'));

/** Each record of `store` as IndexedDB holds it, read with no store in between. */
async function rawRecords(store: string): Promise<Record<string, unknown>[]> {
  const db = await openDB(DATABASE_NAME);
  try {
    return (await db.getAll(store)) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** The vault, opened under {@link KEY}. */
async function openedVault() {
  const db = await openDB(DATABASE_NAME);
  const vault = (await db.get('vault', 'vault')) as VaultRecord | undefined;
  db.close();
  if (vault === undefined) throw new Error('Expected a vault.');
  const keys = openKeys(vault, KEY);
  if (keys === null) throw new Error('Expected the vault to open.');
  return keys;
}

/** A Document with every byte array in the test's realm, so `toEqual` can compare it. */
function comparableDocument(document: PersonalDocument | undefined) {
  if (document?.share === undefined) return document;
  const { seed, secretKey, publicKey } = document.share;
  return {
    ...document,
    share: {
      ...document.share,
      seed: local(seed),
      secretKey: local(secretKey),
      publicKey: local(publicKey),
    },
  };
}

/** An application with every byte array in the test's realm, so `toEqual` can compare it. */
function comparableSent(sent: SentApplication | undefined) {
  if (sent === undefined) return undefined;
  const { seed, replyKey, invite } = sent;
  return {
    ...sent,
    seed: local(seed),
    replyKey: local(replyKey),
    ...(invite === undefined ? {} : { invite: local(invite) }),
  };
}

/** A device holding a group, two shared Documents, one unshared, and two sent applications. */
async function plainDevice(): Promise<Store> {
  const store = await openStore();
  await store.addGroup(GROUP);
  for (const document of [SHARED, OTHER_SHARED, PLAIN_DOC]) {
    await store.savePersonal(document);
    const { share } = document;
    if (share !== undefined) await store.updateShare(document.id, () => share);
  }
  await store.addSent(SENT);
  await store.addSent(INVITED);
  return store;
}

/** That device with its keys sealed under {@link KEY}. */
async function sealedDevice(): Promise<Store> {
  const store = await plainDevice();
  await store.sealKeys(LOCK, KEY);
  return store;
}

/** A new session on the sealed device, still locked. */
async function lockedDevice(): Promise<Store> {
  (await sealedDevice()).close();
  return openStore();
}

const ALL_KEYS = [...shareCanaries(SHARED, OTHER_SHARED), ...replyCanaries(SENT, INVITED)];

describe('a device with no vault keeps share and reply keys on their records, as before', () => {
  it('reads and writes them there, and the scan finds them, so a clean scan means something', async () => {
    const store = await plainDevice();

    expect(await store.readVault()).toBeNull();
    expect(await labelsFound(ALL_KEYS)).toEqual(rawLabels(ALL_KEYS));
    expect(comparableDocument(await store.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    expect((await store.listSent()).map(comparableSent)).toEqual(
      [SENT, INVITED].map(comparableSent),
    );
    const [record] = await rawRecords('sent');
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'door',
      'groupName',
      'id',
      'replyKey',
      'seed',
      'sentAt',
    ]);
  });
});

describe('sealKeys with shares and sent applications (#255, #265)', () => {
  it('moves every share key and reply key into the vault, leaving each record what it says', async () => {
    const store = await sealedDevice();

    expect(await found(ALL_KEYS)).toEqual([]);
    const documents = await rawRecords('personal');
    expect(documents.map((document) => Object.keys(document.share ?? {}).sort())).toEqual([
      ['lastPostedAt', 'n', 'pending'],
      ['lastPostedAt', 'n', 'pending'],
      [],
    ]);
    expect((await rawRecords('sent')).map((sent) => Object.keys(sent).sort())).toEqual([
      ['door', 'groupName', 'id', 'sentAt'],
      ['door', 'groupName', 'id', 'sentAt'],
    ]);
    const vault = await openedVault();
    expect([...(vault.records.get('personal')?.keys() ?? [])].sort()).toEqual(
      [SHARED.id, OTHER_SHARED.id].sort(),
    );
    expect([...(vault.records.get('sent')?.keys() ?? [])].sort()).toEqual(['app-1', 'app-2']);
    expect(Object.keys(vault.records.get('sent')?.get('app-2') ?? {}).sort()).toEqual([
      'invite',
      'replyKey',
      'seed',
    ]);
    expect(comparableDocument(await store.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    expect((await store.listPersonal()).map(comparableDocument)).toEqual(
      [SHARED, OTHER_SHARED, PLAIN_DOC].map(comparableDocument),
    );
    expect((await store.listSent()).map(comparableSent)).toEqual(
      [SENT, INVITED].map(comparableSent),
    );
  });
});

describe('every later write of share and reply keys, with a vault', () => {
  it('seals a new share, a changed one and a restored one, and drops a stopped one from the vault', async () => {
    const store = await sealedDevice();
    const fresh = documentOf(4);
    const restored = documentOf(5, shareOf(60));
    await store.savePersonal(fresh);

    await store.updateShare(fresh.id, () => shareOf(70));
    await store.updateShare(SHARED.id, (held) =>
      held.share ? { ...held.share, n: 9 } : undefined,
    );
    await store.updateShare(OTHER_SHARED.id, () => undefined);
    await store.restoreGroups([], [restored]);

    const added = { ...fresh, share: shareOf(70) };
    expect(await found([...shareCanaries(SHARED, OTHER_SHARED, added, restored)])).toEqual([]);
    expect((await store.getPersonal(SHARED.id))?.share?.n).toBe(9);
    expect((await store.getPersonal(OTHER_SHARED.id))?.share).toBeUndefined();
    expect(comparableDocument(await store.getPersonal(fresh.id))).toEqual(
      comparableDocument(added),
    );
    // A share a restore brings back starts paused (#328).
    expect(comparableDocument(await store.getPersonal(restored.id))).toEqual(
      comparableDocument({ ...restored, share: { ...shareOf(60), paused: true } }),
    );
    expect([...((await openedVault()).records.get('personal')?.keys() ?? [])].sort()).toEqual(
      [SHARED.id, fresh.id, restored.id].sort(),
    );
  });

  it('keeps a share’s mark when the editor saves, marking it pending, and writes no key', async () => {
    const store = await sealedDevice();

    await store.savePersonal({ ...textOnly(SHARED), text: 'Kinder.', updatedAt: 9 });

    expect(await found(shareCanaries(SHARED))).toEqual([]);
    const held = await store.getPersonal(SHARED.id);
    expect([held?.text, held?.share?.pending]).toEqual(['Kinder.', true]);
    expect(local(held?.share?.seed ?? new Uint8Array())).toEqual(
      local(SHARED.share?.seed ?? new Uint8Array()),
    );
  });

  it('seals a new application, its invite once a reply opens, and drops a forgotten one', async () => {
    const store = await sealedDevice();
    const third = sentOf('app-3', 80);
    const invite = bytes32(90);
    const heard: string[] = [];
    store.subscribe((changed) => heard.push(changed));

    await store.addSent(third);
    await store.updateSent('app-3', (held) => ({ ...held, invite }));
    await store.dropSent('app-1');

    expect(await found(replyCanaries(SENT, INVITED, { ...third, invite }))).toEqual([]);
    expect((await store.listSent()).map(comparableSent)).toEqual(
      [INVITED, { ...third, invite }].map(comparableSent),
    );
    expect([...((await openedVault()).records.get('sent')?.keys() ?? [])].sort()).toEqual([
      'app-2',
      'app-3',
    ]);
    expect(heard).toEqual([SENT_CHANGED, SENT_CHANGED, SENT_CHANGED]);
  });

  it('takes a deleted shared Document’s keys out of the vault, and deletes an unshared one too', async () => {
    const store = await sealedDevice();

    await store.deletePersonal(SHARED.id);
    await store.deletePersonal(PLAIN_DOC.id);
    await store.deletePersonal('missing');

    expect((await store.listPersonal()).map((document) => document.id)).toEqual([OTHER_SHARED.id]);
    expect([...((await openedVault()).records.get('personal')?.keys() ?? [])]).toEqual([
      OTHER_SHARED.id,
    ]);
  });

  it('carries each share’s keys into a backup’s snapshot, read from the vault', async () => {
    const store = await sealedDevice();

    const snapshot = await deviceSnapshot(store);

    expect(snapshot.personal.map(comparableDocument)).toEqual(
      [SHARED, OTHER_SHARED, PLAIN_DOC].map(comparableDocument),
    );
  });
});

describe('a share a restore paused, on a device whose keys are sealed (#328)', () => {
  it('keeps the pause on its record’s mark, with no key there, so it reads paused locked and unlocked', async () => {
    const store = await sealedDevice();
    const brought = documentOf(5, shareOf(60));
    const paused = { ...brought, share: { ...shareOf(60), paused: true as const } };

    await store.restoreGroups([], [brought]);

    expect(comparableDocument(await store.getPersonal(brought.id))).toEqual(
      comparableDocument(paused),
    );
    store.close();
    const locked = await openStore();
    const entries = await locked.listPersonalEntries();
    expect(entries.find(({ id }) => id === brought.id)?.share).toEqual({
      n: 1,
      lastPostedAt: 100,
      pending: false,
      paused: true,
    });
    expect(await found(shareCanaries(brought))).toEqual([]);
    expect(await locked.unlock(KEY)).toBe(true);
    expect(comparableDocument(await locked.getPersonal(brought.id))).toEqual(
      comparableDocument(paused),
    );
  });
});

describe('a locked device’s shares and sent applications', () => {
  it('lists every Document with its share’s mark, so a share still reads as on, and keys in none', async () => {
    const store = await lockedDevice();

    const entries = await store.listPersonalEntries();

    const mark = { n: 1, lastPostedAt: 100, pending: false };
    expect(entries).toEqual([
      { ...textOnly(SHARED), share: mark },
      { ...textOnly(OTHER_SHARED), share: mark },
      PLAIN_DOC,
    ]);
  });

  it('refuses every read that would hand back a share’s keys, but reads an unshared Document', async () => {
    const store = await lockedDevice();

    await expect(store.getPersonal(SHARED.id)).rejects.toThrow(VaultLocked);
    await expect(store.listPersonal()).rejects.toThrow(VaultLocked);
    expect(await store.getPersonal(PLAIN_DOC.id)).toEqual(PLAIN_DOC);
    expect(await store.getPersonal('missing')).toBeUndefined();
  });

  it('refuses to change or stop a share, or delete a shared Document, writing nothing', async () => {
    const store = await lockedDevice();
    const before = await rawDatabase();

    await expect(store.updateShare(SHARED.id, () => undefined)).rejects.toThrow(VaultLocked);
    await expect(store.updateShare(PLAIN_DOC.id, () => shareOf(70))).rejects.toThrow(VaultLocked);
    await expect(store.updateShare('missing', () => undefined)).rejects.toThrow(VaultLocked);
    await expect(store.deletePersonal(SHARED.id)).rejects.toThrow(VaultLocked);
    await expect(store.restoreGroups([], [documentOf(5, shareOf(60))])).rejects.toThrow(
      VaultLocked,
    );

    expect(local(await rawDatabase())).toEqual(local(before));
  });

  it('still saves the editor’s words and deletes an unshared Document, writing no key', async () => {
    const store = await lockedDevice();

    await store.savePersonal({ ...textOnly(SHARED), text: 'Kinder.', updatedAt: 9 });
    await store.deletePersonal(PLAIN_DOC.id);

    const entries = await store.listPersonalEntries();
    expect(entries.map((entry) => [entry.id, entry.text, entry.share?.pending])).toEqual([
      [SHARED.id, 'Kinder.', true],
      [OTHER_SHARED.id, 'Kind.', false],
    ]);
    expect(await found(ALL_KEYS)).toEqual([]);
  });

  it('refuses to read, add, change or drop a sent application, writing nothing', async () => {
    const store = await lockedDevice();
    const before = await rawDatabase();

    await expect(store.listSent()).rejects.toThrow(VaultLocked);
    await expect(store.addSent(sentOf('app-3', 80))).rejects.toThrow(VaultLocked);
    await expect(
      store.updateSent('app-1', (held) => ({ ...held, invite: INVITE })),
    ).rejects.toThrow(VaultLocked);
    await expect(store.dropSent('app-1')).rejects.toThrow(VaultLocked);

    expect(local(await rawDatabase())).toEqual(local(before));
  });

  it('reads every share and application whole once unlocked, writing nothing', async () => {
    const store = await lockedDevice();
    const before = await rawDatabase();

    expect(await store.unlock(KEY)).toBe(true);

    expect(local(await rawDatabase())).toEqual(local(before));
    expect((await store.listPersonal()).map(comparableDocument)).toEqual(
      [SHARED, OTHER_SHARED, PLAIN_DOC].map(comparableDocument),
    );
    expect((await store.listSent()).map(comparableSent)).toEqual(
      [SENT, INVITED].map(comparableSent),
    );
  });
});

/** `document`'s words and times, with no share. */
function textOnly(document: PersonalDocument) {
  const { id, title, text, createdAt, updatedAt } = document;
  return { id, title, text, createdAt, updatedAt };
}

/** A version 7 database, as #105 and #121 left one: every store, with these records in them. */
async function version7(fill: {
  personal: readonly PersonalDocument[];
  sent: readonly SentApplication[];
  vault?: VaultRecord;
}): Promise<void> {
  const old = await openDB(DATABASE_NAME, 7, {
    upgrade(database) {
      database.createObjectStore('groups', { keyPath: 'groupId' });
      database.createObjectStore('personal', { keyPath: 'id' });
      database.createObjectStore('device');
      database.createObjectStore('vault', { keyPath: 'id' });
      database.createObjectStore('sent', { keyPath: 'id' });
    },
  });
  const group = {
    ...GROUP,
    log: [],
    cursor: 0,
    relayNow: null,
    instance: null,
    outbox: [],
    lastSyncAt: null,
  };
  if (fill.vault === undefined) {
    await old.put('groups', group);
  } else {
    // #95 sealed the group's keys and left its record without them.
    const record: Record<string, unknown> = { ...group };
    delete record.secret;
    delete record.signingKey;
    await old.put('groups', record);
    await old.put('vault', fill.vault);
  }
  for (const document of fill.personal) await old.put('personal', document);
  for (const sent of fill.sent) await old.put('sent', sent);
  old.close();
}

/** A format 1 vault, as #95 sealed it under {@link KEY}, holding the group's keys and nothing else. */
function formatOneVault(): VaultRecord {
  const plaintext = utf8(
    JSON.stringify({
      format: 1,
      groups: [
        {
          groupId: GROUP.groupId,
          secret: base64url(GROUP.secret),
          signingKey: base64url(GROUP.signingKey),
        },
      ],
    }),
  );
  return { id: 'vault', ...LOCK, sealed: sealVault(KEY, LOCK.credentialId, plaintext) };
}

describe('moving share and reply keys kept before #255 and #265 into the vault', () => {
  it('a version 7 device with no passkey keeps them as they were, then seals them with its keys', async () => {
    await version7({ personal: [SHARED, PLAIN_DOC], sent: [INVITED] });
    const store = await openStore();

    expect(comparableDocument(await store.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    expect(await found(shareCanaries(SHARED))).not.toEqual([]);
    await store.sealKeys(LOCK, KEY);
    store.close();

    expect(await found([...shareCanaries(SHARED), ...replyCanaries(INVITED)])).toEqual([]);
    const reopened = await openStore();
    await expect(reopened.listSent()).rejects.toThrow(VaultLocked);
    await reopened.unlock(KEY);
    expect(comparableDocument(await reopened.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    expect((await reopened.listSent()).map(comparableSent)).toEqual([comparableSent(INVITED)]);
  });

  it('a version 7 device #95 sealed moves them in at its first unlock, as format 2, and a reply still opens', async () => {
    const fake = createFakeRelay();
    await version7({ personal: [SHARED, PLAIN_DOC], sent: [SENT], vault: formatOneVault() });
    const invite = bytes32(91);
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = replyMailboxOf(SENT.seed);
    const reply = utf8(`https://reconcile.test/#join/${base64url(invite)}`);
    await relay.putBlob(
      mailbox,
      sealPadded(kxPublicKeyOf(SENT.replyKey), reply, REPLY_INFO, mailbox),
      2,
    );
    const store = await openStore();
    const before = await rawDatabase();

    await expect(store.getPersonal(SHARED.id)).rejects.toThrow(VaultLocked);
    await expect(store.listSent()).rejects.toThrow(VaultLocked);
    expect(await store.unlock(WRONG_KEY)).toBe(false);
    expect(local(await rawDatabase())).toEqual(local(before));
    expect(await store.unlock(KEY)).toBe(true);

    expect(await found([...shareCanaries(SHARED), ...replyCanaries(SENT)])).toEqual([]);
    const vault = await openedVault();
    expect([...vault.groups.keys()]).toEqual([GROUP.groupId]);
    expect([...(vault.records.get('personal')?.keys() ?? [])]).toEqual([SHARED.id]);
    expect([...(vault.records.get('sent')?.keys() ?? [])]).toEqual([SENT.id]);
    expect(comparableDocument(await store.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    await checkReplies({ relay, store, now: () => SENT.sentAt + 1 });
    expect(local((await store.listSent())[0]?.invite ?? new Uint8Array())).toEqual(local(invite));
    expect(await found(keyCanaries('invite', invite))).toEqual([]);
  });
});

describe('a first unlock with one record to move', () => {
  it.each([
    ['a shared Document', { personal: [SHARED], sent: [] }, shareCanaries(SHARED)],
    ['a sent application', { personal: [PLAIN_DOC], sent: [INVITED] }, replyCanaries(INVITED)],
  ])('moves %s alone into the vault', async (_name, records, canaries) => {
    await version7({ ...records, vault: formatOneVault() });
    const store = await openStore();

    expect(await store.unlock(KEY)).toBe(true);

    expect(await found(canaries)).toEqual([]);
    expect(await store.listPersonal()).toHaveLength(records.personal.length);
    expect(await store.listSent()).toHaveLength(records.sent.length);
  });
});

describe('an unlock whose move into the vault fails', () => {
  it('keeps no key and leaves every record as it was, so the next unlock tries again', async () => {
    await version7({ personal: [SHARED], sent: [SENT], vault: formatOneVault() });
    const store = await openStore();
    const before = await rawDatabase();
    const put = vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded.', 'QuotaExceededError');
    });

    await expect(store.unlock(KEY)).rejects.toThrow('Quota exceeded.');
    put.mockRestore();

    expect(local(await rawDatabase())).toEqual(local(before));
    await expect(store.listSent()).rejects.toThrow(VaultLocked);
    await expect(store.requireUnlocked()).rejects.toThrow(VaultLocked);
    expect(await store.unlock(KEY)).toBe(true);
    expect(await found([...shareCanaries(SHARED), ...replyCanaries(SENT)])).toEqual([]);
  });
});

describe('Restore on the unlock screen, with shares and sent applications', () => {
  it('gives a Document whose share went with the vault the file’s share, or none, and forgets sent applications', async () => {
    const store = await lockedDevice();
    const heard: string[] = [];
    store.subscribe((changed) => heard.push(changed));
    const fileShare = shareOf(10, 4);
    // The file's copy is older, so the device's words stay, with the file's share.
    const fileCopy: PersonalDocument = {
      ...SHARED,
      text: 'Older.',
      updatedAt: 0,
      share: fileShare,
    };

    await store.replaceGroups([], [fileCopy]);

    expect(await store.readVault()).toBeNull();
    const shared = await store.getPersonal(SHARED.id);
    expect(comparableDocument(shared)).toEqual(
      comparableDocument({ ...SHARED, share: { ...fileShare, pending: true } }),
    );
    expect(await store.getPersonal(OTHER_SHARED.id)).toEqual(textOnly(OTHER_SHARED));
    expect(await store.getPersonal(PLAIN_DOC.id)).toEqual(PLAIN_DOC);
    expect(await store.listSent()).toEqual([]);
    expect(heard).toContain(SENT_CHANGED);
  });

  it('takes the file’s later copy whole, and leaves a plain device’s shares and applications alone', async () => {
    const locked = await lockedDevice();
    const later: PersonalDocument = {
      ...SHARED,
      text: 'Later.',
      updatedAt: 50,
      share: shareOf(10, 6),
    };
    await locked.replaceGroups([], [later]);
    expect(comparableDocument(await locked.getPersonal(SHARED.id))).toEqual(
      comparableDocument(later),
    );
    locked.close();

    const plain = await openStore('plain');
    await plain.savePersonal(SHARED);
    const { share } = SHARED;
    if (share !== undefined) await plain.updateShare(SHARED.id, () => share);
    await plain.addSent(SENT);
    const heard: string[] = [];
    plain.subscribe((changed) => heard.push(changed));

    await plain.replaceGroups([], []);

    expect(comparableDocument(await plain.getPersonal(SHARED.id))).toEqual(
      comparableDocument(SHARED),
    );
    expect((await plain.listSent()).map(comparableSent)).toEqual([comparableSent(SENT)]);
    expect(heard).not.toContain(SENT_CHANGED);
  });
});
