/**
 * A device's coalition rooms (#125): one store entry per coalition whose
 * `inner` a group this device goes on in holds, kept apart from groups and
 * coalitions, pruned to 30 days of relay time on every pull, and purged as
 * soon as no such group is left. Logs are signed and folded through the
 * engine (`test/coalitions.ts`); each test keeps them in a real store.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveRoomEntryId } from '../crypto/room';
import { LEVELS } from '../engine/capabilities';
import { fold, type LogRecord } from '../engine/fold';
import { foldRoom, ROOM_KEEP_MINUTES } from '../engine/room';
import { Logs, testSecret } from '../test/coalitions';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import { placedInLog } from './logOrder';
import { innerFor, keepRooms, newRoom, type RoomReads } from './rooms';
import { backedUpGroups, deviceSnapshot, encodeSnapshot, takeSnapshot } from './snapshot';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';

freshIndexedDBPerTest();

/** The level that follows: it can't propose. */
const [FOLLOWING] = LEVELS;

const R = 29_375_000;
const SECRET = fromBase64url(testSecret('coalition'));
const INNER = fromBase64url(testSecret('inner'));
const ENTRY = deriveCoalitionEntryId(SECRET);
const ROOM = deriveRoomEntryId(INNER);
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function device(name = 'device'): Promise<Store> {
  const store = await openStore(name);
  stores.push(store);
  return store;
}

/** `bytes` as a list, which compares across IndexedDB's copies. */
const list = (bytes: Uint8Array | undefined) => (bytes === undefined ? [] : Array.from(bytes));

/** `records` as a pull at relay minute `relayNow`. */
function pullOf(records: readonly LogRecord[], relayNow = R + 100) {
  return { records: [...records], relayNow, instance: 'i', lastSyncAt: 1 };
}

/** Riverside (A: ana, ben) passed its reconcile Proposal; the coalition formed with kim and zed. */
function logs(): Logs {
  const built = new Logs();
  built.group('A', R, ['ana', 'ben']);
  built.reconcile('A', R + 10, 'ana', 'A');
  built.formed(R + 20, ['A', 'B'], ['kim', 'zed']);
  return built;
}

/** Keeps group A as ana's, and the coalition's entry as kim's, on `store`. */
async function memberDevice(store: Store, built = logs()) {
  await store.addGroup({
    groupId: built.ids.A ?? '',
    secret: new Uint8Array(32).fill(7),
    signingKey: testKeys('ana').secretKey,
    me: { author: authorOf('ana'), name: 'Ana' },
  });
  await store.applyPull(built.ids.A ?? '', pullOf(built.logs.A ?? []), eventIdOf);
  await followerDevice(store, built);
  return built;
}

/**
 * Keeps only the coalition's entry, as kim's, on `store`: all a follower's
 * device holds (#124), the coalition secret and log, and no member group.
 */
async function followerDevice(store: Store, built = logs()) {
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: SECRET,
    signingKey: testKeys('kim').secretKey,
    me: { author: authorOf('kim'), name: 'Kim' },
  });
  await store.applyPull(ENTRY, pullOf(built.logs.coalition ?? []), eventIdOf);
  return built;
}

describe('a room entry in the store', () => {
  it('is neither a group nor a coalition: only listRooms lists it', async () => {
    const store = await device();
    const built = await memberDevice(store);
    const entry = await store.getGroup(ENTRY);
    if (entry === undefined) throw new Error('Expected the coalition’s entry.');
    await store.addGroup(newRoom(INNER, entry));

    expect((await store.listGroups()).map((g) => g.groupId)).toEqual([built.ids.A]);
    expect((await store.listCoalitions()).map((g) => g.groupId)).toEqual([ENTRY]);
    expect((await store.listRooms()).map((g) => g.groupId)).toEqual([ROOM]);
    const room = await store.getGroup(ROOM);
    expect(room?.kind).toBe('room');
    expect(list(room?.secret)).toEqual(list(INNER));
    expect(list(room?.signingKey)).toEqual(list(entry.signingKey));
    expect(room?.me).toEqual({ author: authorOf('kim'), name: '' });
  });

  it('drops every record received more than 30 days of relay time before each pull, and only a room’s', async () => {
    const store = await device();
    const built = await memberDevice(store);
    const entry = await store.getGroup(ENTRY);
    if (entry === undefined) throw new Error('Expected the coalition’s entry.');
    await store.addGroup(newRoom(INNER, entry));
    const message = (seq: number, received: number, text: string) => ({
      seq,
      received,
      bytes: signedAs('kim', {
        type: 'message',
        group: built.ids.coalition ?? '',
        ts: seq,
        body: { text },
      }).record,
    });
    const now = R + 60_000;
    const old = message(100, now - ROOM_KEEP_MINUTES - 1, 'Thirty days and a minute.');
    const edge = message(101, now - ROOM_KEEP_MINUTES, 'Thirty days to the minute.');
    await store.applyPull(ROOM, pullOf([old, edge], now - 10), eventIdOf);
    expect((await store.getGroup(ROOM))?.log.map((r) => r.seq)).toEqual([100, 101]);

    await store.applyPull(ROOM, pullOf([], now), eventIdOf);
    expect((await store.getGroup(ROOM))?.log.map((r) => r.seq)).toEqual([101]);
    await store.applyPull(ROOM, pullOf([old], now + 1), eventIdOf);
    expect((await store.getGroup(ROOM))?.log).toEqual([]);

    // A group's and a coalition's logs keep everything.
    await store.applyPull(built.ids.A ?? '', pullOf([], now + 1), eventIdOf);
    expect((await store.getGroup(built.ids.A ?? ''))?.log).toHaveLength(built.logs.A?.length ?? 0);
  });
});

