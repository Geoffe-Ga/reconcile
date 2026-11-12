/**
 * What the store does for a backup (#78): restoring groups and personal
 * Documents (#93) from a file in one transaction, keeping whichever whole
 * copy synced or was edited later, and marking groups as in a backup, or the
 * backup card as answered.
 */
import {
  IDBDatabase as FakeIDBDatabase,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { local, text, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { type BackedUpGroup, DATABASE_NAME, type Group, type NewGroup, openStore } from './db';
import type { PersonalDocument } from './personal';

freshIndexedDBPerTest();

const ana: NewGroup = {
  groupId: 'group-1',
  secret: new Uint8Array(32).fill(9),
  signingKey: new Uint8Array(32).fill(7),
  me: { author: 'author-ana', name: 'Ana' },
};

/** A test's event id: the bytes as text. */
const idOf = (bytes: Uint8Array): string => text(bytes);

/** A backed-up copy of `ana`'s group, synced at `lastSyncAt`. */
function copy(lastSyncAt: number | null, overrides: Partial<BackedUpGroup> = {}): BackedUpGroup {
  return {
    ...ana,
    log: [{ seq: 3, received: 29_000_003, bytes: utf8('{"from":"file"}') }],
    cursor: 5,
    relayNow: 29_000_010,
    instance: 'relay-1',
    lastSyncAt,
    missingHistory: false,
    ...overrides,
  };
}

/** How a restored copy reads until it hears from its group (#231): since the file's last relay minute. */
const READ_ONLY = { archived: { reason: 'unconfirmed', since: 29_000_010 } } as const;

/** A stored group with its bytes in the test's realm, so `toEqual` can compare it. */
function comparable(group: Group | undefined) {
  if (group === undefined) return undefined;
  return {
    ...group,
    secret: local(group.secret),
    signingKey: local(group.signingKey),
    log: group.log.map((record) => ({ ...record, bytes: text(record.bytes) })),
    outbox: group.outbox.map(text),
  };
}

/**
 * A device holding `ana`'s group, last synced at `lastSyncAt`, with an unsent
 * event, a chat bot claim (#119) and a draft.
 */
async function deviceWithGroup(lastSyncAt: number) {
  const store = await openStore();
  await store.addGroup(ana);
  const pull = {
    records: [{ seq: 1, received: 29_000_001, bytes: utf8('{"from":"device"}') }],
    cursor: 1,
    relayNow: 29_000_002,
    instance: 'relay-1',
    lastSyncAt,
  };
  await store.applyPull(ana.groupId, pull, idOf);
  await store.enqueue(ana.groupId, utf8('{"unsent":1}'));
  const claim = { id: 'claim-1', proposal: 'proposal-1', moment: 'open' } as const;
  await store.claimChat(ana.groupId, utf8('{"claim":1}'), claim);
  await store.writeDraft(ana.groupId, 'atom-1', { title: 'T', why: 'W', text: 'X', link: '' });
  return store;
}

describe('restoreGroups', () => {
  it('keeps a group new to the device exactly as the file has it, with no outbox or drafts, marked as saved and read-only for now', async () => {
    const store = await openStore();

    await store.restoreGroups([copy(1_000, { missingHistory: true })]);

    expect(comparable(await store.getGroup(ana.groupId))).toEqual({
      ...comparable({ ...copy(1_000), outbox: [] }),
      ...READ_ONLY,
      missingHistory: true,
      backup: 'saved',
    });
  });

  it('never stamps a restored group with the time, so a later sync can still see the gap', async () => {
    const store = await openStore();

    await store.restoreGroups([copy(null), { ...copy(5), groupId: 'group-2' }]);

    expect((await store.getGroup(ana.groupId))?.lastSyncAt).toBeNull();
    expect((await store.getGroup('group-2'))?.lastSyncAt).toBe(5);
  });

  it('replaces a group already here with the file’s whole copy when the file’s synced later, its outbox, drafts and chat claims gone', async () => {
    const store = await deviceWithGroup(1_000);

    await store.restoreGroups([copy(2_000)]);

    expect(comparable(await store.getGroup(ana.groupId))).toEqual(
      comparable({ ...copy(2_000), ...READ_ONLY, outbox: [], backup: 'saved' }),
    );
  });

  it('keeps this device’s push registration and posted nudges when the file’s copy replaces its own (#99)', async () => {
    const store = await deviceWithGroup(1_000);
    const push = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      mailboxes: ['mailbox-1'],
      instance: 'relay-1',
      at: 29_000_002,
    };
    await store.setPush(ana.groupId, push);
    await store.markNudged(ana.groupId, ['p1@29010080']);

    await store.restoreGroups([copy(2_000)]);

    const kept = await store.getGroup(ana.groupId);
    expect(kept?.cursor).toBe(5);
    expect(kept?.push).toEqual(push);
    expect(kept?.nudged).toEqual(['p1@29010080']);
  });

  it('keeps no push registration or nudges in a copy the file brings back read-only (#108)', async () => {
    const store = await deviceWithGroup(1_000);
    const push = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      mailboxes: ['mailbox-1'],
      instance: 'relay-1',
      at: 29_000_002,
    };
    await store.setPush(ana.groupId, push);
    await store.markNudged(ana.groupId, ['p1@29010080']);

    // A file whose log folds to a dissolve comes back marked so (snapshot.ts).
    await store.restoreGroups([copy(2_000, { archived: { reason: 'dissolved' } })]);

    const kept = await store.getGroup(ana.groupId);
    expect([kept?.cursor, kept?.archived]).toEqual([5, { reason: 'dissolved' }]);
    expect([kept?.push, kept?.nudged]).toEqual([undefined, undefined]);
  });

  it.each([
    ['synced later', 3_000],
    ['synced at the same time', 2_000],
  ])('keeps the device’s whole copy when it %s, marked as saved', async (_when, deviceSync) => {
    const store = await deviceWithGroup(deviceSync);
    const before = comparable(await store.getGroup(ana.groupId));

    await store.restoreGroups([copy(2_000)]);

    expect(comparable(await store.getGroup(ana.groupId))).toEqual({ ...before, backup: 'saved' });
  });

  it('keeps a device copy over a file copy that never synced', async () => {
    const store = await deviceWithGroup(1);
    const before = comparable(await store.getGroup(ana.groupId));

    await store.restoreGroups([copy(null)]);

    expect(comparable(await store.getGroup(ana.groupId))).toEqual({ ...before, backup: 'saved' });
  });

  it('keeps a group this device is leaving as it is, whatever the file holds', async () => {
    const store = await deviceWithGroup(1_000);
    await store.markLeaving(ana.groupId, utf8('{"leave":1}'));
    const before = comparable(await store.getGroup(ana.groupId));

    await store.restoreGroups([copy(9_000)]);

    expect(comparable(await store.getGroup(ana.groupId))).toEqual({ ...before, backup: 'saved' });
  });

  it('keeps a linked group new to the device with no backup mark, since no backup file holds it (#96)', async () => {
    const store = await openStore();

    await store.restoreGroups([copy(1_000)], [], 'link');

    const kept = await store.getGroup(ana.groupId);
    expect(kept?.backup).toBeUndefined();
    expect(comparable(kept)).toEqual(comparable({ ...copy(1_000), ...READ_ONLY, outbox: [] }));
  });

  it.each([
    ['the link’s copy replaces it', 1_000, 2_000],
    ['the device’s copy stays', 3_000, 2_000],
  ])(
    'leaves a group’s own backup mark when a link brings it and %s (#96)',
    async (_when, deviceSync, linkSync) => {
      const store = await deviceWithGroup(deviceSync);
      await store.markBackup([ana.groupId], 'not-now');

      await store.restoreGroups([copy(linkSync)], [], 'link');

      const kept = await store.getGroup(ana.groupId);
      expect(kept?.backup).toBe('not-now');
      expect(kept?.lastSyncAt).toBe(Math.max(deviceSync, linkSync));
    },
  );

  it('writes every group in one transaction, then tells subscribers which changed', async () => {
    const store = await openStore();
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');

    await store.restoreGroups([copy(1), { ...copy(2), groupId: 'group-2' }]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[1]).toBe('readwrite');
    expect(heard).toEqual([ana.groupId, 'group-2']);
    transaction.mockRestore();
  });
});

