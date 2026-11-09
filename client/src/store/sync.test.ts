import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubSeal } from '../crypto/stubSeal';
import { createRelay } from '../net/relay';
import type { Fetch, Relay } from '../net/relay';
import { text, utf8 } from '../test/bytes';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore } from './db';
import type { Group, LogRecord, NewGroup, Store } from './db';
import { createSync } from './sync';
import type { Sync } from './sync';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const secret = new Uint8Array(32).fill(9);
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) {
    sync.stop();
  }
});

/** A fresh random mailbox id, so runs against a real relay never share one. */
function newMailbox(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A test's event id: the bytes as text, or `null` for anything not JSON-like. */
function idOf(bytes: Uint8Array): string | null {
  const body = text(bytes);
  return body.startsWith('{') ? body : null;
}

/** A distinct event's bytes. */
function event(name: string): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify({ event: name }));
}

interface Device {
  store: Store;
  sync: Sync;
  group: () => Promise<Group>;
}

/** A device in the group, with its own store, syncing through `relay`. */
async function device(
  name: string,
  relay: Relay,
  mailbox: string,
  extra: Partial<NewGroup> = {},
): Promise<Device> {
  const store = await openStore(name);
  await store.addGroup({ groupId: GROUP, mailbox, secret, me: { author: name, name }, ...extra });
  const sync = createSync({ store, relay, idOf, clock: () => 1_762_650_000_000 });
  opened.push(sync);
  return {
    store,
    sync,
    group: async () => {
      const group = await store.getGroup(GROUP);
      if (group === undefined) {
        throw new Error('the group is gone');
      }
      return group;
    },
  };
}

/** The real relay at `RECONCILE_RELAY_URL` when set, else a fake one. */
function relayUnderTest(): Relay {
  const live: unknown = import.meta.env.RECONCILE_RELAY_URL;
  if (typeof live === 'string' && live !== '') {
    return createRelay({ baseUrl: `${live.replace(/\/$/, '')}/v1` });
  }
  return createRelay({ fetch: createFakeRelay().fetch });
}

/** Each item's bytes as text: a log record's, or the bytes themselves. */
function texts(items: (Uint8Array | { bytes: Uint8Array })[]): string[] {
  return items.map((item) => text('bytes' in item ? item.bytes : item));
}

function plain(log: LogRecord[]): [number, number, string][] {
  return log.map((record) => [record.seq, record.received, text(record.bytes)]);
}

/** The event names a fake relay's PUTs carried, opened from their blobs. */
function posted(fake: FakeRelay): string[] {
  return fake.requests
    .filter((request) => request.method === 'PUT')
    .map((request) =>
      text(stubSeal.open('', secret, request.body ?? new Uint8Array()) ?? utf8('?')),
    );
}

describe('two devices on one mailbox', () => {
  it('reach the same log when they post interleaved events', async () => {
    const relay = relayUnderTest();
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    const ben = await device('ben', relay, mailbox);

    await ana.store.enqueue(GROUP, event('ana-1'));
    await ben.store.enqueue(GROUP, event('ben-1'));
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    await ana.store.enqueue(GROUP, event('ana-2'));
    await ben.store.enqueue(GROUP, event('ben-2'));
    await ben.sync.syncOnce();
    await ana.store.enqueue(GROUP, event('ana-3'));
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();

    const [a, b] = [await ana.group(), await ben.group()];
    expect(texts(a.log)).toEqual(
      ['ana-1', 'ben-1', 'ben-2', 'ana-2', 'ana-3'].map((name) => JSON.stringify({ event: name })),
    );
    expect(plain(a.log)).toEqual(plain(b.log));
    expect([a.outbox, b.outbox]).toEqual([[], []]);
  });
});

