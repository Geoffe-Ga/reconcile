import { IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import { local, text, utf8 } from '../test/bytes';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { HISTORY_GAP_MS, openStore } from './db';
import type { Group, NewGroup, Pull } from './db';
import type { PersonalDocument } from './personal';

freshIndexedDBPerTest();

const group: NewGroup = {
  groupId: 'group-1',
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

/** A personal Document (#93), as the store keeps one. */
const statement: PersonalDocument = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  title: 'My mission statement',
  text: 'I show up for my neighbors.\n',
  createdAt: 1_762_650_000_000,
  updatedAt: 1_762_650_000_000,
};

/** The schema every upgrade path ends at: version 4, with the groups and personal stores (#93). */
const CURRENT_SCHEMA = { version: 4, stores: ['groups', 'personal'] };

/** The version and object stores of the IndexedDB database `name`, as it now stands. */
async function schemaOf(name: string): Promise<{ version: number; stores: string[] }> {
  const database = await openDB(name);
  const schema = { version: database.version, stores: [...database.objectStoreNames].sort() };
  database.close();
  return schema;
}

/** A group record as a version 3 or 4 store keeps one: `group` after a sync, with `changes`. */
function storedGroup(changes: Partial<Group> = {}): Group {
  return {
    ...group,
    log: [{ seq: 1, received: 9, bytes: utf8('{"g":1}') }],
    cursor: 1,
    relayNow: 29_000_010,
    instance: 'relay-1',
    outbox: [],
    lastSyncAt: 1_762_650_000_000,
    ...changes,
  };
}

/** `group` with its bytes as plain arrays, so a stored copy and the one put compare. */
function comparable(stored: Group | undefined) {
  if (stored === undefined) return undefined;
  return {
    ...stored,
    secret: Array.from(stored.secret),
    signingKey: Array.from(stored.signingKey),
    log: stored.log.map((record) => ({ ...record, bytes: Array.from(record.bytes) })),
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

  it.each([
    [1, 'the stub era’s unsigned data'],
    [2, 'the readable blobs era’s random mailbox ids'],
  ])('deletes version %i’s data (%s) when it upgrades, migrating none of it', async (version) => {
    const old = await openDB('reconcile', version, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    await old.put('groups', {
      groupId: 'old-era',
      mailbox: 'random-id',
      secret: new Uint8Array(32),
    });
    old.close();

    const store = await openStore();

    expect(await store.listGroups()).toEqual([]);
    expect(await store.listPersonal()).toEqual([]);
    await store.addGroup(group);
    await store.savePersonal(statement);
    expect((await store.listGroups()).map((stored) => stored.groupId)).toEqual(['group-1']);
    expect(await store.listPersonal()).toEqual([statement]);
    store.close();
    expect(await schemaOf('reconcile')).toEqual(CURRENT_SCHEMA);
  });

  it('keeps the secret and nothing derived from it', async () => {
    const store = await openStore();

    await store.addGroup(group);

    const [stored] = await store.listGroups();
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'cursor',
      'groupId',
      'instance',
      'lastSyncAt',
      'log',
      'me',
      'outbox',
      'relayNow',
      'secret',
      'signingKey',
    ]);
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

  it('queues a record of exactly 64,000 bytes', async () => {
    const store = await openStore();
    await store.addGroup(group);

    await store.enqueue(group.groupId, new Uint8Array(MAX_RECORD_BYTES));

    expect((await store.getGroup(group.groupId))?.outbox.map((entry) => entry.length)).toEqual([
      64_000,
    ]);
  });

  it('refuses a record over 64,000 bytes, queuing nothing', async () => {
    const store = await openStore();
    await store.addGroup(group);

    const refused = store.enqueue(group.groupId, new Uint8Array(MAX_RECORD_BYTES + 1));

    await expect(refused).rejects.toThrow(RecordTooLarge);
    await expect(refused).rejects.toMatchObject({ size: 64_001 });
    expect((await store.getGroup(group.groupId))?.outbox).toEqual([]);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();

    await expect(store.enqueue('nobody', utf8('{}'))).rejects.toThrow('No such group');
  });
});

describe('enqueueAll', () => {
  it('queues several events in order, in one change that also clears their draft', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const draft = { title: 'T', why: 'W', text: 'X', link: '' };
    await store.writeDraft(group.groupId, 'again:p1', draft);
    await store.enqueue(group.groupId, utf8('{"n":0}'));
    const listener = vi.fn();
    store.subscribe(listener);
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');

    await store.enqueueAll(group.groupId, [utf8('{"n":1}'), utf8('{"n":2}')], 'again:p1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const stored = await store.getGroup(group.groupId);
    expect(stored?.outbox.map(text)).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);
    expect(await store.readDraft(group.groupId, 'again:p1')).toBeUndefined();
  });

  it('queues none of them when one is over 64,000 bytes, and keeps the draft', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const draft = { title: 'T', why: 'W', text: 'X', link: '' };
    await store.writeDraft(group.groupId, 'atom-1', draft);

    await expect(
      store.enqueueAll(
        group.groupId,
        [utf8('{"n":1}'), new Uint8Array(MAX_RECORD_BYTES + 1)],
        'atom-1',
      ),
    ).rejects.toThrow(RecordTooLarge);

    expect((await store.getGroup(group.groupId))?.outbox).toEqual([]);
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual(draft);
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

describe('the missing-history flag', () => {
  const DAY = 86_400_000;
  const T0 = 1_762_650_000_000;

  /** A pull that read nothing, finishing at device time `at`. */
  const empty = (at: number): Pull => ({ ...pull([], 0), lastSyncAt: at });

  it('is 28 days: the relay keeps blobs 30, so a longer gap may have missed some', () => {
    expect(HISTORY_GAP_MS).toBe(28 * DAY);
  });

  it('stays unset through a group’s first sync and syncs no more than 28 days apart', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(group.groupId, empty(T0), idOf);
    await store.applyPull(group.groupId, empty(T0 + 28 * DAY), idOf);

    expect((await store.getGroup(group.groupId))?.missingHistory).not.toBe(true);
  });

  it('is set by a sync more than 28 days after the one before, and stays through later syncs', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(group.groupId, empty(T0), idOf);
    await store.applyPull(group.groupId, empty(T0 + 28 * DAY + 1), idOf);
    expect((await store.getGroup(group.groupId))?.missingHistory).toBe(true);

    await store.applyPull(group.groupId, empty(T0 + 28 * DAY + 2), idOf);
    expect((await store.getGroup(group.groupId))?.missingHistory).toBe(true);
  });

  it('is cleared only by a merge', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(group.groupId, empty(T0), idOf);
    await store.applyPull(group.groupId, empty(T0 + 29 * DAY), idOf);

    await store.mergeLog(group.groupId, [], idOf);

    expect((await store.getGroup(group.groupId))?.missingHistory).toBe(false);
  });
});

describe('mergeLog', () => {
  const record = (seq: number, body: string) => ({ seq, received: seq * 10, bytes: utf8(body) });

  it('adds each entry the log lacks, in seq order among the ones it has', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(
      group.groupId,
      pull([record(2, '{"a":2}'), record(7, '{"a":7}')], 7),
      idOf,
    );

    await store.mergeLog(
      group.groupId,
      [
        record(1, '{"a":1}'),
        record(2, '{"a":2}'),
        record(5, '{"a":5}'),
        record(6, 'unsigned'),
        record(4, '{"a":4}'),
        record(9, '{"a":9}'),
      ],
      idOf,
    );

    const saved = await store.getGroup(group.groupId);
    expect(saved?.log.map((entry) => [entry.seq, entry.received, text(entry.bytes)])).toEqual([
      [1, 10, '{"a":1}'],
      [2, 20, '{"a":2}'],
      [4, 40, '{"a":4}'],
      [5, 50, '{"a":5}'],
      [7, 70, '{"a":7}'],
      [9, 90, '{"a":9}'],
    ]);
  });

  it('keeps the cursor, relay time, instance and last sync as they were', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(group.groupId, pull([record(7, '{"a":7}')], 7), idOf);

    await store.mergeLog(group.groupId, [record(1, '{"a":1}'), record(12, '{"a":12}')], idOf);

    expect(await store.getGroup(group.groupId)).toMatchObject({
      cursor: 7,
      relayNow: 29_000_010,
      instance: 'relay-1',
      lastSyncAt: 1_762_650_000_000,
    });
  });

  it('tells subscribers the group changed, so its screens fold again', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const heard = vi.fn();
    store.subscribe(heard);

    await store.mergeLog(group.groupId, [record(1, '{"a":1}')], idOf);

    expect(heard).toHaveBeenCalledWith(group.groupId);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();
    await expect(store.mergeLog('nope', [], idOf)).rejects.toThrow('No such group');
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

describe('markLeaving', () => {
  it('queues the leave after the outbox and marks the group as leaving, in one change', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"n":1}'));

    await store.markLeaving(group.groupId, utf8('{"leave":1}'));

    const stored = await store.getGroup(group.groupId);
    expect(stored?.outbox.map(text)).toEqual(['{"n":1}', '{"leave":1}']);
    expect(text(stored?.leaving ?? new Uint8Array())).toBe('{"leave":1}');
  });

  it('keeps the first leave when asked again, queuing it once', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markLeaving(group.groupId, utf8('{"leave":1}'));

    await store.markLeaving(group.groupId, utf8('{"leave":2}'));

    const stored = await store.getGroup(group.groupId);
    expect(stored?.outbox.map(text)).toEqual(['{"leave":1}']);
    expect(text(stored?.leaving ?? new Uint8Array())).toBe('{"leave":1}');
  });

  it('is still leaving after a reload, with the leave still queued', async () => {
    const first = await openStore();
    await first.addGroup(group);
    await first.markLeaving(group.groupId, utf8('{"leave":1}'));
    first.close();

    const second = await openStore();
    const stored = await second.getGroup(group.groupId);
    expect(stored?.outbox.map(text)).toEqual(['{"leave":1}']);
    expect(stored?.leaving).toBeDefined();
  });

  it('refuses anything queued after the leave, so nobody proposes or votes on the way out', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markLeaving(group.groupId, utf8('{"leave":1}'));

    await expect(store.enqueue(group.groupId, utf8('{"n":1}'))).rejects.toThrow(
      'This group is leaving this device.',
    );
    await expect(store.enqueueAll(group.groupId, [utf8('{"n":2}')])).rejects.toThrow(
      'This group is leaving this device.',
    );
    expect((await store.getGroup(group.groupId))?.outbox.map(text)).toEqual(['{"leave":1}']);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();
    await expect(store.markLeaving('nope', utf8('{"leave":1}'))).rejects.toThrow(
      'No such group on this device.',
    );
  });
});