describe('keepRooms', () => {
  it('keeps one room for a coalition a group this device is in holds a seat of, under the coalition key', async () => {
    const store = await device();
    const built = await memberDevice(store);

    await keepRooms(store);
    await keepRooms(store);

    const [room, ...more] = await store.listRooms();
    expect(more).toEqual([]);
    expect(room?.groupId).toBe(ROOM);
    expect(list(room?.secret)).toEqual(list(INNER));
    expect(list(room?.signingKey)).toEqual(list(testKeys('kim').secretKey));
    expect(room?.me.author).toBe(authorOf('kim'));
    expect(innerFor(fold(built.logs.coalition ?? [], R + 100), [])).toBeNull();
  });

  it('folds a group again only once its log has changed', async () => {
    const store = await device();
    const built = await memberDevice(store);
    const reads: RoomReads = new Map();
    await keepRooms(store, reads);
    const first = reads.get(built.ids.A ?? '');
    expect(first?.mark).toBe(`${String(built.logs.A?.length ?? 0)}/0`);
    await keepRooms(store, reads);
    expect(reads.get(built.ids.A ?? '')).toBe(first);

    const vote = signedAs('ben', {
      type: 'level',
      group: built.ids.A ?? '',
      ts: 5,
      body: { level: FOLLOWING },
    }).record;
    await store.applyPull(
      built.ids.A ?? '',
      pullOf([{ seq: 99, received: R + 99, bytes: vote }]),
      eventIdOf,
    );
    await keepRooms(store, reads);
    expect(reads.get(built.ids.A ?? '')).not.toBe(first);
    expect(await store.listRooms()).toHaveLength(1);
  });

  it('keeps none on a device that holds only the coalition, as a follower’s does, which never holds inner', async () => {
    const store = await device();
    await followerDevice(store);

    await keepRooms(store);

    expect(await store.listRooms()).toEqual([]);
    const entry = await store.getGroup(ENTRY);
    const held = JSON.stringify(entry, (_key, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    expect(held).not.toContain(testSecret('inner'));
    expect(
      entry?.log.some((r) => new TextDecoder().decode(r.bytes).includes(testSecret('inner'))),
    ).toBe(false);
  });

  it('keeps none on a device whose group only asks to join: its seat isn’t the coalition’s yet', async () => {
    const store = await device();
    const built = logs();
    built.group('C', R, ['dee'], 'Elm Row');
    built.reconcile('C', R + 30, 'dee', 'C');
    await store.addGroup({
      groupId: built.ids.C ?? '',
      secret: new Uint8Array(32).fill(9),
      signingKey: testKeys('dee').secretKey,
      me: { author: authorOf('dee'), name: 'Dee' },
    });
    await store.applyPull(built.ids.C ?? '', pullOf(built.logs.C ?? []), eventIdOf);
    await followerDevice(store, built);

    await keepRooms(store);

    expect(await store.listRooms()).toEqual([]);
  });

  it('keeps none before the coalition’s genesis, nor for a declined one', async () => {
    const store = await device();
    const built = new Logs();
    built.group('A', R, ['ana', 'ben']);
    built.reconcile('A', R + 10, 'ana', 'A');
    await memberDevice(store, built);
    await keepRooms(store);
    expect(await store.listRooms()).toEqual([]);

    const declined = await device('declined');
    const failed = new Logs();
    failed.group('A', R, ['ana', 'ben']);
    failed.reconcile('A', R + 10, 'ana', 'A');
    failed.coalition(R + 20, ['A', 'B']);
    failed.join(R + 21, 'kim', 'A');
    failed.result(R + 22, 'kim', failed.ids.coalition ?? '', 'A', 'fail');
    await memberDevice(declined, failed);
    await keepRooms(declined);
    expect(await declined.listRooms()).toEqual([]);
  });

  it.each([
    ['is leaving', (store: Store, id: string) => store.markLeaving(id, new Uint8Array([1]))],
    ['only reads', (store: Store, id: string) => store.markArchived(id, 'dissolved')],
    ['is gone', (store: Store, id: string) => store.purgeGroup(id)],
  ])(
    'purges the room, messages and all, once the group that held its seat %s',
    async (_label, end) => {
      const store = await device();
      const built = await memberDevice(store);
      await keepRooms(store);
      const message = signedAs('kim', {
        type: 'message',
        group: built.ids.coalition ?? '',
        ts: 1,
        body: { text: 'CANARY' },
      }).record;
      await store.applyPull(
        ROOM,
        pullOf([{ seq: 90, received: R + 90, bytes: message }]),
        eventIdOf,
      );
      expect((await store.getGroup(ROOM))?.log).toHaveLength(1);

      await end(store, built.ids.A ?? '');
      await keepRooms(store);

      expect(await store.listRooms()).toEqual([]);
      expect(await store.getGroup(ROOM)).toBeUndefined();
    },
  );

  it('remakes the room under the coalition entry’s key when that key changed, as a restore can change it', async () => {
    const store = await device();
    await memberDevice(store);
    const entry = await store.getGroup(ENTRY);
    if (entry === undefined) throw new Error('Expected the coalition’s entry.');
    await store.addGroup(
      newRoom(INNER, {
        ...entry,
        signingKey: testKeys('zed').secretKey,
        me: { author: authorOf('zed'), name: '' },
      }),
    );
    await store.enqueue(ROOM, new Uint8Array([9]));

    await keepRooms(store);

    const room = await store.getGroup(ROOM);
    expect(room?.me.author).toBe(authorOf('kim'));
    expect(list(room?.signingKey)).toEqual(list(testKeys('kim').secretKey));
    expect(room?.outbox).toEqual([]);
  });
});

describe('a room’s log across devices', () => {
  it('shows every device the same messages in the same order, whatever batches each pulled them in', () => {
    const built = logs();
    const coalition = fold(built.logs.coalition ?? [], R + 1000);
    built.ids.room = built.ids.coalition ?? '';
    const authors = ['kim', 'zed', 'ana'];
    for (let i = 0; i < 9; i += 1) {
      const who = authors[i % 3] ?? 'kim';
      built.add('room', R + 100 + i, who, {
        type: 'message',
        body: { text: `Message ${String(i)}` },
      });
    }
    const room = built.logs.room ?? [];
    const shown = foldRoom(room, coalition, R + 1000);
    fc.assert(
      fc.property(
        fc.array(fc.nat(3), { minLength: room.length, maxLength: room.length }),
        (batchOf) => {
          let log: LogRecord[] = [];
          for (let batch = 3; batch >= 0; batch -= 1) {
            log = placedInLog(
              log,
              room.filter((_, i) => batchOf[i] === batch),
            );
          }
          expect(foldRoom(log, coalition, R + 1000)).toEqual(shown);
        },
      ),
    );
    expect(shown.map((m) => m.text)).toEqual([
      'Message 0',
      'Message 1',
      'Message 3',
      'Message 4',
      'Message 6',
      'Message 7',
    ]);
  });
});

describe('what leaves the device', () => {
  it('holds no room in a backup file, a link bundle or the relay backup: no message, entry or room key', async () => {
    const store = await device();
    const built = await memberDevice(store);
    await keepRooms(store);
    const canary = 'CANARY-ROOM-MESSAGE-0d1f';
    const record = signedAs('kim', {
      type: 'message',
      group: built.ids.coalition ?? '',
      ts: 1,
      body: { text: canary },
    }).record;
    await store.applyPull(ROOM, pullOf([{ seq: 90, received: R + 90, bytes: record }]), eventIdOf);
    await store.enqueue(
      ROOM,
      signedAs('kim', {
        type: 'message',
        group: built.ids.coalition ?? '',
        ts: 2,
        body: { text: `${canary}-queued` },
      }).record,
    );
    const room = await store.getGroup(ROOM);
    if (room === undefined) throw new Error('Expected the room.');

    const canaries = [
      textCanary('the message', canary),
      ...keyCanaries('the room entry id', fromBase64url(ROOM)),
      textCanary('a room record', new TextDecoder().decode(record.subarray(96, 140))),
    ];
    const backup = await takeSnapshot(store);
    const link = await takeSnapshot(store, 'link');
    const relayBackup = encodeSnapshot(await deviceSnapshot(store));
    for (const plaintext of [backup.plaintext, link.plaintext, relayBackup]) {
      expect(findCanaries(plaintext, canaries)).toEqual([]);
      expect(new TextDecoder().decode(plaintext)).not.toContain('"room"');
    }
    expect(backup.groupIds).toEqual([built.ids.A, ENTRY]);
    expect(link.groupIds).toEqual([built.ids.A, ENTRY]);
    expect(backedUpGroups([room])).toEqual([]);
    // The control: the group and coalition it does carry are found.
    const control = keyCanaries('the coalition entry id', fromBase64url(ENTRY));
    expect(findCanaries(backup.plaintext, control)).not.toEqual([]);
  });
});