describe('a sync pass', () => {
  it('posts each event sealed in a padded blob, kept 30 days', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, event('ana-1'));

    await ana.sync.syncOnce();

    const [put] = fake.requests;
    expect(put?.url).toMatch(/\?ttl_days=30$/);
    expect(put?.body?.length).toBe(1024);
  });

  it('saves the cursor, relay time, instance and time of the sync', async () => {
    const fake = createFakeRelay({ minute: 29_000_123 });
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, event('ana-1'));

    expect(await ana.sync.syncOnce()).toBe(true);

    expect(await ana.group()).toMatchObject({
      cursor: 1,
      relayNow: 29_000_123,
      instance: fake.instance,
      lastSyncAt: 1_762_650_000_000,
    });
  });

  it('keeps an event made offline queued across a reload, then posts it exactly once, in order', async () => {
    const fake = createFakeRelay();
    fake.offline = true;
    const mailbox = newMailbox();
    const before = await device('ana', createRelay({ fetch: fake.fetch }), mailbox);
    await before.store.enqueue(GROUP, event('offline-1'));
    await before.store.enqueue(GROUP, event('offline-2'));
    expect(await before.sync.syncOnce()).toBe(false);
    before.store.close();

    const store = await openStore('ana');
    const after = createSync({ store, relay: createRelay({ fetch: fake.fetch }), idOf });
    opened.push(after);
    const queued = (await store.getGroup(GROUP))?.outbox ?? [];
    fake.offline = false;
    expect(await after.syncOnce()).toBe(true);
    await after.syncOnce();

    expect(texts(queued)).toEqual(texts([event('offline-1'), event('offline-2')]));
    expect(posted(fake)).toEqual(texts([event('offline-1'), event('offline-2')]));
    const group = await store.getGroup(GROUP);
    expect(group?.outbox).toEqual([]);
    expect(texts(group?.log ?? [])).toEqual(texts([event('offline-1'), event('offline-2')]));
  });

  it('brings every group back from IndexedDB after a reload with the network off', async () => {
    const fake = createFakeRelay();
    const before = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await before.store.enqueue(GROUP, event('genesis'));
    await before.sync.syncOnce();
    before.store.close();
    fake.offline = true;

    const store = await openStore('ana');
    const sync = createSync({ store, relay: createRelay({ fetch: fake.fetch }), idOf });
    opened.push(sync);
    const ok = await sync.syncOnce();

    expect(ok).toBe(false);
    const groups = await store.listGroups();
    expect(groups.map((group) => group.groupId)).toEqual([GROUP]);
    expect(texts(groups[0]?.log ?? [])).toEqual(texts([event('genesis')]));
  });

  it('keeps an entry, and every entry after it, until the relay accepts it', async () => {
    const fake = createFakeRelay();
    let refuse = true;
    const refusing: Fetch = (input, init) =>
      refuse && init?.method === 'PUT'
        ? Promise.resolve(Response.json({ error: 'storage_full' }, { status: 507 }))
        : fake.fetch(input, init);
    const ana = await device('ana', createRelay({ fetch: refusing }), newMailbox());
    await ana.store.enqueue(GROUP, event('first'));
    await ana.store.enqueue(GROUP, event('second'));

    const refused = await ana.sync.syncOnce();
    const kept = texts((await ana.group()).outbox);
    refuse = false;
    await ana.sync.syncOnce();

    expect(refused).toBe(false);
    expect(kept).toEqual(texts([event('first'), event('second')]));
    expect(posted(fake)).toEqual(texts([event('first'), event('second')]));
    expect((await ana.group()).outbox).toEqual([]);
  });

  it('skips a blob that will not open, and reads past it', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    const junk = new Uint8Array(1024).fill(1);
    await relay.putBlob(mailbox, junk);
    await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, event('real')));

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(plain(group.log).map(([seq, , body]) => [seq, body])).toEqual([
      [2, text(event('real'))],
    ]);
    expect(group.cursor).toBe(2);
  });

  it('skips an event already in the log, posted twice by its author', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    for (let i = 0; i < 2; i += 1) {
      await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, event('twice')));
    }

    await ana.sync.syncOnce();

    expect(plain((await ana.group()).log)).toEqual([[1, fake.minute, text(event('twice'))]]);
  });

  it('goes on to the next group when one fails', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const ana = await device('ana', relay, newMailbox());
    await ana.store.addGroup({
      groupId: 'broken',
      mailbox: 'not-a-mailbox',
      secret,
      me: { author: 'a', name: 'Ana' },
    });
    await ana.store.enqueue(GROUP, event('ana-1'));

    const ok = await ana.sync.syncOnce();

    expect(ok).toBe(false);
    expect(texts((await ana.group()).log)).toEqual(texts([event('ana-1')]));
  });

  it('shares one pass between callers that ask at the same time', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, event('ana-1'));

    const results = await Promise.all([ana.sync.syncOnce(), ana.sync.syncOnce()]);

    expect(results).toEqual([true, true]);
    expect(posted(fake)).toEqual(texts([event('ana-1')]));
  });

  it('fails without throwing when the store itself fails', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    vi.spyOn(ana.store, 'listGroups').mockRejectedValue(new Error('closed'));

    expect(await ana.sync.syncOnce()).toBe(false);
  });
});

