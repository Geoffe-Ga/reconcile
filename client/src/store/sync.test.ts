import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { deriveMailboxId, deriveSealKey, newGroupSecret } from '../crypto/groupKeys';
import { open, type Seal, seal, xchachaSeal } from '../crypto/seal';
import { parseRecord } from '../engine/event';
import type { Score, SignedEvent } from '../engine/event';
import { fold } from '../engine/fold';
import type { GroupState } from '../engine/fold';
import { createRelay } from '../net/relay';
import type { Fetch, Relay } from '../net/relay';
import { contains, utf8 } from '../test/bytes';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { manualTimers } from '../test/timers';
import type { ChatBot } from './chatBot';
import { openStore } from './db';
import type { Group, Store } from './db';
import { createSync } from './sync';
import type { Sync, SyncOptions } from './sync';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const TS = 1_762_650_000_000;
/** Test key names: each signs with its own fixed key. */
const ANA = 'ana';
const BEN = 'ben';
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) {
    sync.stop();
  }
});

/** A group's secret, with the mailbox id and seal key it derives. */
interface Keys {
  readonly secret: Uint8Array;
  readonly mailbox: string;
  readonly key: Uint8Array;
}

/** A fresh group secret, so runs against a real relay never share a mailbox. */
function newKeys(): Keys {
  const secret = newGroupSecret();
  return { secret, mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) };
}

/** `record` sealed for the group with `keys`, as a device would post it. */
function sealedFor(keys: Keys, record: Uint8Array): Uint8Array<ArrayBuffer> {
  return seal(keys.mailbox, keys.key, record);
}

/** Ana founds the group with a two-Atom Document. */
function genesis(): SignedEvent {
  return signedAs(ANA, {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      title: 'House rules',
      atoms: ['Quiet after 10pm.', 'Bins out on Sunday.'],
    },
  });
}

/** `author` joins the group founded by `founding` as `name`. */
function join(founding: SignedEvent, author: string, name: string): SignedEvent {
  return signedAs(author, { type: 'join', group: founding.id, ts: TS, body: { name } });
}

/** Ana proposes `text` for the group's first Atom. */
function proposal(founding: SignedEvent, text: string): SignedEvent {
  return signedAs(ANA, {
    type: 'proposal',
    group: founding.id,
    ts: TS,
    body: { atom: `${founding.id}.0`, title: 'Later quiet hours', why: 'Shift work.', text },
  });
}

/** `author` scores the Proposal `proposed`. */
function vote(
  founding: SignedEvent,
  author: string,
  proposed: SignedEvent,
  score: Score,
): SignedEvent {
  return signedAs(author, {
    type: 'vote',
    group: founding.id,
    ts: TS,
    body: { proposal: proposed.id, scores: { [proposed.id]: score } },
  });
}

interface Device {
  store: Store;
  sync: Sync;
  group: () => Promise<Group>;
  state: () => Promise<GroupState>;
}

/** A device in the group whose secret `keys` holds, with its own store, syncing through `relay`. */
async function device(name: string, relay: Relay, keys: Keys): Promise<Device> {
  const store = await openStore(name);
  const { secretKey: signingKey, author } = testKeys(name);
  const { secret } = keys;
  await store.addGroup({ groupId: GROUP, secret, signingKey, me: { author, name } });
  return attach(store, relay);
}

/** The device `name` after a reload: a new store on the same IndexedDB. */
async function reopen(name: string, relay: Relay): Promise<Device> {
  return attach(await openStore(name), relay);
}

