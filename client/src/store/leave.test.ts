/**
 * Leave on this device (#77; docs/spec/phase-1-spec.md §9, Local data): the
 * leave waits in the outbox, survives a reload while the relay can't be
 * reached, and only once the relay has returned a seq for it does the group
 * go, every record of it, from every object store, leaving other groups as
 * they were.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import { open, xchachaSeal } from '../crypto/seal';
import { parseRecord, type SignedEvent } from '../engine/event';
import { createRelay, type Relay } from '../net/relay';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { containsBytes, scanDb as scan } from '../test/scanDb';
import { signedAs, testKeys } from '../test/keys';
import { openStore, type Store } from './db';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const DB = 'leave-device';
const TS = 1_762_650_000_000;
/** A name only the group that leaves uses, so a scan can find any trace of it. */
const CANARY = 'Canary Lane Tenants';
const CANARY_DRAFT = 'Canary draft: quiet after midnight.';
const opened: Sync[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/** Ana's genesis of a group called `name`, with its own secret and the mailbox it derives. */
function founding(name: string, fill: number) {
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: { name, founder: 'Ana', title: `${name} rules`, atoms: [`${name}: be kind.`] },
  });
  const secret = new Uint8Array(32).fill(fill);
  return { genesis, secret, mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) };
}

type Founded = ReturnType<typeof founding>;

/** Ana's `type` event in the group `genesis` founded. */
function anaSays(genesis: SignedEvent, event: 'leave' | 'proposal'): SignedEvent {
  return event === 'leave'
    ? signedAs('ana', { type: 'leave', group: genesis.id, ts: TS + 2, body: {} })
    : signedAs('ana', {
        type: 'proposal',
        group: genesis.id,
        ts: TS + 1,
        body: { atom: `${genesis.id}.0`, title: 'Kinder', why: 'Because.', text: 'Be kinder.' },
      });
}

async function openDevice(relay: Relay): Promise<{ store: Store; sync: Sync }> {
  const store = await openStore(DB);
  stores.push(store);
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
  opened.push(sync);
  return { store, sync };
}

/** Keeps `group` on the device under Ana's key, with its genesis synced. */
async function keep(store: Store, sync: Sync, group: Founded): Promise<void> {
  const { secretKey, author } = testKeys('ana');
  await store.addGroup({
    groupId: group.genesis.id,
    secret: group.secret,
    signingKey: secretKey,
    me: { author, name: 'Ana' },
  });
  await store.enqueue(group.genesis.id, group.genesis.record);
  await sync.syncOnce();
}

/** The type of each event the relay holds for `group`, opened from its blobs. */
function onRelay(fake: FakeRelay, group: Founded): string[] {
  return fake
    .blobs(group.mailbox)
    .map((blob) => open(group.mailbox, group.key, blob))
    .map((bytes) => (bytes === null ? '?' : (parseRecord(bytes)?.event.type ?? '?')));
}

describe('leaving a group on this device', () => {
  it('deletes every record of the group once the relay has the leave, and keeps the other group', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await openDevice(createRelay({ fetch: fake.fetch }));
    const leaving = founding(CANARY, 3);
    const staying = founding('Riverside Tenants', 4);
    await keep(store, sync, leaving);
    await keep(store, sync, staying);
    const groupId = leaving.genesis.id;
    // Something of every kind the device keeps: a draft, a queued Proposal, and the leave.
    const draft = { title: 'Canary', why: '', text: CANARY_DRAFT, link: '' };
    await store.writeDraft(groupId, `${groupId}.0`, draft);
    await store.enqueue(groupId, anaSays(leaving.genesis, 'proposal').record);
    await store.markLeaving(groupId, anaSays(leaving.genesis, 'leave').record);
    const before = await scan(DB);
    expect(before.text).toContain(groupId);
    expect(before.text).toContain(CANARY);
    expect(before.text).toContain(CANARY_DRAFT);
    expect(containsBytes(before.bytes, leaving.secret)).toBe(true);
    const otherBefore = await store.getGroup(staying.genesis.id);

    expect(await sync.syncOnce()).toBe(true);

    expect(onRelay(fake, leaving)).toEqual(['genesis', 'proposal', 'leave']);
    expect(await store.getGroup(groupId)).toBeUndefined();
    const after = await scan(DB);
    expect(after.text).not.toContain(groupId);
    expect(after.text).not.toContain(CANARY);
    expect(after.text).not.toContain(CANARY_DRAFT);
    expect(after.text).not.toContain(leaving.mailbox);
    expect(containsBytes(after.bytes, leaving.secret)).toBe(false);
    expect(containsBytes(after.bytes, leaving.genesis.record)).toBe(false);
    expect(await store.listGroups()).toEqual([otherBefore]);
    expect(after.text).toContain(staying.genesis.id);
  });

  it('stays, leaving, through a reload while the relay can’t be reached, and goes on a later sync', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const first = await openDevice(relay);
    const group = founding(CANARY, 3);
    await keep(first.store, first.sync, group);
    fake.offline = true;

    await first.store.markLeaving(group.genesis.id, anaSays(group.genesis, 'leave').record);
    expect(await first.sync.syncOnce()).toBe(false);
    expect((await first.store.getGroup(group.genesis.id))?.leaving).toBeDefined();
    first.sync.stop();
    first.store.close();

    // The reload: a new store on the same database.
    const second = await openDevice(relay);
    expect((await second.store.getGroup(group.genesis.id))?.leaving).toBeDefined();
    expect(await second.sync.syncOnce()).toBe(false);
    expect(await second.store.getGroup(group.genesis.id)).toBeDefined();
    expect(onRelay(fake, group)).toEqual(['genesis']);

    fake.offline = false;
    expect(await second.sync.syncOnce()).toBe(true);
    expect(onRelay(fake, group)).toEqual(['genesis', 'leave']);
    expect(await second.store.listGroups()).toEqual([]);
  });

  it('keeps the group while the relay refuses the leave, and reads nothing more once it accepts it', async () => {
    const fake = createFakeRelay();
    let refuse = true;
    const relay = createRelay({
      fetch: (input, init) =>
        refuse && init?.method === 'PUT'
          ? Promise.resolve(Response.json({ error: 'server_error' }, { status: 503 }))
          : fake.fetch(input, init),
    });
    const { store, sync } = await openDevice(createRelay({ fetch: fake.fetch }));
    const group = founding(CANARY, 3);
    await keep(store, sync, group);
    const refusing = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
    opened.push(refusing);
    await store.markLeaving(group.genesis.id, anaSays(group.genesis, 'leave').record);

    expect(await refusing.syncOnce()).toBe(false);
    expect((await store.getGroup(group.genesis.id))?.outbox).toHaveLength(1);

    refuse = false;
    const requests = fake.requests.length;
    expect(await refusing.syncOnce()).toBe(true);
    expect(refusing.isReachable()).toBe(true);
    expect(fake.requests.slice(requests).map((request) => request.method)).toEqual(['PUT']);
    expect(await store.getGroup(group.genesis.id)).toBeUndefined();
  });
});