describe('a new relay instance', () => {
  it('resets the cursor, re-posts the outbox, and reads the fresh relay from the start', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    const ben = await device('ben', relay, mailbox);
    for (const name of ['ana-1', 'ana-2', 'ana-3']) {
      await ana.store.enqueue(GROUP, event(name));
    }
    await ana.sync.syncOnce();
    fake.restart();
    await ben.store.enqueue(GROUP, event('ben-1'));
    await ben.sync.syncOnce();
    await ana.store.enqueue(GROUP, event('ana-4'));
    let firstGet = true;
    ana.sync = createSync({
      store: ana.store,
      idOf,
      relay: createRelay({
        fetch: async (input, init) => {
          const response = await fake.fetch(input, init);
          if (init?.method === 'GET' && firstGet) {
            firstGet = false;
            await ana.store.enqueue(GROUP, event('ana-5'));
          }
          return response;
        },
      }),
    });

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(texts(group.log)).toEqual(
      texts(['ana-1', 'ana-2', 'ana-3', 'ben-1', 'ana-4', 'ana-5'].map(event)),
    );
    expect(group).toMatchObject({ cursor: 3, instance: fake.instance, outbox: [] });
  });

  it('folds no event twice when the new instance still holds the old blobs', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, event('ana-1'));
    await ana.store.enqueue(GROUP, event('ana-2'));
    await ana.sync.syncOnce();
    fake.restart({ keep: true });
    await ana.store.enqueue(GROUP, event('ana-3'));

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(texts(group.log)).toEqual(texts(['ana-1', 'ana-2', 'ana-3'].map(event)));
    expect(group).toMatchObject({ cursor: 3, instance: fake.instance });
  });
});

describe('reachability', () => {
  it('turns false while passes fail and true once one succeeds, telling subscribers', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    const heard: boolean[] = [];
    const unsubscribe = ana.sync.subscribe(() => heard.push(ana.sync.isReachable()));

    const initially = ana.sync.isReachable();
    fake.offline = true;
    await ana.sync.syncOnce();
    await ana.sync.syncOnce();
    fake.offline = false;
    await ana.sync.syncOnce();
    unsubscribe();
    fake.offline = true;
    await ana.sync.syncOnce();

    expect(initially).toBe(true);
    expect(heard).toEqual([false, true]);
  });
});

describe('polling', () => {
  it('runs a pass at once when started, and stops when asked', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, event('ana-1'));

    ana.sync.start();
    await vi.waitFor(async () => {
      expect((await ana.group()).log).toHaveLength(1);
    });
    ana.sync.stop();

    expect(posted(fake)).toEqual(texts([event('ana-1')]));
  });
});
