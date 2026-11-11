/**
 * Coalition entries in the sync loop (#114): synced by the same weekly
 * mailbox pass as a group, with none of a group's extras, read no more once
 * declined, and a coalition's recent log read straight from the relay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveSealKey, deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { createRelay, type Relay } from '../net/relay';
import { Logs, testSecret } from '../test/coalitions';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, testKeys } from '../test/keys';
import { openStore, type Store } from './db';
import type { PushUpkeep } from './push';
import { createSync, readRecentLog } from './sync';

freshIndexedDBPerTest();

const MINUTE = 29_000_000;
const SECRET = fromBase64url(testSecret('coalition'));
const ENTRY = deriveCoalitionEntryId(SECRET);
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** `records` sealed into the coalition's mailbox for the fake relay's week. */
async function post(relay: Relay, records: readonly Uint8Array[]) {
  const mailbox = deriveWeekMailboxId(SECRET, weekOf(MINUTE));
  for (const bytes of records) {
    await relay.putBlob(mailbox, xchachaSeal.seal(mailbox, deriveSealKey(SECRET), bytes), 30);
  }
  return mailbox;
}

/** A store holding the coalition's entry as kim's, and a sync loop with a chat bot and push spies. */
async function setUp() {
  const fake = createFakeRelay({ minute: MINUTE });
  const relay = createRelay({ fetch: fake.fetch });
  const store = await openStore('device');
  stores.push(store);
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: SECRET,
    signingKey: testKeys('kim').secretKey,
    me: { author: authorOf('kim'), name: 'Kim' },
  });
  const chatBot = { run: vi.fn(() => Promise.resolve()) };
  const push = {
    nudge: vi.fn(() => Promise.resolve()),
    upkeep: vi.fn(() => Promise.resolve()),
    forget: vi.fn(),
  } as unknown as PushUpkeep;
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => 1, chatBot, push });
  return { fake, relay, store, sync, chatBot, push };
}

describe('a coalition’s entry in the sync loop', () => {
  it('reads its weekly mailbox like a group’s, and posts no key, chat or nudge of a group’s', async () => {
    const { fake, relay, store, sync, chatBot, push } = await setUp();
    const logs = new Logs();
    logs.formed(MINUTE, ['A', 'B'], ['kim', 'zed']);
    const mailbox = await post(
      relay,
      (logs.logs.coalition ?? []).map((r) => r.bytes),
    );
    const before = fake.requests.length;

    expect(await sync.syncOnce()).toBe(true);
    const entry = await store.getGroup(ENTRY);
    expect(entry?.log).toHaveLength(logs.logs.coalition?.length ?? 0);
    expect(entry?.outbox).toEqual([]);
    const after = fake.requests.slice(before);
    expect(after.every((request) => request.method === 'GET')).toBe(true);
    expect(after.some((request) => request.url.includes(mailbox))).toBe(true);
    expect(chatBot.run).not.toHaveBeenCalled();
    expect(vi.mocked(push.nudge)).not.toHaveBeenCalled();
  });

  it('posts what its outbox holds without asking the relay to wake anyone', async () => {
    const { fake, relay, store, sync } = await setUp();
    const logs = new Logs();
    logs.coalition(MINUTE, ['A', 'B']);
    await post(
      relay,
      (logs.logs.coalition ?? []).map((r) => r.bytes),
    );
    logs.join(MINUTE + 1, 'kim', 'A');
    const join = logs.logs.coalition?.at(-1)?.bytes ?? new Uint8Array();
    await store.enqueue(ENTRY, join);

    expect(await sync.syncOnce()).toBe(true);
    const putRequest = fake.requests.find(
      (request) => request.method === 'PUT' && !request.url.includes('push'),
    );
    expect(putRequest?.url).not.toContain('wake=1');
    expect((await store.getGroup(ENTRY))?.outbox).toEqual([]);
  });

  it('reads nothing more once the coalition was declined', async () => {
    const { fake, relay, store, sync } = await setUp();
    const logs = new Logs();
    logs.coalition(MINUTE, ['A', 'B']);
    logs.join(MINUTE + 1, 'kim', 'A');
    logs.result(MINUTE + 2, 'kim', logs.ids.coalition ?? '', 'A', 'fail');
    await post(
      relay,
      (logs.logs.coalition ?? []).map((r) => r.bytes),
    );
    expect(await sync.syncOnce()).toBe(true);
    const read = fake.requests.length;

    expect(await sync.syncOnce()).toBe(true);
    expect(fake.requests.slice(read).filter((r) => r.url.includes('/v1/mailbox/'))).toEqual([]);
    expect(await store.listGroups()).toEqual([]);
  });
});

describe('readRecentLog', () => {
  it('reads last week’s and this week’s mailboxes from the start, in relay order', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const relay = createRelay({ fetch: fake.fetch });
    const logs = new Logs();
    logs.formed(MINUTE, ['A', 'B'], ['kim', 'zed']);
    const records = (logs.logs.coalition ?? []).map((r) => r.bytes);
    await post(relay, records);

    const read = await readRecentLog(relay, xchachaSeal, SECRET, MINUTE + 5);
    expect(read.records.map((r) => r.bytes)).toEqual(records);
    expect(read.cursor).toBe(read.records.at(-1)?.seq);
    expect(read.relayNow).toBe(MINUTE);
    const lastWeek = deriveWeekMailboxId(SECRET, weekOf(MINUTE) - 1);
    expect(fake.requests.some((r) => r.method === 'GET' && r.url.includes(lastWeek))).toBe(true);
  });

  it('reads nothing as a cursor of 0, and refuses reads from two relay instances', async () => {
    const fake = createFakeRelay({ minute: MINUTE });
    const relay = createRelay({ fetch: fake.fetch });
    expect(await readRecentLog(relay, xchachaSeal, SECRET, MINUTE)).toMatchObject({
      records: [],
      cursor: 0,
    });
    let calls = 0;
    const changing: Pick<Relay, 'getBlobs'> = {
      getBlobs: async (mailbox, after) => {
        calls += 1;
        const page = await relay.getBlobs(mailbox, after);
        return { ...page, instance: `instance-${String(calls)}` };
      },
    };
    await expect(readRecentLog(changing, xchachaSeal, SECRET, MINUTE)).rejects.toThrow(
      'changed instance',
    );
  });
});
