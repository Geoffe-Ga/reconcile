/**
 * Coalition rooms in the sync loop (#125): read and posted by the same weekly
 * mailbox pass as a group, under keys from the coalition's `inner`, each PUT
 * kept 30 days and waking no one, every stored record more than 30 days of
 * relay time old deleted on the next sync, and purged as soon as the group
 * that held its seat leaves. The relay's clock is the fake's `minute`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveSealKey, deriveWeekMailboxId, WEEK_MINUTES, weekOf } from '../crypto/groupKeys';
import { deriveRoomEntryId } from '../crypto/room';
import { xchachaSeal } from '../crypto/seal';
import { createRelay, type Relay } from '../net/relay';
import { ROOM_KEEP_MINUTES } from '../engine/room';
import { Logs, testSecret } from '../test/coalitions';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import { createSync } from './sync';

freshIndexedDBPerTest();

const MINUTE = 29_000_000;
const SECRET = fromBase64url(testSecret('coalition'));
const INNER = fromBase64url(testSecret('inner'));
const ENTRY = deriveCoalitionEntryId(SECRET);
const ROOM = deriveRoomEntryId(INNER);
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Riverside (A: ana, ben) holds a seat of the formed coalition, whose participants are kim and zed. */
function logs(): Logs {
  const built = new Logs();
  built.group('A', MINUTE - 100, ['ana', 'ben']);
  built.reconcile('A', MINUTE - 90, 'ana', 'A');
  built.formed(MINUTE - 80, ['A', 'B'], ['kim', 'zed']);
  return built;
}

/** `records` sealed into `secret`'s mailbox for the week of relay minute `minute`. */
async function post(
  relay: Relay,
  secret: Uint8Array,
  minute: number,
  records: readonly Uint8Array[],
) {
  const mailbox = deriveWeekMailboxId(secret, weekOf(minute));
  for (const bytes of records) {
    await relay.putBlob(mailbox, xchachaSeal.seal(mailbox, deriveSealKey(secret), bytes), 30);
  }
}

/** A message by `who` in the coalition `built` folds, with `text`, signed at device time `ts`. */
function message(built: Logs, who: string, text: string, ts = 1) {
  return signedAs(who, { type: 'message', group: built.ids.coalition ?? '', ts, body: { text } })
    .record;
}

/**
 * A device on `fake`: the coalition's entry, synced from the relay, as cal's,
 * who hasn't taken part, so it reports nothing for group A; and, unless it
 * only follows (#124), group A as ana's.
 */
async function device(fake: FakeRelay, name: string, built: Logs, member = true) {
  const relay = createRelay({ fetch: fake.fetch });
  const store = await openStore(name);
  stores.push(store);
  if (member) {
    await store.addGroup({
      groupId: built.ids.A ?? '',
      secret: new Uint8Array(32).fill(7),
      signingKey: testKeys('ana').secretKey,
      me: { author: authorOf('ana'), name: 'Ana' },
    });
    const pull = {
      records: built.logs.A ?? [],
      relayNow: MINUTE,
      instance: fake.instance,
      lastSyncAt: 1,
    };
    await store.applyPull(built.ids.A ?? '', pull, eventIdOf);
  }
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: SECRET,
    signingKey: testKeys('cal').secretKey,
    me: { author: authorOf('cal'), name: '' },
  });
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => 1 });
  return { relay, store, sync };
}

/** Puts the coalition's log on the relay, for this week. */
async function setUp(fake: FakeRelay) {
  const built = logs();
  const relay = createRelay({ fetch: fake.fetch });
  await post(
    relay,
    SECRET,
    fake.minute,
    (built.logs.coalition ?? []).map((r) => r.bytes),
  );
  return { built, relay };
}

/** Every mailbox id the room has from week 0 up to the fake's week. */
function roomMailboxes(fake: FakeRelay): string[] {
  const week = weekOf(fake.minute);
  return [0, ...Array.from({ length: 6 }, (_, i) => week - 5 + i)].map((w) =>
    deriveWeekMailboxId(INNER, w),
  );
}

