import { IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';

import { MAX_PLAINTEXT_BYTES, PayloadTooLarge } from '../crypto/seal';
import { local, text, utf8 } from '../test/bytes';
import { TEST_MAILBOX } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore } from './db';
import type { NewGroup, Pull } from './db';

freshIndexedDBPerTest();

const group: NewGroup = {
  groupId: 'group-1',
  mailbox: TEST_MAILBOX,
  secret: new Uint8Array(32).fill(9),
  signingKey: new Uint8Array(32).fill(7),
  me: { author: 'author-ana', name: 'Ana' },
};

/** A test's event id: the bytes as text, or `null` for anything not JSON-like. */
function idOf(bytes: Uint8Array): string | null {
  const body = text(bytes);
  return body.startsWith('{') ? body : null;
}

function pull(records: Pull['records'], cursor: number): Pull {
  return {
    records,
    cursor,
    relayNow: 29_000_010,
    instance: 'relay-1',
    lastSyncAt: 1_762_650_000_000,
  };
}

describe('a group in the store', () => {
  it('starts with an empty log and outbox, and no sync yet', async () => {
    const store = await openStore();

    await store.addGroup(group);

    const groups = await store.listGroups();
    const copies = groups.map((stored) => ({
      ...stored,
      secret: local(stored.secret),
      signingKey: local(stored.signingKey),
    }));
    expect(copies).toEqual([
      {
        ...group,
        log: [],
        cursor: 0,
        relayNow: null,
        instance: null,
        outbox: [],
        lastSyncAt: null,
      },
    ]);
  });

  it('refuses a second group with the same id, keeping the first', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"n":1}'));

    await expect(
      store.addGroup({ ...group, me: { author: 'author-ben', name: 'Ben' } }),
    ).rejects.toThrow();

    const [kept] = await store.listGroups();
    expect(kept?.me.name).toBe('Ana');
    expect(kept?.outbox.map(text)).toEqual(['{"n":1}']);
  });

  it('comes back after a reload, with its log, outbox and sync state', async () => {
    const first = await openStore();
    await first.addGroup(group);
    await first.applyPull(
      group.groupId,
      pull([{ seq: 4, received: 9, bytes: utf8('{"g":1}') }], 4),
      idOf,
    );
    await first.enqueue(group.groupId, utf8('{"n":1}'));
    first.close();

    const reloaded = await openStore();

    const [back] = await reloaded.listGroups();
    expect(back?.log.map((record) => [record.seq, record.received, text(record.bytes)])).toEqual([
      [4, 9, '{"g":1}'],
    ]);
    expect(back?.outbox.map(text)).toEqual(['{"n":1}']);
    expect(back).toMatchObject({ cursor: 4, relayNow: 29_000_010, instance: 'relay-1' });
  });

  it('deletes the stub era’s unsigned data when it upgrades, migrating none of it', async () => {
    const old = await openDB('reconcile', 1, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    await old.put('groups', { groupId: 'stub-era', me: { author: 'random-id', name: 'Ana' } });
    old.close();

    const store = await openStore();

    expect(await store.listGroups()).toEqual([]);
    await store.addGroup(group);
    expect((await store.listGroups()).map((stored) => stored.groupId)).toEqual(['group-1']);
  });

  it('keeps separately named stores apart', async () => {
    const ana = await openStore('ana');
    const ben = await openStore('ben');

    await ana.addGroup(group);

    expect(await ben.listGroups()).toEqual([]);
    expect(await ben.getGroup(group.groupId)).toBeUndefined();
  });
});