function attach(store: Store, relay: Relay): Device {
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
  opened.push(sync);
  const group = async (): Promise<Group> => {
    const found = await store.getGroup(GROUP);
    if (found === undefined) {
      throw new Error('the group is gone');
    }
    return found;
  };
  return {
    store,
    sync,
    group,
    state: async () => {
      const { log, relayNow } = await group();
      return fold(log, relayNow);
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

/** Each signed record's event as `type:name`, from a log, an outbox or a list of records. */
function labels(items: readonly (Uint8Array | { readonly bytes: Uint8Array })[]): string[] {
  return items.map((item) => {
    const event = parseRecord('bytes' in item ? item.bytes : item)?.event ?? null;
    return event === null ? '?' : `${event.type}:${'name' in event.body ? event.body.name : ''}`;
  });
}

/** The events a fake relay's PUTs carried, opened from their blobs with the group's keys. */
function posted(fake: FakeRelay, keys: Keys): string[] {
  return labels(
    fake.requests
      .filter((request) => request.method === 'PUT')
      .map(
        (request) =>
          open(keys.mailbox, keys.key, request.body ?? new Uint8Array()) ?? new Uint8Array(),
      ),
  );
}

describe('two devices on one mailbox', () => {
  it('fold the same state when they post interleaved events', async () => {
    const relay = relayUnderTest();
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    const ben = await device('ben', relay, keys);
    const founding = genesis();
    const quietLater = proposal(founding, 'Quiet after 11pm.');

    await ana.store.enqueue(GROUP, founding.record);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    await ben.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    await ana.store.enqueue(GROUP, quietLater.record);
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    await ben.store.enqueue(GROUP, vote(founding, BEN, quietLater, 4).record);
    await ana.store.enqueue(GROUP, vote(founding, ANA, quietLater, 3).record);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();

    const [a, b] = [await ana.state(), await ben.state()];
    expect(a).toEqual(b);
    expect(a.members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
    expect(a.proposals[0]).toMatchObject({ final: true, outcome: { kind: 'pass' } });
    expect(a.atoms.map((atom) => atom.text)).toEqual(['Quiet after 11pm.', 'Bins out on Sunday.']);
    expect(a.ignored).toEqual([]);
    expect([(await ana.group()).outbox, (await ben.group()).outbox]).toEqual([[], []]);
  });
});

describe('a sync pass', () => {
  it('posts each event sealed in a padded blob, kept 30 days', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    await ana.store.enqueue(GROUP, genesis().record);

    await ana.sync.syncOnce();

    const [put] = fake.requests;
    expect(put?.url).toMatch(/\?ttl_days=30$/);
    expect(put?.body?.length).toBe(1024);
  });

  it('posts to the mailbox the secret derives, sealed under the key it derives, and nothing readable', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);

    await ana.sync.syncOnce();

    const [put] = fake.requests;
    expect(put?.url).toBe(`/v1/mailbox/${keys.mailbox}?ttl_days=30`);
    const blob = put?.body ?? new Uint8Array();
    expect(open(keys.mailbox, keys.key, blob)).toEqual(founding.record);
    const readable = [
      founding.bytes,
      founding.record.subarray(0, 32),
      keys.secret,
      keys.key,
      utf8('Riverside Tenants'),
      utf8(authorOf(ANA)),
    ];
    for (const bytes of readable) expect(contains(blob, bytes)).toBe(false);
  });

  it('saves the cursor, relay time, instance and time of the sync', async () => {
    const fake = createFakeRelay({ minute: 29_000_123 });
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    await ana.store.enqueue(GROUP, genesis().record);

    expect(await ana.sync.syncOnce()).toBe(true);

    expect(await ana.group()).toMatchObject({
      cursor: 1,
      relayNow: 29_000_123,
      instance: fake.instance,
      lastSyncAt: TS,
    });
  });

  it('keeps events made offline queued across a reload, then posts each once, in order', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    fake.offline = true;
    const founding = genesis();
    const keys = newKeys();
    const before = await device('ana', relay, keys);
    for (const event of [founding, join(founding, BEN, 'Ben'), join(founding, 'cy', 'Cy')]) {
      await before.store.enqueue(GROUP, event.record);
    }
    expect(await before.sync.syncOnce()).toBe(false);
    before.store.close();

    const after = await reopen('ana', relay);
    const queued = labels((await after.group()).outbox);
    fake.offline = false;
    expect(await after.sync.syncOnce()).toBe(true);
    await after.sync.syncOnce();

    const expected = ['genesis:Riverside Tenants', 'join:Ben', 'join:Cy'];
    expect(queued).toEqual(expected);
    expect(posted(fake, keys)).toEqual(expected);
    const group = await after.group();
    expect(group.outbox).toEqual([]);
    expect(labels(group.log)).toEqual(expected);
    expect((await after.state()).members).toHaveLength(3);
  });

  it('brings every group and its Document back from IndexedDB with the network off', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const before = await device('ana', relay, newKeys());
    await before.store.enqueue(GROUP, genesis().record);
    await before.sync.syncOnce();
    before.store.close();
    fake.offline = true;

    const after = await reopen('ana', relay);
    const ok = await after.sync.syncOnce();

    expect(ok).toBe(false);
    expect((await after.store.listGroups()).map((group) => group.groupId)).toEqual([GROUP]);
    const document = await after.state();
    expect(document.title).toBe('House rules');
    expect(document.atoms.map((atom) => atom.text)).toEqual([
      'Quiet after 10pm.',
      'Bins out on Sunday.',
    ]);
  });

  it('keeps an entry, and every entry after it, until the relay accepts it', async () => {
    const fake = createFakeRelay();
    let refuse = true;
    const refusing: Fetch = (input, init) =>
      refuse && init?.method === 'PUT'
        ? Promise.resolve(Response.json({ error: 'storage_full' }, { status: 507 }))
        : fake.fetch(input, init);
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: refusing }), keys);
    const founding = genesis();
    for (const event of [founding, join(founding, BEN, 'Ben')]) {
      await ana.store.enqueue(GROUP, event.record);
    }

    const refused = await ana.sync.syncOnce();
    const kept = labels((await ana.group()).outbox);
    refuse = false;
    await ana.sync.syncOnce();

    expect(refused).toBe(false);
    expect(kept).toEqual(['genesis:Riverside Tenants', 'join:Ben']);
    expect(posted(fake, keys)).toEqual(['genesis:Riverside Tenants', 'join:Ben']);
    expect((await ana.group()).outbox).toEqual([]);
  });

  it('skips a blob that will not open, and reads past it', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    await relay.putBlob(keys.mailbox, new Uint8Array(1024).fill(1));
    await relay.putBlob(keys.mailbox, sealedFor(keys, genesis().record));

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(group.log.map((record) => record.seq)).toEqual([2]);
    expect(group.cursor).toBe(2);
    expect((await ana.state()).title).toBe('House rules');
  });

  it('skips blobs that fail to open between good ones: the next good one folds, and the cursor moves past', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const other = newKeys();
    const ana = await device('ana', relay, keys);
    const founding = genesis();
    const tampered = sealedFor(keys, join(founding, 'cy', 'Cy').record);
    tampered[500] = (tampered[500] ?? 0) ^ 0x01;
    await relay.putBlob(keys.mailbox, sealedFor(keys, founding.record));
    await relay.putBlob(keys.mailbox, tampered);
    await relay.putBlob(
      keys.mailbox,
      seal(keys.mailbox, other.key, join(founding, 'di', 'Di').record),
    );
    await relay.putBlob(
      keys.mailbox,
      seal(other.mailbox, keys.key, join(founding, 'eve', 'Eve').record),
    );
    await relay.putBlob(keys.mailbox, sealedFor(keys, join(founding, BEN, 'Ben').record));

    expect(await ana.sync.syncOnce()).toBe(true);

    const group = await ana.group();
    expect(group.log.map((record) => record.seq)).toEqual([1, 5]);
    expect(group.cursor).toBe(5);
    const state = await ana.state();
    expect(state.members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
    expect(state.ignored).toEqual([]);
  });

  it('skips a blob that opens to something that is not an event', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    await relay.putBlob(keys.mailbox, sealedFor(keys, new Uint8Array([123, 125])));

    await ana.sync.syncOnce();

    expect(await ana.group()).toMatchObject({ log: [], cursor: 1 });
  });

  it('keeps no record that fails to verify, so a forged copy can’t shadow the real one', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    const real = genesis();
    const forged = Uint8Array.from(real.record);
    forged[33] = (forged[33] ?? 0) ^ 0x01;
    await relay.putBlob(keys.mailbox, sealedFor(keys, forged));
    await relay.putBlob(keys.mailbox, sealedFor(keys, real.record));

    await ana.sync.syncOnce();

    expect((await ana.group()).log.map((record) => record.seq)).toEqual([2]);
    expect(await ana.state()).toMatchObject({ group: real.id, ignored: [] });
  });

  it('appends an event once, however many times it was posted', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    for (let i = 0; i < 2; i += 1) {
      await relay.putBlob(keys.mailbox, sealedFor(keys, genesis().record));
    }

    await ana.sync.syncOnce();

    expect((await ana.group()).log.map((record) => record.seq)).toEqual([1]);
    expect((await ana.state()).ignored).toEqual([]);
  });

  it('goes on to the next group when one fails', async () => {
    const fake = createFakeRelay();
    const broken = newKeys();
    const refusing: Fetch = (input, init) =>
      typeof input === 'string' && input.includes(broken.mailbox)
        ? Promise.resolve(Response.json({ error: 'storage_full' }, { status: 507 }))
        : fake.fetch(input, init);
    const ana = await device('ana', createRelay({ fetch: refusing }), newKeys());
    await ana.store.addGroup({
      groupId: 'broken',
      secret: broken.secret,
      signingKey: testKeys(ANA).secretKey,
      me: { author: authorOf(ANA), name: 'Ana' },
    });
    await ana.store.enqueue('broken', genesis().record);
    await ana.store.enqueue(GROUP, genesis().record);

    const ok = await ana.sync.syncOnce();

    expect(ok).toBe(false);
    expect((await ana.state()).title).toBe('House rules');
  });

  it('shares one pass between callers that ask at the same time', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    await ana.store.enqueue(GROUP, genesis().record);

    const results = await Promise.all([ana.sync.syncOnce(), ana.sync.syncOnce()]);

    expect(results).toEqual([true, true]);
    expect(posted(fake, keys)).toEqual(['genesis:Riverside Tenants']);
  });

  it('fails without throwing when the store itself fails', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    vi.spyOn(ana.store, 'listGroups').mockRejectedValue(new Error('closed'));

    expect(await ana.sync.syncOnce()).toBe(false);
  });
});

