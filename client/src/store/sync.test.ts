import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { epochCommit, unwrapEpochSecret } from '../crypto/epoch';
import fc from 'fast-check';

import {
  deriveSealKey,
  deriveWeekMailboxId,
  newGroupSecret,
  WEEK_MINUTES,
  weekOf,
} from '../crypto/groupKeys';
import { open, type Seal, seal, xchachaSeal } from '../crypto/seal';
import { parseRecord } from '../engine/event';
import { resultFor } from '../engine/expiry';
import type { Score, SignedEvent } from '../engine/event';
import { LEVELS } from '../engine/capabilities';
import { fold } from '../engine/fold';
import type { GroupState } from '../engine/fold';
import { createRelay } from '../net/relay';
import type { Fetch, Relay } from '../net/relay';
import { contains, local, utf8 } from '../test/bytes';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay, FakeRequest } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { manualTimers } from '../test/timers';
import type { ChatBot } from './chatBot';
import { openStore } from './db';
import type { Group, Pull, Store } from './db';
import { eventIdOf } from './eventId';
import { keyChangeOf } from './epochs';
import type { PushUpkeep } from './push';
import { createSync, openRecords } from './sync';
import type { Sync, SyncOptions } from './sync';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const TS = 1_762_650_000_000;
/** The fake relay's first minute, 160 minutes before its week ends, and that week (#110). */
const MINUTE = 29_000_000;
const WEEK = weekOf(MINUTE);
/** Test key names: each signs with its own fixed key. */
const ANA = 'ana';
const BEN = 'ben';
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) {
    sync.stop();
  }
});

/** A group's secret, with its mailbox id in the fake relay's first week and the seal key it derives. */
interface Keys {
  readonly secret: Uint8Array;
  readonly mailbox: string;
  readonly key: Uint8Array;
}

/** A fresh group secret, so runs against a real relay never share a mailbox. */
function newKeys(): Keys {
  const secret = newGroupSecret();
  return { secret, mailbox: deriveWeekMailboxId(secret, WEEK), key: deriveSealKey(secret) };
}