describe('a room in the sync loop', () => {
  it('reads and posts under keys from inner, kept 30 days and waking no one', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const { built, relay } = await setUp(fake);
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'Can we meet Thursday?')]);
    const { store, sync } = await device(fake, 'ana', built);

    expect(await sync.syncOnce()).toBe(true);
    const room = await store.getGroup(ROOM);
    expect(room?.kind).toBe('room');
    expect(room?.log).toHaveLength(1);

    await store.enqueue(ROOM, message(built, 'kim', 'Thursday works for Oak St.'));
    const before = fake.requests.length;
    expect(await sync.syncOnce()).toBe(true);
    const mailbox = deriveWeekMailboxId(INNER, weekOf(fake.minute));
    const puts = fake.requests.slice(before).filter((r) => r.method === 'PUT');
    expect(puts.filter((r) => r.url.includes(mailbox)).map((r) => r.url)).toEqual([
      `/v1/mailbox/${mailbox}?ttl_days=30`,
    ]);
    expect(puts.filter((r) => r.url.includes('wake'))).toEqual([]);
    expect((await store.getGroup(ROOM))?.outbox).toEqual([]);
    const blobs = fake.blobs(mailbox);
    expect(blobs).toHaveLength(2);
    expect(blobs.every((blob) => blob.length === 1024)).toBe(true);
    const opened = xchachaSeal.open(mailbox, deriveSealKey(INNER), blobs[1] ?? new Uint8Array());
    expect(opened).toEqual(message(built, 'kim', 'Thursday works for Oak St.'));
    // The coalition secret's keys open nothing in the room's mailbox.
    expect(
      xchachaSeal.open(mailbox, deriveSealKey(SECRET), blobs[1] ?? new Uint8Array()),
    ).toBeNull();
  });

  it('deletes a message 30 days and 1 minute old from IndexedDB on the next sync, keeping one 30 days old', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const { built, relay } = await setUp(fake);
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'First.')]);
    fake.minute += 1;
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'Second.')]);
    const { store, sync } = await device(fake, 'ana', built);
    expect(await sync.syncOnce()).toBe(true);
    expect((await store.getGroup(ROOM))?.log).toHaveLength(2);

    fake.minute = MINUTE + ROOM_KEEP_MINUTES;
    expect(await sync.syncOnce()).toBe(true);
    expect((await store.getGroup(ROOM))?.log).toHaveLength(2);

    fake.minute = MINUTE + ROOM_KEEP_MINUTES + 1;
    expect(await sync.syncOnce()).toBe(true);
    const [left, ...more] = (await store.getGroup(ROOM))?.log ?? [];
    expect(more).toEqual([]);
    expect(left?.received).toBe(MINUTE + 1);
  });

  it('reads the last 5 weeks of a room it has never read, so a newcomer sees its last 30 days', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const { built, relay } = await setUp(fake);
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'Four weeks ago.')]);
    fake.minute += 4 * WEEK_MINUTES;
    await post(
      relay,
      SECRET,
      fake.minute,
      (built.logs.coalition ?? []).map((r) => r.bytes),
    );
    const { store, sync } = await device(fake, 'newcomer', built);

    expect(await sync.syncOnce()).toBe(true);
    expect((await store.getGroup(ROOM))?.log).toHaveLength(1);
  });

  it('never makes a room on a device that holds only the coalition, as a follower’s, nor names its mailboxes', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const { built, relay } = await setUp(fake);
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'Members only.')]);
    const { store, sync } = await device(fake, 'follower', built, false);
    const read = fake.requests.length;

    expect(await sync.syncOnce()).toBe(true);
    expect(await sync.syncOnce()).toBe(true);

    expect(await store.listRooms()).toEqual([]);
    expect((await store.getGroup(ENTRY))?.log.length).toBeGreaterThan(0);
    const named = roomMailboxes(fake).filter((id) =>
      fake.requests.slice(read).some((r) => r.url.includes(id)),
    );
    expect(named).toEqual([]);
  });

  it('purges the room and reads it no more once the device leaves the group that held its seat', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const { built, relay } = await setUp(fake);
    await post(relay, INNER, fake.minute, [message(built, 'zed', 'Before ana leaves.')]);
    const { store, sync } = await device(fake, 'ana', built);
    expect(await sync.syncOnce()).toBe(true);
    expect((await store.getGroup(ROOM))?.log).toHaveLength(1);

    fake.offline = true;
    const leave = signedAs('ana', { type: 'leave', group: built.ids.A ?? '', ts: 2, body: {} });
    await store.markLeaving(built.ids.A ?? '', leave.record);
    expect(await sync.syncOnce()).toBe(false);
    // Purged at once, though the relay can't be reached and the leave still waits.
    expect(await store.getGroup(ROOM)).toBeUndefined();

    fake.offline = false;
    const read = fake.requests.length;
    expect(await sync.syncOnce()).toBe(true);
    expect(await sync.syncOnce()).toBe(true);
    expect(await store.listGroups()).toEqual([]);
    expect(await store.listRooms()).toEqual([]);
    const named = roomMailboxes(fake).filter((id) =>
      fake.requests.slice(read).some((r) => r.url.includes(id)),
    );
    expect(named).toEqual([]);
  });
});