describe('the chat bot in a pass (#119)', () => {
  /** A sync loop for Ana in two groups, running `chatBot`, with one group's relay refusing. */
  async function twoGroups(chatBot: ChatBot) {
    const fake = createFakeRelay();
    const broken = newKeys();
    const refusing: Fetch = (input, init) =>
      typeof input === 'string' && input.includes(broken.mailbox)
        ? Promise.resolve(Response.json({ error: 'storage_full' }, { status: 507 }))
        : fake.fetch(input, init);
    const store = await openStore('ana');
    const me = { author: authorOf(ANA), name: 'Ana' };
    const signingKey = testKeys(ANA).secretKey;
    await store.addGroup({ groupId: GROUP, secret: newKeys().secret, signingKey, me });
    await store.addGroup({ groupId: 'broken', secret: broken.secret, signingKey, me });
    await store.enqueue('broken', genesis().record);
    const sync = createSync({
      store,
      relay: createRelay({ fetch: refusing }),
      seal: xchachaSeal,
      chatBot,
    });
    opened.push(sync);
    return { store, sync };
  }

  it('runs once for each group that synced, after its pull is saved, and never for one that failed', async () => {
    const seen: (number | null)[] = [];
    const { store, sync } = await twoGroups({
      run: async (groupId) => {
        seen.push((await store.getGroup(groupId))?.relayNow ?? null);
      },
    });

    expect(await sync.syncOnce()).toBe(false);

    expect(seen).toEqual([29_000_000]);
  });

  it('never fails a pass, however it fails', async () => {
    const run = vi.fn(() => Promise.reject(new Error('Discord is down')));
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    const sync = createSync({
      store: ana.store,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      chatBot: { run },
    });
    opened.push(sync);

    expect(await sync.syncOnce()).toBe(true);
    expect(run).toHaveBeenCalledWith(GROUP);
    expect(sync.isReachable()).toBe(true);
  });
});