/** The mailbox id a request's URL names. */
function mailboxIn(url: string): string {
  return /\/v1\/mailbox\/([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? '';
}

/** The fake relay's PUTs of blobs, oldest first. */
function puts(fake: FakeRelay): FakeRequest[] {
  return fake.requests.filter((request) => request.method === 'PUT');
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

/** The events a fake relay's PUTs carried, each opened for the mailbox it went to with the group's key. */
function posted(fake: FakeRelay, keys: Pick<Keys, 'key'>): string[] {
  return labels(
    puts(fake).map(
      (request) =>
        open(mailboxIn(request.url), keys.key, request.body ?? new Uint8Array()) ??
        new Uint8Array(),
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

    const [put] = puts(fake);
    expect(put?.url).toMatch(/\?ttl_days=30$/);
    expect(put?.body?.length).toBe(1024);
  });

  it('posts to this week’s mailbox the secret derives, sealed under the key it derives, and nothing readable', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);

    await ana.sync.syncOnce();

    const [put] = puts(fake);
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

  it('saves each mailbox’s cursor, the relay time, instance and time of the sync', async () => {
    const fake = createFakeRelay({ minute: 29_000_123 });
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    await ana.store.enqueue(GROUP, genesis().record);

    expect(await ana.sync.syncOnce()).toBe(true);

    expect(await ana.group()).toMatchObject({
      cursor: 0,
      cursors: { [deriveWeekMailboxId(keys.secret, WEEK - 1)]: 0, [keys.mailbox]: 1 },
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
    expect(group.cursors?.[keys.mailbox]).toBe(2);
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
    expect(group.cursors?.[keys.mailbox]).toBe(5);
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

    expect(await ana.group()).toMatchObject({ log: [], cursors: { [keys.mailbox]: 1 } });
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
  async function twoGroups(chatBot: Pick<ChatBot, 'run'>) {
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

describe('the front door keeper in a pass (#121)', () => {
  it('runs for each group after its pull is saved, then looks for replies once the pass is complete', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    const order: string[] = [];
    const sync = createSync({
      store: ana.store,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      door: {
        run: async (groupId) => {
          const relayNow = (await ana.store.getGroup(groupId))?.relayNow ?? null;
          order.push(`run ${groupId} at ${String(relayNow)}`);
        },
        replies: () => {
          order.push('replies');
          return Promise.resolve();
        },
      },
      afterPass: () => {
        order.push('afterPass');
        return Promise.resolve();
      },
    });
    opened.push(sync);

    expect(await sync.syncOnce()).toBe(true);

    expect(order).toEqual([`run ${GROUP} at 29000000`, 'replies', 'afterPass']);
  });

  it('looks for replies on a device in no group, and never fails a pass, however it fails', async () => {
    const fake = createFakeRelay();
    const store = await openStore('kim');
    const run = vi.fn(() => Promise.reject(new Error('the page mailbox is full')));
    const replies = vi.fn(() => Promise.reject(new Error('offline')));
    const sync = createSync({
      store,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      door: { run, replies },
    });
    opened.push(sync);

    expect(await sync.syncOnce()).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalledTimes(1);
    expect(sync.isReachable()).toBe(true);
  });

  it('runs nothing for a group that failed, nor once halted (#78)', async () => {
    const run = vi.fn(() => Promise.resolve());
    const replies = vi.fn(() => Promise.resolve());
    const fake = createFakeRelay();
    const store = await openStore('ana');
    const me = { author: authorOf(ANA), name: 'Ana' };
    const signingKey = testKeys(ANA).secretKey;
    await store.addGroup({ groupId: 'broken', secret: new Uint8Array(31), signingKey, me });
    const relay = createRelay({ fetch: fake.fetch });
    const broken = createSync({ store, relay, seal: xchachaSeal, door: { run, replies } });
    opened.push(broken);
    expect(await broken.syncOnce()).toBe(false);
    expect([run.mock.calls.length, replies.mock.calls.length]).toEqual([0, 0]);

    await store.purgeGroup('broken');
    await broken.halt();
    expect(await broken.syncOnce()).toBe(false);
    expect(replies).not.toHaveBeenCalled();
  });
});

describe('after a pass (#97)', () => {
  it('runs once a pass in which every group synced, after the pulls are saved', async () => {
    const fake = createFakeRelay();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), newKeys());
    const seen: (number | null)[] = [];
    const sync = createSync({
      store: ana.store,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      afterPass: async () => {
        seen.push((await ana.store.getGroup(GROUP))?.relayNow ?? null);
      },
    });
    opened.push(sync);

    expect(await sync.syncOnce()).toBe(true);
    fake.minute += 1;
    expect(await sync.syncOnce()).toBe(true);

    expect(seen).toEqual([29_000_000, 29_000_001]);
  });

  it('doesn’t run after a pass in which a group failed, and never fails a pass itself', async () => {
    const afterPass = vi.fn(() => Promise.reject(new Error('the relay backup failed')));
    const failing = vi.fn(() => Promise.resolve());
    const { sync } = await (async () => {
      const fake = createFakeRelay();
      const store = await openStore('ana');
      const me = { author: authorOf(ANA), name: 'Ana' };
      const signingKey = testKeys(ANA).secretKey;
      await store.addGroup({ groupId: GROUP, secret: newKeys().secret, signingKey, me });
      const relay = createRelay({ fetch: fake.fetch });
      const ok = createSync({ store, relay, seal: xchachaSeal, afterPass });
      opened.push(ok);
      expect(await ok.syncOnce()).toBe(true);
      await store.addGroup({ groupId: 'broken', secret: new Uint8Array(31), signingKey, me });
      const broken = createSync({ store, relay, seal: xchachaSeal, afterPass: failing });
      opened.push(broken);
      return { sync: broken };
    })();

    expect(await sync.syncOnce()).toBe(false);

    expect(afterPass).toHaveBeenCalledTimes(1);
    expect(failing).not.toHaveBeenCalled();
  });
});

describe('a new relay instance', () => {
  it('reads the fresh relay from the start, posts the outbox to it, and keeps its records after the old ones', async () => {
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
    expect(group).toMatchObject({
      cursor: 0,
      cursors: { [keys.mailbox]: 3 },
      instance: fake.instance,
      outbox: [],
    });
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
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);
    await ana.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    await ana.sync.syncOnce();
    fake.restart({ keep: true });
    await ana.store.enqueue(GROUP, join(founding, 'cy', 'Cy').record);

    await ana.sync.syncOnce();

    const group = await ana.group();
    expect(group.log.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(group).toMatchObject({ cursors: { [keys.mailbox]: 3 }, instance: fake.instance });
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

  /**
   * The event type each PUT under `secret` carried, and the mailbox it went
   * to: each blob that opens for its mailbox under `secret`'s seal key, in any week.
   */
  function putsUnder(fake: FakeRelay, secret: Uint8Array): { type: string; mailbox: string }[] {
    const key = deriveSealKey(secret);
    return puts(fake).flatMap((request) => {
      const mailbox = mailboxIn(request.url);
      const bytes = open(mailbox, key, request.body ?? new Uint8Array());
      return bytes === null ? [] : [{ type: parseRecord(bytes)?.event.type ?? '?', mailbox }];
    });
  }

  /** The event types each PUT under `secret` carried, in any week. */
  function putTo(fake: FakeRelay, secret: Uint8Array): string[] {
    return putsUnder(fake, secret).map(({ type }) => type);
  }

  /** The relay records of `secret`'s mailbox in the fake relay's first week, after `held`'s cursor there, as a pass's pull. */
  async function pullOf(relay: Relay, secret: Uint8Array, held: Group): Promise<Pull> {
    const mailbox = deriveWeekMailboxId(secret, WEEK);
    const after = held.cursors?.[mailbox] ?? held.cursor;
    const page = await relay.getBlobs(mailbox, after);
    const key = deriveSealKey(secret);
    return {
      records: openRecords(xchachaSeal, { mailbox, key }, page.records),
      cursors: { ...held.cursors, [mailbox]: page.records.at(-1)?.seq ?? after },
      relayNow: page.now,
      instance: page.instance,
      lastSyncAt: TS,
    };
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
    // Each reads the new mailboxes from the key change's seq on, and the old ones no more.
    expect([onAna.cursor, onBen.cursor]).toEqual([rotation?.seq, rotation?.seq]);
    const thisWeek = deriveWeekMailboxId(onAna.secret, WEEK);
    const lastWeek = deriveWeekMailboxId(onAna.secret, WEEK - 1);
    const after = (mailbox: string): string => String(onAna.cursors?.[mailbox] ?? Number.NaN);
    const before = fake.requests.length;
    await ana.sync.syncOnce();
    const reads = fake.requests.slice(before).map((request) => request.url);
    expect(reads).toEqual([
      `/v1/mailbox/${thisWeek}?after=${after(thisWeek)}&limit=100`,
      `/v1/mailbox/${lastWeek}?after=${after(lastWeek)}&limit=100`,
    ]);
  });

  it('runs push upkeep and then the relay backup’s refresh after the pass’s key change has landed (#97, #99)', async () => {
    const { relay, founding, ana, cal } = await threeMembers();
    await calLeaves(cal, founding);
    const order: string[] = [];
    /** What the store holds for Ana's group as `step` runs: its epoch, and whether a key change is due. */
    const seen = async (step: string): Promise<void> => {
      const group = await ana.group();
      const { rotationDue } = fold(group.log, group.relayNow);
      order.push(`${step} at epoch ${String(group.epoch ?? 0)}${rotationDue ? ', due' : ''}`);
    };
    const push: PushUpkeep = {
      nudge: () => Promise.resolve(),
      upkeep: () => seen('upkeep'),
      forget: () => undefined,
    };
    const sync = createSync({
      store: ana.store,
      relay,
      seal: xchachaSeal,
      clock: () => TS,
      push,
      afterPass: () => seen('afterPass'),
    });
    opened.push(sync);

    expect(await sync.syncOnce()).toBe(true);

    expect(order).toEqual(['upkeep at epoch 1', 'afterPass at epoch 1']);
  });

  it('runs neither push upkeep nor the relay backup’s refresh once halted mid-pass (#78, #97, #99)', async () => {
    const { relay, founding, ana, cal } = await threeMembers();
    await calLeaves(cal, founding);
    const upkeep = vi.fn(() => Promise.resolve());
    const afterPass = vi.fn(() => Promise.resolve());
    let sync: Sync | null = null;
    const push: PushUpkeep = {
      // Erase halts the loop while the pass is still on its groups; halt resolves once the pass ends.
      nudge: () => {
        void sync?.halt();
        return Promise.resolve();
      },
      upkeep,
      forget: () => undefined,
    };
    sync = createSync({ store: ana.store, relay, seal: xchachaSeal, push, afterPass });
    opened.push(sync);

    await sync.syncOnce();

    expect([upkeep.mock.calls.length, afterPass.mock.calls.length]).toEqual([0, 0]);
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
    expect(fake.blobs(deriveWeekMailboxId((await ana.group()).secret, WEEK))).toEqual([]);
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

  it('posts its key change to the outgoing epoch’s mailbox for the week the relay is in (#110)', async () => {
    const { fake, secret, founding, ana, ben, cal } = await threeMembers();
    fake.minute += WEEK_MINUTES;
    for (const device of [ana, ben]) await device.sync.syncOnce();
    await calLeaves(cal, founding);

    await ana.sync.syncOnce();

    const nextWeek = deriveWeekMailboxId(secret, WEEK + 1);
    expect(putsUnder(fake, secret).slice(-2)).toEqual([
      { type: 'leave', mailbox: nextWeek },
      { type: 'key-rotate', mailbox: nextWeek },
    ]);
    expect((await ana.group()).epoch).toBe(1);
  });

  it('ignores a Proposal that reached a later week of the old epoch after its key change, and posts it again to the new epoch (#110)', async () => {
    const { fake, secret, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    await ana.sync.syncOnce();
    expect((await ana.group()).epoch).toBe(1);
    fake.minute += WEEK_MINUTES;
    // Ben hasn't heard of the leave: his pass in the next week posts to the old epoch first.
    const late = signedAs(BEN, {
      type: 'proposal',
      group: founding.id,
      ts: TS,
      body: { atom: `${founding.id}.0`, title: 'Later quiet hours', why: 'Late.', text: '11pm.' },
    });
    await ben.store.enqueue(founding.id, late.record);

    await ben.sync.syncOnce();
    await ana.sync.syncOnce();

    const newSecret = (await ana.group()).secret;
    const proposals = (under: Uint8Array) =>
      putsUnder(fake, under).filter(({ type }) => type === 'proposal');
    expect(proposals(secret)).toEqual([
      { type: 'proposal', mailbox: deriveWeekMailboxId(secret, WEEK + 1) },
    ]);
    expect(proposals(newSecret)).toEqual([
      { type: 'proposal', mailbox: deriveWeekMailboxId(newSecret, WEEK + 1) },
    ]);
    const [a, b] = [await ana.state(), await ben.state()];
    expect(comparable(a)).toEqual(comparable(b));
    expect(a.proposals.map((p) => p.id)).toEqual([late.id]);
    expect(a.proposals[0]?.seq).toBeGreaterThan(a.rotations[0]?.seq ?? Infinity);
  });

  it('sends only key-rotate and leave to the old mailbox while the key change is due', async () => {
    const { fake, relay, secret, founding, ana, ben, cal } = await threeMembers();
    await calLeaves(cal, founding);
    // Ben's device reads the leave, as a pass would, before any key change is posted.
    await ben.store.applyPull(
      founding.id,
      await pullOf(relay, secret, await ben.group()),
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
    await ben.store.applyPull(
      founding.id,
      await pullOf(relay, secret, await ben.group()),
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
    const oldWeeks = [WEEK - 1, WEEK].map((week) => deriveWeekMailboxId(secret, week));
    expect(oldWeeks).toContain(mailboxIn(fake.requests.at(-1)?.url ?? ''));
    // Ben's view is current: nothing to say.
    expect(keyChangeOf(await ben.group(), await ben.state())).toBeNull();
  });

  it('says this device missed the new key when its member had no encryption key yet', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const secret = newGroupSecret();
    const mailbox = deriveWeekMailboxId(secret, WEEK);
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

describe('weekly mailboxes (#110)', () => {
  /** Wednesday 23:59 UTC: the last minute of the fake relay's first week. */
  const LAST_MINUTE = (WEEK + 1) * WEEK_MINUTES - 1;

  /** `keys`' mailbox in relay week `week`. */
  const box = (keys: Pick<Keys, 'secret'>, week: number): string =>
    deriveWeekMailboxId(keys.secret, week);

  /** Each request since `from`, as its method and the mailbox it names. */
  function sentSince(fake: FakeRelay, from: number): string[] {
    return fake.requests
      .slice(from)
      .map((request) => `${request.method} ${mailboxIn(request.url)}`);
  }

  it('GETs first, week 0’s mailbox before the group has a relay minute, then posts to the week the relay’s now falls in', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    await ana.store.enqueue(GROUP, genesis().record);

    await ana.sync.syncOnce();
    const first = sentSince(fake, 0);
    await ana.sync.syncOnce();

    expect(first).toEqual([
      `GET ${box(keys, 0)}`,
      `PUT ${box(keys, WEEK)}`,
      `GET ${box(keys, WEEK - 1)}`,
      `GET ${box(keys, WEEK)}`,
    ]);
    // From then on a pass starts with the week of its last relay minute, then reads last week.
    expect(sentSince(fake, first.length)).toEqual([
      `GET ${box(keys, WEEK)}`,
      `GET ${box(keys, WEEK - 1)}`,
    ]);
    expect(fake.blobs(box(keys, 0))).toEqual([]);
  });

  it('writes to the new id across a week boundary, and every device still folds last week’s events, in seq order', async () => {
    const fake = createFakeRelay({ minute: LAST_MINUTE });
    expect(new Date(LAST_MINUTE * 60_000).toISOString()).toBe('2025-02-19T23:59:00.000Z');
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const [ana, ben, cal] = [
      await device('ana', relay, keys),
      await device('ben', relay, keys),
      await device('cal', relay, keys),
    ];
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();

    fake.minute += 1;
    await ben.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    await ben.sync.syncOnce();
    await cal.sync.syncOnce();
    await ana.sync.syncOnce();
    await ana.store.enqueue(GROUP, proposal(founding, 'Quiet after 11pm.').record);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    await cal.sync.syncOnce();

    expect(puts(fake).map((request) => mailboxIn(request.url))).toEqual([
      box(keys, WEEK),
      box(keys, WEEK + 1),
      box(keys, WEEK + 1),
    ]);
    const states = [await ana.state(), await ben.state(), await cal.state()];
    for (const state of states) expect(state).toEqual(states[0]);
    expect(states[0]?.members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
    expect(states[0]?.proposals).toHaveLength(1);
    const log = (await cal.group()).log;
    expect(labels(log)).toEqual(['genesis:Riverside Tenants', 'join:Ben', 'proposal:']);
    expect(log.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it('reads each missed week once after a 3-week absence, and reaches the state the others hold', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    const dee = await device('dee', relay, keys);
    const founding = genesis();
    await ana.store.enqueue(GROUP, founding.record);
    await ana.sync.syncOnce();
    await dee.sync.syncOnce();
    for (const week of [1, 2, 3]) {
      fake.minute += WEEK_MINUTES;
      await ana.store.enqueue(GROUP, proposal(founding, `Week ${String(week)}.`).record);
      await ana.sync.syncOnce();
    }
    const before = fake.requests.length;

    expect(await dee.sync.syncOnce()).toBe(true);

    expect(sentSince(fake, before)).toEqual(
      [WEEK, WEEK + 1, WEEK + 2, WEEK + 3].map((week) => `GET ${box(keys, week)}`),
    );
    expect(await dee.state()).toEqual(await ana.state());
    expect((await dee.group()).log.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
  });

  it('posts only to the current week from a device whose last relay minute is 2 weeks old, after a GET', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ben = await device('ben', relay, keys);
    const founding = genesis();
    await ben.store.enqueue(GROUP, founding.record);
    await ben.sync.syncOnce();
    fake.minute += 2 * WEEK_MINUTES;
    await ben.store.enqueue(GROUP, join(founding, BEN, 'Ben').record);
    const before = fake.requests.length;

    await ben.sync.syncOnce();

    expect(sentSince(fake, before)).toEqual([
      `GET ${box(keys, WEEK)}`,
      `PUT ${box(keys, WEEK + 2)}`,
      `GET ${box(keys, WEEK + 1)}`,
      `GET ${box(keys, WEEK + 2)}`,
    ]);
    expect(fake.blobs(box(keys, WEEK + 1))).toEqual([]);
    expect((await ben.state()).members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
  });

  it('writes to exactly one id per group per week over 4 weeks, and no id comes back in another week', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const other = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    const signingKey = testKeys(ANA).secretKey;
    const me = { author: authorOf(ANA), name: 'Ana' };
    await ana.store.addGroup({ groupId: 'other', secret: other.secret, signingKey, me });
    const ours = genesis();
    const body = {
      name: 'Allotment',
      founder: 'Ana',
      title: 'Plot rules',
      atoms: ['Share tools.'],
      kx: testKx(ANA).kx,
    };
    const theirs = signedAs(ANA, { type: 'genesis', group: '', ts: TS, body });
    const writes: string[][] = [];

    for (const week of [0, 1, 2, 3]) {
      const before = puts(fake).length;
      for (const [groupId, founding] of [
        [GROUP, ours],
        ['other', theirs],
      ] as const) {
        if (week === 0) await ana.store.enqueue(groupId, founding.record);
        await ana.store.enqueue(groupId, proposal(founding, `Week ${String(week)}.`).record);
      }
      await ana.sync.syncOnce();
      writes.push(
        puts(fake)
          .slice(before)
          .map((request) => mailboxIn(request.url)),
      );
      fake.minute += WEEK_MINUTES;
    }

    for (const [week, ids] of writes.entries()) {
      expect(new Set(ids)).toEqual(new Set([box(keys, WEEK + week), box(other, WEEK + week)]));
    }
    expect(writes.map((ids) => ids.length)).toEqual([4, 2, 2, 2]);
    expect(new Set(writes.flat()).size).toBe(8);
  });

  it('keeps a cursor for each mailbox it read in the last 5 weeks, and drops older ones', async () => {
    const fake = createFakeRelay();
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: fake.fetch }), keys);
    await ana.store.enqueue(GROUP, genesis().record);
    await ana.sync.syncOnce();
    for (let week = 1; week <= 6; week += 1) {
      fake.minute += WEEK_MINUTES;
      await ana.sync.syncOnce();
    }

    const kept = Object.keys((await ana.group()).cursors ?? {}).sort();

    expect(kept).toEqual([2, 3, 4, 5, 6].map((week) => box(keys, WEEK + week)).sort());
  });

  it('still reads a record that reached last week’s mailbox after this device read it, and folds it in seq order', async () => {
    const fake = createFakeRelay({ minute: LAST_MINUTE });
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const [lastWeek, thisWeek] = [box(keys, WEEK), box(keys, WEEK + 1)];
    const founding = genesis();
    let race = false;
    // A device whose GET said last week posts Cy's join there just after Ben reads it, then Di joins this week.
    const racing: Fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (race && typeof input === 'string' && input.startsWith(`/v1/mailbox/${lastWeek}?`)) {
        race = false;
        await relay.putBlob(
          lastWeek,
          sealedFor({ ...keys, mailbox: lastWeek }, join(founding, 'cy', 'Cy').record),
        );
        await relay.putBlob(
          thisWeek,
          sealedFor({ ...keys, mailbox: thisWeek }, join(founding, 'di', 'Di').record),
        );
      }
      return response;
    };
    const ana = await device('ana', relay, keys);
    const ben = await device('ben', createRelay({ fetch: racing }), keys);
    await ana.store.enqueue(GROUP, founding.record);
    await ana.sync.syncOnce();
    await ben.sync.syncOnce();
    fake.minute += 1;
    race = true;

    await ben.sync.syncOnce();
    const missed = labels((await ben.group()).log);
    await ben.sync.syncOnce();
    const cal = await device('cal', relay, keys);
    await cal.sync.syncOnce();

    expect(missed).toEqual(['genesis:Riverside Tenants', 'join:Di']);
    const log = (await ben.group()).log;
    expect(labels(log)).toEqual(['genesis:Riverside Tenants', 'join:Cy', 'join:Di']);
    expect(log.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(await ben.state()).toEqual(await cal.state());
  });

  it('hands the store one pull with every week’s records merged in seq order', async () => {
    const fake = createFakeRelay({ minute: LAST_MINUTE });
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const founding = genesis();
    const ben = await device('ben', relay, keys);
    await relay.putBlob(box(keys, WEEK), sealedFor(keys, founding.record));
    await ben.sync.syncOnce();
    fake.minute += 1;
    const thisWeek = { ...keys, mailbox: box(keys, WEEK + 1) };
    await relay.putBlob(thisWeek.mailbox, sealedFor(thisWeek, join(founding, 'di', 'Di').record));
    // A device whose GET said last week posts after Di did: a higher seq, in last week's mailbox.
    await relay.putBlob(keys.mailbox, sealedFor(keys, join(founding, 'cy', 'Cy').record));
    const applyPull = vi.spyOn(ben.store, 'applyPull');

    await ben.sync.syncOnce();

    const [, pulled] = applyPull.mock.calls[0] ?? [];
    expect(pulled?.records.map((record) => record.seq)).toEqual([2, 3]);
    expect(labels(pulled?.records ?? [])).toEqual(['join:Di', 'join:Cy']);
  });

  it('stands at the earliest of its GETs’ nows, so no record a GET left out arrived before it', async () => {
    const fake = createFakeRelay();
    const ticking: Fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      fake.minute += 1;
      return response;
    };
    const ana = await device('ana', createRelay({ fetch: ticking }), newKeys());
    await ana.store.enqueue(GROUP, genesis().record);
    await ana.sync.syncOnce();
    const start = fake.minute;

    await ana.sync.syncOnce();

    expect((await ana.group()).relayNow).toBe(start);
  });

  it('fails a pass in which the relay changes instance after its first GET, and the next reads it from the start', async () => {
    const fake = createFakeRelay();
    let restartAfterFirst = false;
    const restarting: Fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (restartAfterFirst) {
        restartAfterFirst = false;
        fake.restart({ keep: true });
      }
      return response;
    };
    const keys = newKeys();
    const ana = await device('ana', createRelay({ fetch: restarting }), keys);
    await ana.store.enqueue(GROUP, genesis().record);
    await ana.sync.syncOnce();
    restartAfterFirst = true;

    expect(await ana.sync.syncOnce()).toBe(false);
    expect(await ana.sync.syncOnce()).toBe(true);

    const group = await ana.group();
    expect(group.instance).toBe(fake.instance);
    expect(group.log.map((record) => record.seq)).toEqual([1]);
  });

  it('finds every record once, in seq order, however the weeks turn between one device’s posts and another’s reads', async () => {
    let run = 0;
    const step = fc.record({
      gap: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 10 * 1440 })),
      posts: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        run += 1;
        const fake = createFakeRelay({ minute: LAST_MINUTE - 1 });
        const relay = createRelay({ fetch: fake.fetch });
        const keys = newKeys();
        const ana = await device(`ana-${String(run)}`, relay, keys);
        const ben = await device(`ben-${String(run)}`, relay, keys);
        const founding = genesis();
        await ana.store.enqueue(GROUP, founding.record);
        await ana.sync.syncOnce();
        // Ben joins as an invite would have him: in sync with the group at first.
        await ben.sync.syncOnce();
        let elapsed = 0;
        for (const [i, { gap, posts }] of steps.entries()) {
          // Within the relay's 30 days, so nothing expires before Ben reads it.
          const move = elapsed + gap <= 28 * 1440 ? gap : 0;
          elapsed += move;
          fake.minute += move;
          if (posts)
            await ana.store.enqueue(GROUP, proposal(founding, `Step ${String(i)}.`).record);
          await (posts ? ana : ben).sync.syncOnce();
        }
        await ana.sync.syncOnce();
        await ben.sync.syncOnce();

        const [ours, theirs] = [(await ana.group()).log, (await ben.group()).log];
        expect(theirs.map((record) => record.seq)).toEqual(ours.map((record) => record.seq));
        expect(theirs.map((record) => record.seq)).toEqual(
          [...new Set(theirs.map((record) => record.seq))].sort((a, b) => a - b),
        );
        expect(labels(theirs)).toEqual(labels(ours));
        ana.sync.stop();
        ben.sync.stop();
      }),
      { numRuns: 15 },
    );
  });
});
describe('the result duty (#111)', () => {
  /** Ana's group of Ana and Ben, with a Proposal both have scored, closing it early in this minute. */
  async function closedEarly() {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const keys = newKeys();
    const ana = await device('ana', relay, keys);
    const founding = genesis();
    const quietLater = proposal(founding, 'Quiet after 11pm.');
    await ana.store.enqueueAll(GROUP, [
      founding.record,
      join(founding, BEN, 'Ben').record,
      quietLater.record,
    ]);
    await ana.sync.syncOnce();
    fake.minute += 1;
    await ana.store.enqueueAll(GROUP, [
      vote(founding, ANA, quietLater, 3).record,
      vote(founding, BEN, quietLater, 4).record,
    ]);
    await ana.sync.syncOnce();
    return { fake, keys, ana, founding, quietLater };
  }

  /** The event type each PUT since request `from` carried, opened for the mailbox it went to. */
  function putTypes(fake: FakeRelay, keys: Keys, from: number): string[] {
    return fake.requests
      .slice(from)
      .filter((request) => request.method === 'PUT')
      .map((request) => {
        const bytes = open(mailboxIn(request.url), keys.key, request.body ?? new Uint8Array());
        return parseRecord(bytes ?? new Uint8Array())?.event.type ?? '?';
      });
  }

  it('queues nothing in the close’s own minute', async () => {
    const { fake, keys, ana } = await closedEarly();
    const from = fake.requests.length;
    await ana.sync.syncOnce();
    await ana.sync.syncOnce();
    expect(putTypes(fake, keys, from)).toEqual([]);
    expect((await ana.group()).outbox).toEqual([]);
    expect((await ana.state()).proposals[0]).toMatchObject({ final: true, result: null });
  });

  it('a minute later, syncs once more, queues one result, and posts it on the next pass, which the fold takes', async () => {
    const { fake, keys, ana, quietLater } = await closedEarly();
    fake.minute += 1;
    const from = fake.requests.length;

    await ana.sync.syncOnce();
    expect((await ana.group()).outbox).toEqual([]);
    await ana.sync.syncOnce();
    expect(types((await ana.group()).outbox.map((bytes) => ({ bytes })))).toEqual(['result']);
    expect(putTypes(fake, keys, from)).toEqual([]);
    await ana.sync.syncOnce();

    expect(putTypes(fake, keys, from)).toEqual(['result']);
    const [decided] = (await ana.state()).proposals;
    expect(decided?.result).toMatchObject({ author: authorOf(ANA), closedAt: fake.minute - 1 });
    expect(decided?.id).toBe(quietLater.id);
    expect(types((await ana.group()).log)).toEqual([
      'genesis',
      'join',
      'proposal',
      'vote',
      'vote',
      'result',
    ]);
    expect((await ana.group()).outbox).toEqual([]);
  });

  it('queues none when another member’s result turns up on the pass after it found none', async () => {
    const { fake, keys, ana, founding, quietLater } = await closedEarly();
    fake.minute += 1;
    const from = fake.requests.length;
    await ana.sync.syncOnce();
    const bens = signedAs(BEN, {
      type: 'result',
      group: founding.id,
      ts: TS,
      body: heldResultOf(await ana.state(), quietLater.id),
    });
    const direct = createRelay({ fetch: fake.fetch });
    await direct.putBlob(keys.mailbox, sealedFor(keys, bens.record), 30);

    await ana.sync.syncOnce();
    await ana.sync.syncOnce();

    expect(putTypes(fake, keys, from)).toEqual(['result']);
    expect((await ana.group()).outbox).toEqual([]);
    expect((await ana.state()).proposals[0]?.result?.author).toBe(authorOf(BEN));
  });

  it('queues none from a device whose key isn’t a member of the group', async () => {
    const { fake, keys } = await closedEarly();
    const kim = await device('kim', createRelay({ fetch: fake.fetch }), keys);
    fake.minute += 1;
    const from = fake.requests.length;
    for (let pass = 0; pass < 3; pass += 1) await kim.sync.syncOnce();
    fake.minute += 1;
    await kim.sync.syncOnce();
    expect(putTypes(fake, keys, from)).toEqual([]);
    expect((await kim.group()).outbox).toEqual([]);
  });

  it('owes nothing more once the result is in, as relay time moves on', async () => {
    const { fake, keys, ana } = await closedEarly();
    fake.minute += 1;
    for (let pass = 0; pass < 3; pass += 1) await ana.sync.syncOnce();
    const from = fake.requests.length;
    await ana.sync.syncOnce();
    fake.minute += 1;
    await ana.sync.syncOnce();
    await ana.sync.syncOnce();
    expect(putTypes(fake, keys, from)).toEqual([]);
    expect((await ana.group()).outbox).toEqual([]);
  });

  /** One way the group goes from `holder`'s device (#270), whose member there is `name`. */
  type Goes = (holder: Device, founding: SignedEvent, name: string) => Promise<void>;

  const WAYS: [string, Goes][] = [
    [
      'leaves it',
      async (holder, founding, name) => {
        const leave = signedAs(name, { type: 'leave', group: founding.id, ts: TS, body: {} });
        await holder.store.markLeaving(GROUP, leave.record);
        // The pass that posts the leave purges the group (#77).
        await holder.sync.syncOnce();
        expect(await holder.store.getGroup(GROUP)).toBeUndefined();
      },
    ],
    ['is removed', (holder) => holder.store.purgeGroup(GROUP)],
    ['dissolves', (holder) => holder.store.markArchived(GROUP, 'dissolved')],
  ];

  /**
   * The group goes from `holder`'s device in `goes`, a pass runs, and the
   * device then holds it again under Ben's keys, as linking his phone would
   * (#96), in the same relay minute: the event type each PUT carried from
   * when it went until then, and the device's outbox after each of the next
   * two passes.
   */
  async function goesAndComesBack(
    { fake, keys, founding }: Awaited<ReturnType<typeof closedEarly>>,
    holder: Device,
    goes: Goes,
    name: string,
  ) {
    const from = fake.requests.length;
    await goes(holder, founding, name);
    await holder.sync.syncOnce();
    const whileGone = putTypes(fake, keys, from);
    // Remove from this device (#108): a dissolved group's archive goes before it can come back.
    await holder.store.purgeGroup(GROUP);
    const me = { author: authorOf(BEN), name: 'Ben' };
    const { secretKey: signingKey } = testKeys(BEN);
    const { kxKey } = testKx(BEN);
    await holder.store.addGroup({ groupId: GROUP, secret: keys.secret, signingKey, kxKey, me });
    const outboxes: string[][] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      await holder.sync.syncOnce();
      outboxes.push(types((await holder.group()).outbox.map((bytes) => ({ bytes }))));
    }
    return { whileGone, outboxes };
  }

  it.each(WAYS)(
    'forgets the result it found due once the group %s, so none comes due at once when it is back (#270)',
    async (_label, goes) => {
      const held = await closedEarly();
      const { fake, ana } = held;
      fake.minute += 1;
      await ana.sync.syncOnce();
      // Found due, to queue on the next pass if it still is.
      expect((await ana.group()).outbox).toEqual([]);

      const { whileGone, outboxes } = await goesAndComesBack(held, ana, goes, ANA);

      expect(whileGone).not.toContain('result');
      // Queued only once the device has synced once more since it found the result due as Ben.
      expect(outboxes).toEqual([[], ['result']]);
    },
  );

  it.each(WAYS)(
    'forgets the minute it settled once the group %s, so the duty runs in that minute when it is back (#270)',
    async (_label, goes) => {
      const held = await closedEarly();
      const { fake, keys } = held;
      // Kim's key isn't a member, so Kim's device settles this minute owing nothing.
      const kim = await device('kim', createRelay({ fetch: fake.fetch }), keys);
      fake.minute += 1;
      await kim.sync.syncOnce();
      expect((await kim.group()).outbox).toEqual([]);

      const { whileGone, outboxes } = await goesAndComesBack(held, kim, goes, 'kim');

      expect(whileGone).not.toContain('result');
      expect(outboxes).toEqual([[], ['result']]);
    },
  );
});

/** Each signed record's event type, in order. */
function types(records: readonly { readonly bytes: Uint8Array }[]): string[] {
  return records.map((record) => parseRecord(record.bytes)?.event.type ?? '?');
}

/** The result a device holding the ballots would post for `proposalId`. */
function heldResultOf(state: GroupState, proposalId: string) {
  const found = state.proposals.find((candidate) => candidate.id === proposalId);
  if (found === undefined) throw new Error('Expected the Proposal.');
  return resultFor(found);
}