describe('purgeGroup', () => {
  it('deletes the group and tells subscribers, leaving every other group as it was', async () => {
    const store = await openStore();
    const other = { ...group, groupId: 'group-2' };
    await store.addGroup(group);
    await store.addGroup(other);
    await store.enqueue(other.groupId, utf8('{"n":1}'));
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await store.purgeGroup(group.groupId);

    expect(await store.getGroup(group.groupId)).toBeUndefined();
    expect((await store.listGroups()).map((kept) => kept.groupId)).toEqual(['group-2']);
    expect((await store.getGroup(other.groupId))?.outbox.map(text)).toEqual(['{"n":1}']);
    expect(heard).toEqual([group.groupId]);
  });

  it('changes nothing, and tells nobody, for a group that is already gone', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await store.purgeGroup('nope');

    expect(await store.listGroups()).toHaveLength(1);
    expect(heard).toEqual([]);
  });
});

describe('the schema, from each version a device may hold (v1 → v2 → v3 → v4)', () => {
  it('starts a fresh install at version 4, with an empty groups store and personal store', async () => {
    const store = await openStore();

    expect(await store.listGroups()).toEqual([]);
    expect(await store.listPersonal()).toEqual([]);
    store.close();
    expect(await schemaOf('reconcile')).toEqual(CURRENT_SCHEMA);
  });

  it('keeps version 3’s groups as #108 left them, archived and cleared ones read-only still, beside an empty personal store', async () => {
    const live = storedGroup({ groupId: 'live', backup: 'saved' });
    const archived = storedGroup({ groupId: 'archived', archived: { reason: 'dissolved' } });
    const clearedArchive = { at: 7, state: testGroup().state, tallies: {} };
    const cleared = storedGroup({
      groupId: 'cleared',
      log: [],
      archived: { reason: 'dissolved', cleared: clearedArchive },
    });
    const old = await openDB('reconcile', 3, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    for (const kept of [live, archived, cleared]) await old.put('groups', kept);
    old.close();

    const store = await openStore();

    expect((await store.listGroups()).map(comparable)).toEqual(
      [archived, cleared, live].map(comparable),
    );
    expect(await store.listPersonal()).toEqual([]);
    await expect(store.enqueue('archived', utf8('{"late":1}'))).rejects.toThrow('read-only');
    await expect(store.enqueue('cleared', utf8('{"late":1}'))).rejects.toThrow('read-only');
    await store.savePersonal(statement);
    expect(await store.listPersonal()).toEqual([statement]);
    store.close();
    expect(await schemaOf('reconcile')).toEqual(CURRENT_SCHEMA);
  });

  it('keeps a version 3 group’s encryption key, epoch and records’ epochs (#98), which need no version of their own', async () => {
    const rotated = storedGroup({
      groupId: 'rotated',
      kxKey: new Uint8Array(32).fill(4),
      epoch: 1,
      log: [
        { seq: 1, received: 9, bytes: utf8('{"g":1}') },
        { seq: 2, received: 10, bytes: utf8('{"p":1}'), epoch: 1 },
      ],
      outbox: [utf8('{"frozen":1}')],
    });
    const old = await openDB('reconcile', 3, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    await old.put('groups', rotated);
    old.close();

    const store = await openStore();

    const [kept] = await store.listGroups();
    const plain = (held: Group | undefined) => ({
      ...comparable(held),
      kxKey: Array.from(held?.kxKey ?? []),
      outbox: held?.outbox.map(text),
    });
    expect(plain(kept)).toEqual(plain(rotated));
    expect(plain(kept).kxKey).toHaveLength(32);
    // A dissolve's archive drops the outbox a key change had frozen, so nothing waits on it (#108).
    await store.markArchived('rotated', 'dissolved');
    const archived = await store.getGroup('rotated');
    expect([archived?.outbox, archived?.epoch, archived?.archived]).toEqual([
      [],
      1,
      { reason: 'dissolved' },
    ]);
    store.close();
    expect(await schemaOf('reconcile')).toEqual(CURRENT_SCHEMA);
  });

  it('opens version 4 as #93 left it, changing nothing, and archives a group in it', async () => {
    const old = await openDB('reconcile', 4, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        database.createObjectStore('personal', { keyPath: 'id' });
      },
    });
    await old.put('groups', storedGroup());
    await old.put('personal', statement);
    old.close();

    const store = await openStore();

    expect((await store.listGroups()).map(comparable)).toEqual([comparable(storedGroup())]);
    expect(await store.listPersonal()).toEqual([statement]);
    await store.markArchived('group-1', 'dissolved');
    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'dissolved' });
    expect(await store.listPersonal()).toEqual([statement]);
    store.close();
    expect(await schemaOf('reconcile')).toEqual(CURRENT_SCHEMA);
  });
});

