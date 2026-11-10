import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { epochCommit, unwrapEpochSecret } from '../crypto/epoch';
import { deriveMailboxId, deriveSealKey, newGroupSecret } from '../crypto/groupKeys';
import { open, type Seal, seal, xchachaSeal } from '../crypto/seal';
import { parseRecord } from '../engine/event';
import type { Score, SignedEvent } from '../engine/event';
import { LEVELS } from '../engine/capabilities';
import { fold } from '../engine/fold';
import type { GroupState } from '../engine/fold';
import { createRelay } from '../net/relay';
import type { Fetch, Relay } from '../net/relay';
import { contains, local, utf8 } from '../test/bytes';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { manualTimers } from '../test/timers';
import type { ChatBot } from './chatBot';
import { openStore } from './db';
import type { Group, Store } from './db';
import { eventIdOf } from './eventId';
import { keyChangeOf } from './epochs';
import { createSync, openRecords } from './sync';
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
      kx: testKx(ANA).kx,
    },
  });
}

/** `author` joins the group founded by `founding` as `name`, with their encryption key (#98). */
function join(founding: SignedEvent, author: string, name: string): SignedEvent {
  const body = { name, kx: testKx(author).kx };
  return signedAs(author, { type: 'join', group: founding.id, ts: TS, body });
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
  const { kxKey } = testKx(name);
  await store.addGroup({ groupId: GROUP, secret, signingKey, kxKey, me: { author, name } });
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

describe('a new group key when someone leaves (#98)', () => {
  /** Ana founds the group, carrying her encryption key. */
  function keyedGenesis(): SignedEvent {
    return signedAs(ANA, {
      type: 'genesis',
      group: '',
      ts: TS,
      body: {
        name: 'Riverside Tenants',
        founder: 'Ana',
        title: 'House rules',
        atoms: ['Quiet after 10pm.', 'Bins out on Sunday.'],
        kx: testKx(ANA).kx,
      },
    });
  }

  const [FOLLOWING, , CREATING] = LEVELS;

  /** `author` joins as a Co-Creator, carrying their encryption key unless `kx` is false. */
  function keyedJoin(founding: SignedEvent, author: string, kx = true): SignedEvent {
    const body = { name: author, level: CREATING, ...(kx ? { kx: testKx(author).kx } : {}) };
    return signedAs(author, { type: 'join', group: founding.id, ts: TS, body });
  }

  /** A device of `name` in the group `founding` names, holding `secret` and, unless told not to, its encryption key. */
  async function member(
    name: string,
    relay: Relay,
    founding: SignedEvent,
    secret: Uint8Array,
    kx = true,
  ): Promise<KeyedDevice> {
    const store = await openStore(name);
    const { secretKey: signingKey, author } = testKeys(name);
    const keys = kx ? { kxKey: testKx(name).kxKey } : {};
    await store.addGroup({
      groupId: founding.id,
      secret,
      signingKey,
      me: { author, name },
      ...keys,
    });
    return keyed(store, relay, founding.id);
  }

  interface KeyedDevice {
    readonly store: Store;
    readonly sync: Sync;
    group(): Promise<Group>;
    state(): Promise<GroupState>;
  }

  function keyed(store: Store, relay: Relay, groupId: string): KeyedDevice {
    const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
    opened.push(sync);
    const group = async (): Promise<Group> => {
      const found = await store.getGroup(groupId);
      if (found === undefined) throw new Error('the group is gone');
      return found;
    };
    const state = async (): Promise<GroupState> => {
      const { log, relayNow } = await group();
      return fold(log, relayNow);
    };
    return { store, sync, group, state };
  }

  /** The state two devices fold, apart from the records each left out. */
  function comparable(state: GroupState): GroupState {
    return { ...state, ignored: [] };
  }

  /** The event types each PUT to `mailbox` carried, opened with `secret`'s keys. */
  function putTo(fake: FakeRelay, secret: Uint8Array): string[] {
    const mailbox = deriveMailboxId(secret);
    const key = deriveSealKey(secret);
    return fake.requests
      .filter((request) => request.method === 'PUT' && request.url.includes(mailbox))
      .map((request) => {
        const bytes = open(mailbox, key, request.body ?? new Uint8Array());
        return bytes === null ? '?' : (parseRecord(bytes)?.event.type ?? '?');
      });
  }

  /** Ana, Ben and Cal in one group, each device holding everything, with nothing queued. */
  async function threeMembers() {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const secret = newGroupSecret();
    const founding = keyedGenesis();
    const ana = await member(ANA, relay, founding, secret);
    const ben = await member(BEN, relay, founding, secret);
    const cal = await member('cal', relay, founding, secret);
    await ana.store.enqueue(founding.id, founding.record);
    await ana.sync.syncOnce();
    await ben.store.enqueue(founding.id, keyedJoin(founding, BEN).record);
    await ben.sync.syncOnce();
    await cal.store.enqueue(founding.id, keyedJoin(founding, 'cal').record);
    await cal.sync.syncOnce();
    for (const device of [ana, ben, cal]) await device.sync.syncOnce();
    return { fake, relay, secret, founding, ana, ben, cal };
  }

  /** Cal signs a leave, queues it, and syncs: the relay has it, and Cal's device has purged the group. */
  async function calLeaves(cal: KeyedDevice, founding: SignedEvent): Promise<void> {
    const leave = signedAs('cal', { type: 'leave', group: founding.id, ts: TS, body: {} });
    await cal.store.markLeaving(founding.id, leave.record);
    await cal.sync.syncOnce();
    expect(await cal.store.getGroup(founding.id)).toBeUndefined();
  }

  it('ends with exactly one canonical key change, every remaining device on the new mailbox, and one folded state', async () => {
    const { fake, secret, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);

    // Both remaining devices see the leave at once, and each may take up the duty.
    await Promise.all([ana.sync.syncOnce(), ben.sync.syncOnce()]);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();

    const [a, b] = [await ana.state(), await ben.state()];
    expect(comparable(a)).toEqual(comparable(b));
    expect(a.epoch).toBe(1);
    expect(a.rotations).toHaveLength(1);
    const [rotation] = a.rotations;
    expect(Object.keys(rotation?.wraps ?? {}).sort()).toEqual(
      [authorOf(ANA), authorOf(BEN)].sort(),
    );
    const [onAna, onBen] = [await ana.group(), await ben.group()];
    expect([onAna.epoch, onBen.epoch]).toEqual([1, 1]);
    expect(local(onAna.secret)).toEqual(local(onBen.secret));
    expect(local(onAna.secret)).not.toEqual(local(secret));
    expect(epochCommit(founding.id, 1, onAna.secret)).toBe(rotation?.commit);
    // Each reads the new mailbox from the key change's seq, and the old one no more.
    expect(
      [onAna.cursor, onBen.cursor].every((cursor) => cursor >= (rotation?.seq ?? Infinity)),
    ).toBe(true);
    const before = fake.requests.length;
    await ana.sync.syncOnce();
    const reads = fake.requests.slice(before).map((request) => request.url);
    expect(reads).toEqual([
      `/v1/mailbox/${deriveMailboxId(onAna.secret)}?after=${String(onAna.cursor)}&limit=100`,
    ]);
  });

  it('never wraps the new secret to the member who left, nor to anyone else', async () => {
    const { fake, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();

    const [rotation] = (await ana.state()).rotations;
    const calKx = testKx('cal').kxKey;
    for (const [member, wrap] of Object.entries(rotation?.wraps ?? {})) {
      const place = { groupId: founding.id, epoch: 1, commit: rotation?.commit ?? '', wrap };
      expect(unwrapEpochSecret({ ...place, member, kxKey: calKx })).toBeNull();
      expect(unwrapEpochSecret({ ...place, member: authorOf('cal'), kxKey: calKx })).toBeNull();
    }
    expect(rotation).toBeDefined();
    expect(fake.blobs(deriveMailboxId((await ana.group()).secret))).toEqual([]);
  });

  it('posts again, once, a Proposal that reached the old mailbox after the key changed, and it folds once', async () => {
    const { fake, secret, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    await ana.sync.syncOnce();
    expect((await ana.group()).epoch).toBe(1);

    // Ben hasn't heard of the leave, so his Proposal goes to the old mailbox, after the key change.
    const late = signedAs(BEN, {
      type: 'proposal',
      group: founding.id,
      ts: TS,
      body: {
        atom: `${founding.id}.0`,
        title: 'Later quiet hours',
        why: 'Shift work.',
        text: 'Quiet after 11pm.',
      },
    });
    await ben.store.enqueue(founding.id, late.record);
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();

    const [a, b] = [await ana.state(), await ben.state()];
    expect(comparable(a)).toEqual(comparable(b));
    expect(a.proposals.map((p) => p.id)).toEqual([late.id]);
    const newSecret = (await ana.group()).secret;
    expect(putTo(fake, secret).filter((type) => type === 'proposal')).toHaveLength(1);
    expect(putTo(fake, newSecret).filter((type) => type === 'proposal')).toHaveLength(1);
    expect(a.proposals[0]?.seq).toBeGreaterThan(a.rotations[0]?.seq ?? Infinity);
    expect((await ben.group()).outbox).toEqual([]);
  });

  it('sends only key-rotate and leave to the old mailbox while the key change is due', async () => {
    const { fake, relay, secret, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    // Ben's device reads the leave, as a pass would, before any key change is posted.
    const held = await ben.group();
    const page = await relay.getBlobs(deriveMailboxId(secret), held.cursor);
    const records = openRecords(
      xchachaSeal,
      { mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) },
      page.records,
    );
    await ben.store.applyPull(
      founding.id,
      {
        records,
        cursor: page.records.at(-1)?.seq ?? held.cursor,
        relayNow: page.now,
        instance: page.instance,
        lastSyncAt: TS,
      },
      eventIdOf,
    );
    expect((await ben.state()).rotationDue).toBe(true);
    const ballot = signedAs(BEN, {
      type: 'level',
      group: founding.id,
      ts: TS,
      body: { level: FOLLOWING },
    });
    await ben.store.enqueue(founding.id, ballot.record);
    const before = fake.requests.length;

    await ben.sync.syncOnce();

    fake.requests.splice(0, before);
    expect(putTo(fake, secret)).toEqual(['key-rotate']);
    expect(putTo(fake, (await ben.group()).secret)).toEqual(['level']);
    await ana.sync.syncOnce();
    expect(comparable(await ana.state())).toEqual(comparable(await ben.state()));
  });

  it('lets a leave through while the key change is due', async () => {
    const { fake, relay, secret, founding, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    const held = await ben.group();
    const mailbox = deriveMailboxId(secret);
    const page = await relay.getBlobs(mailbox, held.cursor);
    const records = openRecords(xchachaSeal, { mailbox, key: deriveSealKey(secret) }, page.records);
    await ben.store.applyPull(
      founding.id,
      {
        records,
        cursor: page.records.at(-1)?.seq ?? held.cursor,
        relayNow: page.now,
        instance: page.instance,
        lastSyncAt: TS,
      },
      eventIdOf,
    );
    const level = signedAs(BEN, {
      type: 'level',
      group: founding.id,
      ts: TS,
      body: { level: FOLLOWING },
    });
    await ben.store.enqueue(founding.id, level.record);
    const leave = signedAs(BEN, { type: 'leave', group: founding.id, ts: TS, body: {} });
    await ben.store.markLeaving(founding.id, leave.record);
    const before = fake.requests.length;

    await ben.sync.syncOnce();

    fake.requests.splice(0, before);
    expect(putTo(fake, secret)).toEqual(['leave']);
    expect(await ben.store.getGroup(founding.id)).toBeUndefined();
  });

  it('takes up no key change it has no wrap for, keeps reading the old mailbox, and says why', async () => {
    const { fake, relay, secret, founding, ana, ben, cal } = await threeMembers();
    // Cal's other device, restored from a backup: the same keys, and everything Cal had.
    const restored = await openStore('cal-elsewhere');
    await restored.restoreGroups([{ ...(await cal.group()), missingHistory: false }]);
    const elsewhere = keyed(restored, relay, founding.id);
    await calLeaves(cal, founding);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();

    await elsewhere.sync.syncOnce();

    const [group, state] = [await elsewhere.group(), await elsewhere.state()];
    expect([group.epoch ?? 0, state.epoch]).toEqual([0, 1]);
    expect(local(group.secret)).toEqual(local(secret));
    expect(keyChangeOf(group, state)).toBe('left');
    expect(fake.requests.at(-1)?.url).toContain(deriveMailboxId(secret));
    // Ben's view is current: nothing to say.
    expect(keyChangeOf(await ben.group(), await ben.state())).toBeNull();
  });

  it('says this device missed the new key when its member had no encryption key yet', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const secret = newGroupSecret();
    const mailbox = deriveMailboxId(secret);
    const founding = keyedGenesis();
    const ana = await member(ANA, relay, founding, secret);
    const cal = await member('cal', relay, founding, secret);
    await ana.store.enqueue(founding.id, founding.record);
    await ana.sync.syncOnce();
    await cal.store.enqueue(founding.id, keyedJoin(founding, 'cal').record);
    await cal.sync.syncOnce();
    // Ben's device joined before #98: no key, and a join without one, then Cal leaves.
    const ben = await member(BEN, relay, founding, secret, false);
    const sealed = xchachaSeal.seal(
      mailbox,
      deriveSealKey(secret),
      keyedJoin(founding, BEN, false).record,
    );
    await relay.putBlob(mailbox, sealed, 30);
    await calLeaves(cal, founding);
    await ana.sync.syncOnce();

    await ben.sync.syncOnce();

    const state = await ben.state();
    expect(state.epoch).toBe(1);
    expect(state.rotations[0]?.wraps).not.toHaveProperty(authorOf(BEN));
    expect(keyChangeOf(await ben.group(), state)).toBe('missed');
  });

  it('posts kx once from a store kept before #98, and the fold records it', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const secret = newGroupSecret();
    const founding = keyedGenesis();
    const ana = await member(ANA, relay, founding, secret);
    await ana.store.enqueue(founding.id, founding.record);
    await ana.sync.syncOnce();
    // Ben's device kept the group before #98: no encryption key, and a join without one.
    const old = await member(BEN, relay, founding, secret, false);
    await old.store.enqueue(founding.id, keyedJoin(founding, BEN, false).record);
    await old.sync.syncOnce();
    old.sync.stop();
    old.store.close();
    const ben = keyed(await openStore(BEN), relay, founding.id);

    await ben.sync.syncOnce();
    await ben.sync.syncOnce();
    await ben.sync.syncOnce();

    const kept = await ben.group();
    expect(kept.kxKey).toBeDefined();
    const mine = (await ben.state()).members.find((m) => m.author === authorOf(BEN));
    expect(mine?.kx).toBe(base64url(kxPublicKeyOf(kept.kxKey ?? new Uint8Array())));
    expect(putTo(fake, secret).filter((type) => type === 'kx')).toHaveLength(1);
    expect(kept.outbox).toEqual([]);
  });
});
