import { IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';

import { MAX_RECORD_BYTES, RecordTooLarge } from '../crypto/record';
import { local, text, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { HISTORY_GAP_MS, openStore } from './db';
import type { NewGroup, Pull } from './db';

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
    await store.addGroup(group);
    expect((await store.listGroups()).map((stored) => stored.groupId)).toEqual(['group-1']);
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