describe('markArchived', () => {
  it('drops the outbox, drafts and any leave, marks the group archived and tells subscribers (#108)', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue('group-1', utf8('{"queued":1}'));
    await store.writeDraft('group-1', 'atom-1', { title: 't', why: '', text: 'x', link: '' });
    await store.markLeaving('group-1', utf8('{"leave":1}'));
    const heard = vi.fn();
    store.subscribe(heard);

    await store.markArchived('group-1', 'dissolved');

    const kept = await store.getGroup('group-1');
    expect(kept?.archived).toEqual({ reason: 'dissolved' });
    expect(kept?.outbox).toEqual([]);
    expect(kept?.drafts).toBeUndefined();
    expect(kept?.leaving).toBeUndefined();
    expect(heard).toHaveBeenCalledWith('group-1');
  });

  it('forgets what the chat bot learned of the webhook, since it never posts again (#123)', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const home = { guild: '1188000000000000001', channel: '1199000000000000777' };
    await store.noteChatChannel('group-1', { webhook: '1199000000000000001', home });

    await store.markArchived('group-1', 'dissolved');

    expect((await store.getGroup('group-1'))?.chatChannel).toBeUndefined();
  });

  it('keeps an archive it already holds, cleared state included', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markArchived('group-1', 'dissolved');
    const cleared = { at: 5, state: testGroup().state, tallies: {} };
    await store.clearArchive('group-1', cleared);

    await store.markArchived('group-1', 'dissolved');

    expect((await store.getGroup('group-1'))?.archived).toEqual({ reason: 'dissolved', cleared });
  });

  it('refuses anything queued once archived', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markArchived('group-1', 'dissolved');

    await expect(store.enqueue('group-1', utf8('{"late":1}'))).rejects.toThrow(
      'This group is read-only on this device.',
    );
    expect((await store.getGroup('group-1'))?.outbox).toEqual([]);
  });
});

