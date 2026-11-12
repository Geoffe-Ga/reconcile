/**
 * The room's model and Send (#125), from logs signed and folded through the
 * engine: what a device in a member group reads, what waits in its outbox,
 * where its person stands, and what Send queues.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { deriveRoomEntryId } from '../crypto/room';
import { xchachaSeal } from '../crypto/seal';
import { LEVELS } from '../engine/capabilities';
import { parseRecord } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import { createRelay, type Fetch } from '../net/relay';
import type { HeldCoalition } from '../store/coalitions';
import { type Group, openStore, type Store } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { createSync } from '../store/sync';
import { Logs, testSecret } from '../test/coalitions';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import type { DeviceGroup } from './coalitionHome';
import { roomStanding, roomView, sendMessage } from './room';

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

/** Riverside (A: ana, ben) and Oak St (B: cy) reconcile; kim takes part for Riverside, zed for Oak St. */
function formed(): { logs: Logs; at: number } {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'ben'], 'Riverside');
  logs.reconcile('A', R + 3, 'ana', 'Riverside');
  logs.group('B', R, ['cy'], 'Oak St');
  logs.reconcile('B', R + 3, 'cy', 'Oak St');
  return { logs, at: logs.formed(R + 10, ['Riverside', 'Oak St'], ['kim', 'zed']) };
}

/** The coalition's entry as `who`'s device keeps it, with `plan`. */
function heldBy(logs: Logs, relayNow: number, who: string, plan: Partial<Group> = {}) {
  const entry = {
    kind: 'coalition',
    groupId: ENTRY,
    me: { author: authorOf(who), name: who },
    outbox: [],
    log: logs.logs.coalition ?? [],
    relayNow,
    ...plan,
  } as unknown as Group;
  return { entry, state: fold(entry.log, relayNow) } satisfies HeldCoalition;
}

/** Group `log` on this device as `me`. */
function deviceGroup(
  logs: Logs,
  log: string,
  at: number,
  me: string,
  more: Partial<DeviceGroup> = {},
) {
  const state = fold(logs.logs[log] ?? [], at);
  return {
    groupId: state.group ?? '',
    me: authorOf(me),
    state,
    leaving: false,
    archived: false,
    ...more,
  };
}

/** A room entry on this device holding `log` and `outbox`. */
function room(log: LogRecord[], outbox: Uint8Array[] = [], relayNow = R + 100): Group {
  return {
    kind: 'room',
    groupId: ROOM,
    me: { author: authorOf('kim'), name: '' },
    log,
    outbox,
    relayNow,
  } as unknown as Group;
}

/** `who`'s message in the coalition, at relay seq `seq`. */
function said(logs: Logs, who: string, seq: number, text: string): LogRecord {
  const record = signedAs(who, {
    type: 'message',
    group: logs.ids.coalition ?? '',
    ts: seq,
    body: { text },
  }).record;
  return { seq, received: R + 50 + seq, bytes: record };
}