describe('a new relay instance', () => {
  it('resets the cursor, re-posts the outbox, and reads the fresh relay from the start', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    const ben = await device('ben', relay, keys);
    const founding = genesis();
    for (const event of [founding, join(founding, 'cy', 'Cy'), join(founding, 'di', 'Di')]) {
      await ana.store.enqueue(GROUP, event.record);
    }
    await ana.sync.syncOnce();
    fake.restart();
    await ben.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    await ben.sync.syncOnce();
    await ana.store.enqueue(GROUP, join(founding, 'eve', 'Eve').record);
    let firstGet = true;
    const enqueueDuringFirstGet: Fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (init?.method === 'GET' && firstGet) {
        firstGet = false;
        await ana.store.enqueue(GROUP, join(founding, 'fay', 'Fay').record);
      }
      return response;
    };
    ana.sync = createSync({
      store: ana.store,
      relay: createRelay({ fetch: enqueueDuringFirstGet }),
      seal: xchachaSeal,
    });

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(group).toMatchObject({ cursor: 3, instance: fake.instance, outbox: [] });
    const state = await ana.state();
    expect(state.members.map((member) => member.name)).toEqual([
      'Ana',
      'Cy',
      'Di',
      'Ben',
      'Eve',
      'Fay',
    ]);
    expect(state.ignored).toEqual([]);
  });

  it('folds no event twice when the new instance still holds the old blobs', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);
    await ana.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    await ana.sync.syncOnce();
    fake.restart({ keep: true });
    await ana.store.enqueue(GROUP, join(founding, 'cy', 'Cy').record);

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(group.log.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(group).toMatchObject({ cursor: 3, instance: fake.instance });
    const state = await ana.state();
    expect(state.ignored).toEqual([]);
    expect(state.members.map((member) => member.name)).toEqual(['Ana', 'Ben', 'Cy']);
  });
});