describe('clearArchive', () => {
  it('keeps the cleared state and drops the log, in one change (#108)', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(
      'group-1',
      pull([{ seq: 1, received: 1, bytes: utf8('{"a":1}') }], 1),
      idOf,
    );
    await store.markArchived('group-1', 'dissolved');
    const cleared = { at: 7, state: testGroup().state, tallies: {} };

    await store.clearArchive('group-1', cleared);

    const kept = await store.getGroup('group-1');
    expect(kept?.log).toEqual([]);
    expect(kept?.archived).toEqual({ reason: 'dissolved', cleared });
  });

  it('keeps a cleared archive free of anything an invite’s merge would bring back', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markArchived('group-1', 'dissolved');
    await store.clearArchive('group-1', { at: 7, state: testGroup().state, tallies: {} });
    const before = await store.getGroup('group-1');

    await store.mergeLog('group-1', [{ seq: 1, received: 1, bytes: utf8('{"vote":1}') }], idOf);

    expect(await store.getGroup('group-1')).toEqual(before);
  });

  it('refuses a group that isn’t archived, and changes nothing', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.applyPull(
      'group-1',
      pull([{ seq: 1, received: 1, bytes: utf8('{"a":1}') }], 1),
      idOf,
    );

    await expect(
      store.clearArchive('group-1', { at: 7, state: testGroup().state, tallies: {} }),
    ).rejects.toThrow('This group isn’t archived.');
    expect((await store.getGroup('group-1'))?.log).toHaveLength(1);
  });
});