describe('enqueue', () => {
  it('queues events in the order they were made', async () => {
    const store = await openStore();
    await store.addGroup(group);

    await store.enqueue(group.groupId, utf8('{"n":1}'));
    await store.enqueue(group.groupId, utf8('{"n":2}'));

    expect((await store.getGroup(group.groupId))?.outbox.map(text)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('refuses an event too large for any blob, queuing nothing', async () => {
    const store = await openStore();
    await store.addGroup(group);

    await expect(
      store.enqueue(group.groupId, new Uint8Array(MAX_PLAINTEXT_BYTES + 1)),
    ).rejects.toThrow(PayloadTooLarge);

    expect((await store.getGroup(group.groupId))?.outbox).toEqual([]);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();

    await expect(store.enqueue('nobody', utf8('{}'))).rejects.toThrow('No such group');
  });
});

describe('markSent', () => {
  it('removes only the first entry with those bytes', async () => {
    const store = await openStore();
    await store.addGroup(group);
    for (const n of [1, 2, 1]) {
      await store.enqueue(group.groupId, utf8(`{"n":${String(n)}}`));
    }

    await store.markSent(group.groupId, utf8('{"n":1}'));

    expect((await store.getGroup(group.groupId))?.outbox.map(text)).toEqual(['{"n":2}', '{"n":1}']);
  });

  it('leaves the outbox alone when the entry is already gone', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"n":1}'));

    await store.markSent(group.groupId, utf8('{"n":10}'));
    await store.markSent(group.groupId, utf8('{"n":'));

    expect((await store.getGroup(group.groupId))?.outbox.map(text)).toEqual(['{"n":1}']);
  });
});

describe('applyPull', () => {
  it('appends records whose id is new, in order, and saves the sync state', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(
      group.groupId,
      pull([{ seq: 3, received: 7, bytes: utf8('{"a":1}') }], 3),
      idOf,
    );

    await store.applyPull(
      group.groupId,
      pull(
        [
          { seq: 5, received: 8, bytes: utf8('{"a":1}') },
          { seq: 6, received: 8, bytes: utf8('not json') },
          { seq: 8, received: 9, bytes: utf8('{"b":2}') },
          { seq: 9, received: 9, bytes: utf8('{"b":2}') },
        ],
        9,
      ),
      idOf,
    );

    const saved = await store.getGroup(group.groupId);
    expect(saved?.log.map((record) => [record.seq, text(record.bytes)])).toEqual([
      [3, '{"a":1}'],
      [8, '{"b":2}'],
    ]);
    expect(saved).toMatchObject({
      cursor: 9,
      relayNow: 29_000_010,
      instance: 'relay-1',
      lastSyncAt: 1_762_650_000_000,
    });
  });

  it('changes nothing when working out an id fails', async () => {
    const store = await openStore();
    await store.addGroup(group);

    await expect(
      store.applyPull(group.groupId, pull([{ seq: 1, received: 1, bytes: utf8('{}') }], 1), () => {
        throw new Error('broken');
      }),
    ).rejects.toThrow('broken');

    expect(await store.getGroup(group.groupId)).toMatchObject({
      log: [],
      cursor: 0,
      instance: null,
    });
  });
});

describe('resetCursor', () => {
  it('starts reading from seq 0 of the new instance', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(group.groupId, pull([], 40), idOf);

    await store.resetCursor(group.groupId, 'relay-2');

    expect(await store.getGroup(group.groupId)).toMatchObject({ cursor: 0, instance: 'relay-2' });
  });
});

describe('every change', () => {
  it('runs in exactly one transaction', async () => {
    const store = await openStore();
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');
    const changes = [
      () => store.addGroup(group),
      () => store.enqueue(group.groupId, utf8('{"n":1}')),
      () => store.markSent(group.groupId, utf8('{"n":1}')),
      () => store.applyPull(group.groupId, pull([], 1), idOf),
      () => store.resetCursor(group.groupId, 'relay-2'),
    ];

    for (const change of changes) {
      transaction.mockClear();
      await change();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0]?.[1]).toBe('readwrite');
    }
  });

  it('tells subscribers which group changed, until they unsubscribe', async () => {
    const store = await openStore();
    const heard: string[] = [];
    const unsubscribe = store.subscribe((groupId) => heard.push(groupId));

    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"n":1}'));
    unsubscribe();
    await store.enqueue(group.groupId, utf8('{"n":2}'));

    expect(heard).toEqual([group.groupId, group.groupId]);
  });
});
