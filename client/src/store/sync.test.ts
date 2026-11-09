import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubSeal } from '../crypto/stubSeal';
import { base64url, parseRecord } from '../engine/event';
import type { Score, SignedEvent } from '../engine/event';
import { fold } from '../engine/fold';
import type { GroupState } from '../engine/fold';
import { createRelay } from '../net/relay';
import type { Fetch, Relay } from '../net/relay';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { manualTimers } from '../test/timers';
import { openStore } from './db';
import type { Group, Store } from './db';
import { createSync } from './sync';
import type { Sync } from './sync';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const TS = 1_762_650_000_000;
/** Test key names: each signs with its own fixed key. */
const ANA = 'ana';
const BEN = 'ben';
const secret = new Uint8Array(32).fill(9);
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) {
    sync.stop();
  }
});

/** A fresh random mailbox id, so runs against a real relay never share one. */
function newMailbox(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
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

/** A device in the group, with its own store, syncing through `relay`. */
async function device(name: string, relay: Relay, mailbox: string): Promise<Device> {
  const store = await openStore(name);
  const { secretKey: signingKey, author } = testKeys(name);
  await store.addGroup({ groupId: GROUP, mailbox, secret, signingKey, me: { author, name } });
  return attach(store, relay);
}

/** The device `name` after a reload: a new store on the same IndexedDB. */
async function reopen(name: string, relay: Relay): Promise<Device> {
  return attach(await openStore(name), relay);
}

function attach(store: Store, relay: Relay): Device {
  const sync = createSync({ store, relay, clock: () => TS });
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

/** The events a fake relay's PUTs carried, opened from their blobs. */
function posted(fake: FakeRelay): string[] {
  return labels(
    fake.requests
      .filter((request) => request.method === 'PUT')
      .map(
        (request) =>
          stubSeal.open('', secret, request.body ?? new Uint8Array()) ?? new Uint8Array(),
      ),
  );
}

describe('two devices on one mailbox', () => {
  it('fold the same state when they post interleaved events', async () => {
    const relay = relayUnderTest();
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    const ben = await device('ben', relay, mailbox);
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
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, genesis().record);

    await ana.sync.syncOnce();

    const [put] = fake.requests;
    expect(put?.url).toMatch(/\?ttl_days=30$/);
    expect(put?.body?.length).toBe(1024);
  });

  it('saves the cursor, relay time, instance and time of the sync', async () => {
    const fake = createFakeRelay({ minute: 29_000_123 });
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
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
    const before = await device('ana', relay, newMailbox());
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
    expect(posted(fake)).toEqual(expected);
    const group = await after.group();
    expect(group.outbox).toEqual([]);
    expect(labels(group.log)).toEqual(expected);
    expect((await after.state()).members).toHaveLength(3);
  });

  it('brings every group and its Document back from IndexedDB with the network off', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const before = await device('ana', relay, newMailbox());
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
    const ana = await device('ana', createRelay({ fetch: refusing }), newMailbox());
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
    expect(posted(fake)).toEqual(['genesis:Riverside Tenants', 'join:Ben']);
    expect((await ana.group()).outbox).toEqual([]);
  });

  it('skips a blob that will not open, and reads past it', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    await relay.putBlob(mailbox, new Uint8Array(1024).fill(1));
    await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, genesis().record));

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(group.log.map((record) => record.seq)).toEqual([2]);
    expect(group.cursor).toBe(2);
    expect((await ana.state()).title).toBe('House rules');
  });

  it('skips a blob that opens to something that is not an event', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, new Uint8Array([123, 125])));

    await ana.sync.syncOnce();

    expect(await ana.group()).toMatchObject({ log: [], cursor: 1 });
  });

  it('keeps no record that fails to verify, so a forged copy can’t shadow the real one', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    const real = genesis();
    const forged = Uint8Array.from(real.record);
    forged[33] = (forged[33] ?? 0) ^ 0x01;
    await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, forged));
    await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, real.record));

    await ana.sync.syncOnce();

    expect((await ana.group()).log.map((record) => record.seq)).toEqual([2]);
    expect(await ana.state()).toMatchObject({ group: real.id, ignored: [] });
  });

  it('appends an event once, however many times it was posted', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const mailbox = newMailbox();
    const ana = await device('ana', relay, mailbox);
    for (let i = 0; i < 2; i += 1) {
      await relay.putBlob(mailbox, stubSeal.seal(mailbox, secret, genesis().record));
    }

    await ana.sync.syncOnce();

    expect((await ana.group()).log.map((record) => record.seq)).toEqual([1]);
    expect((await ana.state()).ignored).toEqual([]);
  });

  it('goes on to the next group when one fails', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.addGroup({
      groupId: 'broken',
      mailbox: 'not-a-mailbox',
      secret,
      signingKey: testKeys(ANA).secretKey,
      me: { author: authorOf(ANA), name: 'Ana' },
    });
    await ana.store.enqueue(GROUP, genesis().record);

    const ok = await ana.sync.syncOnce();

    expect(ok).toBe(false);
    expect((await ana.state()).title).toBe('House rules');
  });

  it('shares one pass between callers that ask at the same time', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
    await ana.store.enqueue(GROUP, genesis().record);

    const results = await Promise.all([ana.sync.syncOnce(), ana.sync.syncOnce()]);

    expect(results).toEqual([true, true]);
    expect(posted(fake)).toEqual(['genesis:Riverside Tenants']);
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
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newMailbox());
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
    await ana.store.enqueue(GROUP, genesis().record);

    ana.sync.start();
    await vi.waitFor(async () => {
      expect((await ana.group()).log).toHaveLength(1);
    });
    ana.sync.stop();

    expect(posted(fake)).toEqual(['genesis:Riverside Tenants']);
  });
});

describe('coming back online', () => {
  it('sends the outbox at once, without waiting out the backoff', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const clock = manualTimers();
    const ana = await device('ana', relay, newMailbox());
    ana.sync = createSync({ store: ana.store, relay, clock: () => TS, timers: clock.timers });
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

    expect(posted(fake)).toEqual(['genesis:Riverside Tenants']);
    expect((await ana.group()).outbox).toEqual([]);
    expect(ana.sync.isReachable()).toBe(true);
  });
});