describe('the chat bot’s claims (#119)', () => {
  const claim = { id: 'claim-1', proposal: 'proposal-1', moment: 'open' } as const;

  it('queues a claim’s record and keeps its id, in one change', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"n":1}'));

    expect(await store.claimChat(group.groupId, utf8('{"claim":1}'), claim)).toBe(true);

    const kept = await store.getGroup(group.groupId);
    expect(kept?.outbox.map(text)).toEqual(['{"n":1}', '{"claim":1}']);
    expect(kept?.chatClaims).toEqual([claim]);
  });

  it('queues nothing for a moment this device already claimed, as a second tab might ask', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.claimChat(group.groupId, utf8('{"claim":1}'), claim);

    const again = { ...claim, id: 'claim-2' };
    expect(await store.claimChat(group.groupId, utf8('{"claim":2}'), again)).toBe(false);
    const closing = { ...claim, id: 'claim-3', moment: 'closing' } as const;
    expect(await store.claimChat(group.groupId, utf8('{"claim":3}'), closing)).toBe(true);
    const other = { ...claim, id: 'claim-4', proposal: 'proposal-2' };
    expect(await store.claimChat(group.groupId, utf8('{"claim":4}'), other)).toBe(true);

    const kept = await store.getGroup(group.groupId);
    expect(kept?.outbox.map(text)).toEqual(['{"claim":1}', '{"claim":3}', '{"claim":4}']);
    expect(kept?.chatClaims?.map((held) => held.id)).toEqual(['claim-1', 'claim-3', 'claim-4']);
  });

  it('queues nothing once the group is leaving this device', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markLeaving(group.groupId, utf8('{"leave":1}'));

    expect(await store.claimChat(group.groupId, utf8('{"claim":1}'), claim)).toBe(false);

    const kept = await store.getGroup(group.groupId);
    expect(kept?.outbox.map(text)).toEqual(['{"leave":1}']);
    expect(kept?.chatClaims).toBeUndefined();
  });

  it('queues nothing for a read-only archive (#108)', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.markArchived(group.groupId, 'dissolved');

    expect(await store.claimChat(group.groupId, utf8('{"claim":1}'), claim)).toBe(false);

    const kept = await store.getGroup(group.groupId);
    expect(kept?.outbox).toEqual([]);
    expect(kept?.chatClaims).toBeUndefined();
  });

  it('drops every claim this device holds once the group is archived (#108)', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.claimChat(group.groupId, utf8('{"claim":1}'), claim);

    await store.markArchived(group.groupId, 'dissolved');

    const kept = await store.getGroup(group.groupId);
    expect(kept?.outbox).toEqual([]);
    expect(kept?.chatClaims).toBeUndefined();
    expect(await store.settleChatClaim(group.groupId, claim.id)).toBe(false);
  });

  it('refuses a claim over 64,000 bytes, keeping nothing', async () => {
    const store = await openStore();
    await store.addGroup(group);

    await expect(
      store.claimChat(group.groupId, new Uint8Array(MAX_RECORD_BYTES + 1), claim),
    ).rejects.toThrow(RecordTooLarge);

    expect((await store.getGroup(group.groupId))?.chatClaims).toBeUndefined();
  });

  it('settles a claim once: the first to ask hears true, and every later ask false', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.claimChat(group.groupId, utf8('{"claim":1}'), claim);
    const closing = { ...claim, id: 'claim-2', moment: 'closing' } as const;
    await store.claimChat(group.groupId, utf8('{"claim":2}'), closing);

    const raced = await Promise.all([
      store.settleChatClaim(group.groupId, claim.id),
      store.settleChatClaim(group.groupId, claim.id),
    ]);

    expect(raced.sort()).toEqual([false, true]);
    expect(await store.settleChatClaim(group.groupId, claim.id)).toBe(false);
    expect(await store.settleChatClaim(group.groupId, 'never-made')).toBe(false);
    expect((await store.getGroup(group.groupId))?.chatClaims).toEqual([closing]);
  });

  it('settles without telling subscribers, since no screen reads a claim', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.claimChat(group.groupId, utf8('{"claim":1}'), claim);
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await store.settleChatClaim(group.groupId, claim.id);

    expect(heard).toEqual([]);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();

    await expect(store.claimChat('nope', utf8('{"claim":1}'), claim)).rejects.toThrow(
      'No such group on this device.',
    );
    await expect(store.settleChatClaim('nope', claim.id)).rejects.toThrow(
      'No such group on this device.',
    );
  });
});