describe('createSync', () => {
  it('takes the seal as a required option, so no caller can forget it and post plaintext', () => {
    expectTypeOf<Pick<SyncOptions, 'seal'>>().toEqualTypeOf<{ seal: Seal }>();
  });
});

describe('reachability', () => {
  it('turns false while passes fail and true once one succeeds, telling subscribers', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
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
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    await ana.store.enqueue(GROUP, genesis().record);

    ana.sync.start();
    await vi.waitFor(async () => {
      expect((await ana.group()).log).toHaveLength(1);
    });
    ana.sync.stop();

    expect(posted(fake, keys)).toEqual(['genesis:Riverside Tenants']);
  });
});

describe('coming back online', () => {
  it('sends the outbox at once, without waiting out the backoff', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const clock = manualTimers();
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    ana.sync = createSync({
      store: ana.store,
      relay,
      seal: xchachaSeal,
      clock: () => TS,
      timers: clock.timers,
    });
    opened.push(ana.sync);
    await ana.store.enqueue(GROUP, genesis().record);
    fake.offline = true;
    ana.sync.start();
    await vi.waitFor(() => {
      expect(clock.waits()).toEqual([6000]);
    });

    fake.offline = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(clock.waits()).toEqual([3000]);
    });

    expect(posted(fake, keys)).toEqual(['genesis:Riverside Tenants']);
    expect((await ana.group()).outbox).toEqual([]);
    expect(ana.sync.isReachable()).toBe(true);
  });
});