describe('restoreGroups with personal Documents (#93)', () => {
  /** A personal Document, last edited at `updatedAt`. */
  function statement(id: string, updatedAt: number, text = `Edited at ${String(updatedAt)}.`) {
    return { id, title: 'My mission statement', text, createdAt: 1, updatedAt };
  }
  const FIRST = 'AAAAAAAAAAAAAAAAAAAAAA';
  const SECOND = 'BBBBBBBBBBBBBBBBBBBBBA';

  it('keeps a Document new to the device as the file has it', async () => {
    const store = await openStore();

    await store.restoreGroups([], [statement(FIRST, 5), statement(SECOND, 6)]);

    expect(await store.listPersonal()).toEqual([statement(FIRST, 5), statement(SECOND, 6)]);
  });

  it('replaces the device’s copy only with one edited later; a tie keeps the device’s', async () => {
    const store = await openStore();
    await store.savePersonal(statement(FIRST, 5, 'Older on the device.'));
    await store.savePersonal(statement(SECOND, 9, 'Newer on the device.'));
    const third = 'CCCCCCCCCCCCCCCCCCCCCA';
    await store.savePersonal(statement(third, 7, 'Same time on the device.'));

    await store.restoreGroups(
      [],
      [
        statement(FIRST, 6, 'Newer in the file.'),
        statement(SECOND, 8, 'Older in the file.'),
        statement(third, 7, 'Same time in the file.'),
      ],
    );

    expect((await store.listPersonal()).map((kept) => kept.text)).toEqual([
      'Newer in the file.',
      'Newer on the device.',
      'Same time on the device.',
    ]);
  });

  it('keeps the file’s groups and Documents in one transaction over every store, the relay backup’s, the vault and the sent applications’ included (#95, #97, #265)', async () => {
    const store = await openStore();
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');

    await store.restoreGroups([copy(1)], [statement(FIRST, 5)]);
    const calls = transaction.mock.calls.map(([names, mode]) => [names, mode]);
    transaction.mockRestore();

    expect(calls).toEqual([[['groups', 'personal', 'device', 'vault', 'sent'], 'readwrite']]);
    expect((await store.listGroups()).map((group) => group.groupId)).toEqual([ana.groupId]);
    expect(await store.listPersonal()).toEqual([statement(FIRST, 5)]);
  });

  it('writes nothing at all when any part fails, groups included', async () => {
    const store = await openStore();
    const keyless = { ...statement(FIRST, 5), id: undefined } as unknown as PersonalDocument;
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await expect(store.restoreGroups([copy(1)], [statement(SECOND, 5), keyless])).rejects.toThrow();

    expect(await store.listGroups()).toEqual([]);
    expect(await store.listPersonal()).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('fails with the write’s own error when that failure already aborted the transaction', async () => {
    const store = await openStore();
    const put = vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementationOnce(function (
      this: IDBObjectStore,
    ) {
      this.transaction.abort();
      throw new Error('Quota exceeded.');
    });

    const restoring = store.restoreGroups([copy(1)], [statement(FIRST, 5)]);

    await expect(restoring).rejects.toThrow('Quota exceeded.');
    put.mockRestore();
    expect(await store.listGroups()).toEqual([]);
    expect(await store.listPersonal()).toEqual([]);
  });

  it('restores groups alone when the file holds no Documents, as an older backup does', async () => {
    const store = await openStore();
    await store.savePersonal(statement(FIRST, 5));

    await store.restoreGroups([copy(1)]);

    expect((await store.listGroups()).map((group) => group.groupId)).toEqual([ana.groupId]);
    expect(await store.listPersonal()).toEqual([statement(FIRST, 5)]);
  });
});

describe('markBackup', () => {
  it('marks each group still here, in one transaction, and tells subscribers', async () => {
    const store = await openStore();
    await store.addGroup(ana);
    await store.addGroup({ ...ana, groupId: 'group-2' });
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');

    await store.markBackup([ana.groupId, 'gone'], 'saved');
    await store.markBackup(['group-2'], 'not-now');

    expect(transaction).toHaveBeenCalledTimes(2);
    expect((await store.getGroup(ana.groupId))?.backup).toBe('saved');
    expect((await store.getGroup('group-2'))?.backup).toBe('not-now');
    expect(await store.getGroup('gone')).toBeUndefined();
    expect(heard).toEqual([ana.groupId, 'group-2']);
    transaction.mockRestore();
  });

  it('leaves a new group unmarked', async () => {
    const store = await openStore();

    const added = await store.addGroup(ana);

    expect(added.backup).toBeUndefined();
    expect((await store.getGroup(ana.groupId))?.backup).toBeUndefined();
  });
});

describe('the store’s database', () => {
  it('is named reconcile', () => {
    expect(DATABASE_NAME).toBe('reconcile');
  });

  it('closes when another tab deletes it, so the delete never waits on this one', async () => {
    const store = await openStore();
    await store.addGroup(ana);

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error('The delete failed.'));
      };
    });

    const reopened = await openStore();
    expect(await reopened.listGroups()).toEqual([]);
    reopened.close();
  });
});