describe('what this device learned of the group’s webhook (#123)', () => {
  const forum = { webhook: '1199000000000000001', home: { guild: '1188', channel: '1199' } };
  const text = { webhook: '1199000000000000001', home: 'text' } as const;

  it('is nothing until noted, then the latest note, without telling subscribers', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));
    expect((await store.getGroup(group.groupId))?.chatChannel).toBeUndefined();

    await store.noteChatChannel(group.groupId, forum);
    expect((await store.getGroup(group.groupId))?.chatChannel).toEqual(forum);
    await store.noteChatChannel(group.groupId, text);
    expect((await store.getGroup(group.groupId))?.chatChannel).toEqual(text);

    expect(heard).toEqual([]);
  });

  it('refuses an unknown group', async () => {
    const store = await openStore();
    await expect(store.noteChatChannel('nope', text)).rejects.toThrow(
      'No such group on this device.',
    );
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
      () =>
        store.claimChat(group.groupId, utf8('{"claim":1}'), {
          id: 'claim-1',
          proposal: 'proposal-1',
          moment: 'open',
        }),
      () => store.settleChatClaim(group.groupId, 'claim-1'),
      () => store.noteChatChannel(group.groupId, { webhook: '1', home: 'text' }),
      () => store.markLeaving(group.groupId, utf8('{"leave":1}')),
      () => store.purgeGroup(group.groupId),
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

describe('encryption keys and epochs (#98)', () => {
  const KX_KEY = new Uint8Array(32).fill(5);
  const NEXT = new Uint8Array(32).fill(6);

  it('keeps the group’s encryption key and epoch as Create group or Join hands them over', async () => {
    const store = await openStore();
    await store.addGroup({ ...group, kxKey: KX_KEY, epoch: 2 });
    const kept = await store.getGroup(group.groupId);
    expect(kept?.kxKey === undefined ? null : local(kept.kxKey)).toEqual(KX_KEY);
    expect(kept?.epoch).toBe(2);
  });

  it('keeps an encryption key once: the first one offered stays, as two tabs might race', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const first = await store.ensureKx(group.groupId, KX_KEY);
    const second = await store.ensureKx(group.groupId, NEXT);
    expect([local(first), local(second)]).toEqual([KX_KEY, KX_KEY]);
    const kept = await store.getGroup(group.groupId);
    expect(kept?.kxKey === undefined ? null : local(kept.kxKey)).toEqual(KX_KEY);
    await expect(store.ensureKx('no-such-group', KX_KEY)).rejects.toThrow();
  });

  it('keeps one record per event and epoch, so a copy posted again to a new mailbox is kept', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const stale = { seq: 6, received: 9, bytes: utf8('{"p":1}') };
    await store.applyPull(group.groupId, pull([stale, { ...stale, seq: 7 }], 7), idOf);
    await store.applyPull(group.groupId, pull([{ ...stale, seq: 9, epoch: 1 }], 9), idOf);
    await store.applyPull(group.groupId, pull([{ ...stale, seq: 10, epoch: 1 }], 10), idOf);
    const kept = await store.getGroup(group.groupId);
    expect(kept?.log.map(({ seq, epoch }) => [seq, epoch])).toEqual([
      [6, undefined],
      [9, 1],
    ]);
  });

  it('moves to the next epoch in the same change as the pull: its secret, its cursor, and what to post again first', async () => {
    const store = await openStore();
    await store.addGroup(group);
    await store.enqueue(group.groupId, utf8('{"queued":1}'));
    const late = utf8('{"late":1}');
    await store.applyPull(
      group.groupId,
      {
        ...pull([{ seq: 12, received: 9, bytes: late }], 12),
        advance: { epoch: 1, secret: NEXT, cursor: 11, repost: [late, utf8('{"queued":1}')] },
      },
      idOf,
    );
    const kept = await store.getGroup(group.groupId);
    expect(kept?.epoch).toBe(1);
    expect(kept === undefined ? null : local(kept.secret)).toEqual(NEXT);
    expect(kept?.cursor).toBe(11);
    expect(kept?.outbox.map(text)).toEqual(['{"late":1}', '{"queued":1}']);
    expect(kept?.log.map((record) => record.seq)).toEqual([12]);
  });

  it('adopts a later epoch’s secret from an invite, and never an earlier or the same one', async () => {
    const store = await openStore();
    await store.addGroup({ ...group, epoch: 1 });
    await store.applyPull(group.groupId, pull([], 30), idOf);
    await store.adoptEpoch(group.groupId, { epoch: 1, secret: NEXT, cursor: 0, repost: [] });
    await store.adoptEpoch(group.groupId, { epoch: 0, secret: NEXT, cursor: 0, repost: [] });
    let kept = await store.getGroup(group.groupId);
    expect([kept?.epoch, kept === undefined ? null : local(kept.secret), kept?.cursor]).toEqual([
      1,
      group.secret,
      30,
    ]);
    const late = utf8('{"late":1}');
    await store.adoptEpoch(group.groupId, { epoch: 2, secret: NEXT, cursor: 25, repost: [late] });
    kept = await store.getGroup(group.groupId);
    expect([kept?.epoch, kept === undefined ? null : local(kept.secret), kept?.cursor]).toEqual([
      2,
      NEXT,
      25,
    ]);
    expect(kept?.outbox.map(text)).toEqual(['{"late":1}']);
  });

  it('merges an invite’s records by event and epoch too', async () => {
    const store = await openStore();
    await store.addGroup(group);
    const record = { seq: 6, received: 9, bytes: utf8('{"p":1}') };
    await store.applyPull(group.groupId, pull([record], 6), idOf);
    await store.mergeLog(group.groupId, [record, { ...record, seq: 8, epoch: 1 }], idOf);
    const kept = await store.getGroup(group.groupId);
    expect(kept?.log.map(({ seq, epoch }) => [seq, epoch])).toEqual([
      [6, undefined],
      [8, 1],
    ]);
  });
});