describe('roomView', () => {
  it('reads the room for a device in a member group: messages, and what waits to send under its name', () => {
    const { logs, at } = formed();
    const held = heldBy(logs, at, 'kim');
    const waiting = signedAs('kim', {
      type: 'message',
      group: logs.ids.coalition ?? '',
      ts: 99,
      body: { text: 'On its way.' },
    }).record;
    const view = roomView(
      held,
      [deviceGroup(logs, 'A', at, 'ana')],
      room(
        [said(logs, 'zed', 1, 'Can we meet Thursday?'), said(logs, 'kim', 2, 'Thursday works.')],
        [waiting, new Uint8Array([1, 2, 3])],
      ),
    );

    expect(view).toMatchObject({
      coalitionId: logs.ids.coalition,
      roomId: ROOM,
      name: 'Rivers United',
      myName: 'kim',
      standing: { kind: 'writes' },
    });
    expect(view?.messages.map((m) => [m.name, m.text])).toEqual([
      ['zed', 'Can we meet Thursday?'],
      ['kim', 'Thursday works.'],
    ]);
    expect(view?.pending.map((m) => m.text)).toEqual(['On its way.']);
  });

  it('names what waits under the writer’s coalition name, as the others will read it', () => {
    const { logs, at } = formed();
    const held = heldBy(logs, at, 'kim', { me: { author: authorOf('kim'), name: '' } });
    expect(roomView(held, [deviceGroup(logs, 'A', at, 'ana')], undefined)?.myName).toBe('kim');
  });

  it('is an empty room before its entry exists, and none for a device in no member group, as a follower’s', () => {
    const { logs, at } = formed();
    const held = heldBy(logs, at, 'kim');
    expect(roomView(held, [deviceGroup(logs, 'A', at, 'ana')], undefined)).toMatchObject({
      messages: [],
      pending: [],
    });
    expect(roomView(held, [], room([]))).toBeNull();
    logs.group('C', R, ['ana'], 'Elm Row');
    expect(roomView(held, [deviceGroup(logs, 'C', at, 'ana')], room([]))).toBeNull();
    for (const ended of [{ leaving: true }, { archived: true }]) {
      expect(roomView(held, [deviceGroup(logs, 'A', at, 'ana', ended)], room([]))).toBeNull();
    }
  });

  it('is none before the genesis is back', () => {
    const logs = new Logs();
    logs.group('A', R, ['ana'], 'Riverside');
    logs.reconcile('A', R + 3, 'ana', 'Riverside');
    expect(
      roomView(heldBy(logs, R + 5, 'kim'), [deviceGroup(logs, 'A', R + 5, 'ana')], undefined),
    ).toBeNull();
  });
});

describe('roomStanding', () => {
  it('writes once bound to a seat, whatever their level in the group, until they leave the coalition', () => {
    const { logs, at } = formed();
    expect(roomStanding(heldBy(logs, at, 'kim'), [])).toEqual({ kind: 'writes' });
    logs.add('coalition', at + 1, 'kim', { type: 'leave', body: {} });
    expect(roomStanding(heldBy(logs, at + 2, 'kim'), [])).toEqual({ kind: 'reads' });
  });

  it('takes part first from a member group where they may propose, joins while a join waits, else reads', () => {
    const { logs, at } = formed();
    const riverside = deviceGroup(logs, 'A', at, 'ana');
    expect(roomStanding(heldBy(logs, at, 'ana'), [riverside])).toEqual({
      kind: 'take-part',
      groupId: riverside.groupId,
    });
    expect(
      roomStanding(heldBy(logs, at, 'ana', { joinAs: riverside.groupId }), [riverside]),
    ).toEqual({ kind: 'joining' });
    logs.add('A', at, 'ben', { type: 'level', body: { level: FOLLOWING } });
    const ben = deviceGroup(logs, 'A', at + 1, 'ben');
    expect(roomStanding(heldBy(logs, at + 1, 'ben'), [ben])).toEqual({ kind: 'reads' });
  });
});

/**
 * Kim's device: Riverside as ana's, and the coalition as kim's, both read at
 * relay minute R + 100 from the relay `instance`; its room not made yet.
 */
async function kimsStore(logs: Logs, instance: string): Promise<Store> {
  const store = await openStore('kim');
  stores.push(store);
  await store.addGroup({
    groupId: logs.ids.A ?? '',
    secret: new Uint8Array(32).fill(7),
    signingKey: testKeys('ana').secretKey,
    me: { author: authorOf('ana'), name: 'Ana' },
  });
  const pull = (records: LogRecord[]) => ({ records, relayNow: R + 100, instance, lastSyncAt: 1 });
  await store.applyPull(logs.ids.A ?? '', pull(logs.logs.A ?? []), eventIdOf);
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: SECRET,
    signingKey: testKeys('kim').secretKey,
    me: { author: authorOf('kim'), name: 'kim' },
  });
  await store.applyPull(ENTRY, pull(logs.logs.coalition ?? []), eventIdOf);
  return store;
}

describe('sendMessage', () => {
  /** Kim's device, with a sync that only counts its calls. */
  async function device() {
    const { logs } = formed();
    const store = await kimsStore(logs, 'i');
    const syncOnce = vi.fn(() => Promise.resolve(true));
    return { logs, services: { store, sync: { syncOnce }, now: () => 1_762_650_000_000 } };
  }

  it('signs the text, in NFC and trimmed, under the coalition key, queues it in the room and sends at once', async () => {
    const { logs, services } = await device();

    await sendMessage(services, logs.ids.coalition ?? '', ROOM, '  Café on Thursday?\n');

    const [queued, ...more] = (await services.store.getGroup(ROOM))?.outbox ?? [];
    expect(more).toEqual([]);
    expect(parseRecord(queued ?? new Uint8Array())?.event).toEqual({
      v: 1,
      type: 'message',
      group: logs.ids.coalition,
      author: authorOf('kim'),
      ts: 1_762_650_000_000,
      body: { text: 'Café on Thursday?' },
    });
    expect(services.sync.syncOnce).toHaveBeenCalledOnce();
  });

  it('refuses an empty or overlong message, and a room this device can’t read, queueing nothing', async () => {
    const { logs, services } = await device();
    const id = logs.ids.coalition ?? '';
    await expect(sendMessage(services, id, ROOM, ' \n ')).rejects.toThrow('1 to 2,000');
    await expect(sendMessage(services, id, ROOM, 'a'.repeat(2001))).rejects.toThrow('1 to 2,000');
    await expect(sendMessage(services, id, 'another-room', 'Hello')).rejects.toThrow(
      'can’t read that room',
    );
    expect((await services.store.getGroup(ROOM))?.outbox ?? []).toEqual([]);
    expect(services.sync.syncOnce).not.toHaveBeenCalled();
  });
});

describe('sendMessage through the sync loop', () => {
  it('lists a sent message exactly once throughout, though the pull that brings it back lands after the relay took it (#343)', async () => {
    const { logs, at } = formed();
    const fake = createFakeRelay({ minute: R + 100 });
    const store = await kimsStore(logs, fake.instance);
    const held = heldBy(logs, at, 'kim');
    const groups = [deviceGroup(logs, 'A', at, 'ana')];
    const mailbox = deriveWeekMailboxId(INNER, weekOf(fake.minute));
    const text = 'Thursday works for Oak St.';
    /** How many times the room lists the message now: from its outbox or from its log. */
    const copies = async (): Promise<number> => {
      const view = roomView(held, groups, await store.getGroup(ROOM));
      return [...(view?.messages ?? []), ...(view?.pending ?? [])].filter((m) => m.text === text)
        .length;
    };
    // Before each request goes out, the room is read as the store holds it then.
    const seen: { method: string; url: string; copies: number }[] = [];
    let watching = false;
    const watched: Fetch = async (input, init) => {
      const listed = watching ? await copies() : null;
      const response = await fake.fetch(input, init);
      const request = fake.requests.at(-1);
      if (listed !== null && request !== undefined) {
        seen.push({ method: request.method, url: request.url, copies: listed });
      }
      return response;
    };
    const sync = createSync({
      store,
      relay: createRelay({ fetch: watched }),
      seal: xchachaSeal,
      clock: () => 1,
    });
    expect(await sync.syncOnce()).toBe(true);

    watching = true;
    await sendMessage({ store, sync, now: () => 2 }, logs.ids.coalition ?? '', ROOM, text);
    expect(await sync.syncOnce()).toBe(true);

    // The relay took it, and the pull that reads it back went out after: the gap the room once showed.
    const put = seen.findIndex((r) => r.method === 'PUT' && r.url.includes(mailbox));
    expect(put).toBeGreaterThanOrEqual(0);
    const after = seen.slice(put + 1);
    expect(after.some((r) => r.method === 'GET' && r.url.includes(mailbox))).toBe(true);
    expect([...seen.map((r) => r.copies), await copies()]).toEqual(seen.map(() => 1).concat(1));
    const view = roomView(held, groups, await store.getGroup(ROOM));
    expect(view?.pending).toEqual([]);
    expect(view?.messages.map((m) => [m.name, m.text])).toEqual([['kim', text]]);
  });
});
