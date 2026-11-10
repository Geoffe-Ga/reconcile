/**
 * A removal on this device (#115; docs/spec/phase-1-spec.md §7, Removal),
 * through fake-indexeddb, the fake relay and the real sync loop.
 *
 * The device that folds a removal's final pass posts one `remove`, and the
 * key change follows it, wrapped to everyone but the person removed (#98).
 * The removed member's own device archives the group once the `remove`
 * folds: its outbox goes, its push registration is forgotten (#99), and no
 * request names the mailbox again. A file holding such a log comes back
 * read-only.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { sealBackup } from '../crypto/backup';
import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { parseRecord, type Score, type SignedEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { createRelay, type Fetch } from '../net/relay';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { shownState } from './archive';
import { type BackedUpGroup, type Group, openStore, type Store } from './db';
import type { PushUpkeep } from './push';
import { settleRemoval } from './removal';
import { encodeSnapshot, importGroups } from './snapshot';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const DB = 'removal-device';
const TS = 1_762_650_000_000;
const START = 29_000_000;
const opened: Sync[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/** Ana's genesis with her encryption key, the group secret, and the mailbox and key it derives. */
function founding() {
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      title: 'House rules',
      atoms: ['Quiet after 11pm.'],
      kx: testKx('ana').kx,
    },
  });
  const secret = new Uint8Array(32).fill(9);
  return { genesis, secret, mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) };
}

type Founded = ReturnType<typeof founding>;

/** Ben and Cal join with encryption keys, Ana proposes removing Cal, and Ana scores it 4. */
function history(group: Founded) {
  const draft = { group: group.genesis.id, ts: TS };
  const joins = (['ben', 'cal'] as const).map((name) =>
    signedAs(name, {
      ...draft,
      type: 'join',
      body: { name: name === 'ben' ? 'Ben' : 'Cal', kx: testKx(name).kx },
    }),
  );
  const removal = signedAs('ana', {
    ...draft,
    type: 'proposal',
    body: {
      target: { kind: 'remove', member: authorOf('cal') },
      title: 'Remove Cal',
      why: 'He keeps breaking the house rules.',
    },
  });
  const vote = (name: string, score: Score) =>
    signedAs(name, {
      ...draft,
      type: 'vote',
      body: { proposal: removal.id, scores: { [removal.id]: score } },
    });
  const remove = (name: string) =>
    signedAs(name, { ...draft, type: 'remove', body: { proposal: removal.id } });
  return { events: [...joins, removal, vote('ana', 4)], removal, last: vote('ben', 4), remove };
}

/** A device for `name`, on the fake relay, with `push` as its push upkeep if given. */
async function openDevice(fetch: Fetch, push?: PushUpkeep) {
  const store = await openStore(DB);
  stores.push(store);
  const sync = createSync({
    store,
    relay: createRelay({ fetch }),
    seal: xchachaSeal,
    clock: () => TS,
    ...(push === undefined ? {} : { push }),
  });
  opened.push(sync);
  return { store, sync };
}

/** Keeps the group on `name`'s device and sends `events` from it, genesis first. */
async function keep(
  device: { store: Store; sync: Sync },
  group: Founded,
  name: 'ana' | 'cal',
  events: readonly SignedEvent[],
) {
  const { secretKey, author } = testKeys(name);
  const groupId = group.genesis.id;
  await device.store.addGroup({
    groupId,
    secret: group.secret,
    signingKey: secretKey,
    kxKey: testKx(name).kxKey,
    me: { author, name: name === 'ana' ? 'Ana' : 'Cal' },
  });
  await device.store.enqueueAll(groupId, [group.genesis.record, ...events.map((e) => e.record)]);
  expect(await device.sync.syncOnce()).toBe(true);
}

/** The events in the group's outbox. */
async function outboxOf(store: Store, groupId: string) {
  const group = await store.getGroup(groupId);
  return (group?.outbox ?? []).map((bytes) => parseRecord(bytes)?.event);
}

function never(): never {
  throw new Error('expected a group');
}

/** How many requests named `mailbox`. */
function mailboxRequests(fake: FakeRelay, mailbox: string): number {
  return fake.requests.filter((request) => request.url.includes(mailbox)).length;
}

describe('removing a member on this device (#115)', () => {
  it('posts one remove once the pass is final, and then the key change, wrapped to Ana and Ben only', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, removal, last } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'ana', events);
    expect(await outboxOf(device.store, groupId)).toEqual([]);

    await device.store.enqueue(groupId, last.record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);
    const queued = await outboxOf(device.store, groupId);
    expect(queued.map((event) => [event?.type, event?.author, event?.body])).toEqual([
      ['remove', authorOf('ana'), { proposal: removal.id }],
    ]);
    // Settling again queues no second remove.
    await settleRemoval(device.store, groupId, () => TS);
    expect(await outboxOf(device.store, groupId)).toHaveLength(1);

    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);
    const held = (await device.store.getGroup(groupId)) ?? never();
    const state = fold(held.log, held.relayNow);
    expect(state.former.map((m) => m.author)).toEqual([authorOf('cal')]);
    expect(state.epoch).toBe(1);
    expect(Object.keys(state.rotations[0]?.wraps ?? {}).sort()).toEqual(
      [authorOf('ana'), authorOf('ben')].sort(),
    );
    expect(held.epoch).toBe(1);
    expect(held.secret).not.toEqual(group.secret);
  });

  it('archives the removed member’s device once the remove folds, forgetting its push first, and sends nothing after', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const forgot: Group[] = [];
    const push: PushUpkeep = {
      nudge: () => Promise.resolve(),
      upkeep: () => Promise.resolve(),
      forget: (held) => forgot.push(held),
    };
    const device = await openDevice(fake.fetch, push);
    await keep(device, group, 'cal', [...events, last]);
    // Cal's own device never posts the remove of him.
    expect(await outboxOf(device.store, groupId)).toEqual([]);
    expect((await device.store.getGroup(groupId))?.archived).toBeUndefined();

    await device.store.enqueue(groupId, remove('ben').record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);

    const held = (await device.store.getGroup(groupId)) ?? never();
    expect(held.archived).toEqual({ reason: 'removed' });
    expect(held.outbox).toEqual([]);
    expect(forgot.map((g) => g.groupId)).toEqual([groupId]);
    expect(shownState(held).former.map((m) => m.author)).toEqual([authorOf('cal')]);
    const requests = mailboxRequests(fake, group.mailbox);
    fake.minute += 5;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(mailboxRequests(fake, group.mailbox)).toBe(requests);
    await expect(device.store.enqueue(groupId, last.record)).rejects.toThrow('read-only');
  });

  it('queues no remove while this member is leaving, and leaves an archive or a missing group alone', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'ana', events);
    const leave = signedAs('ana', { type: 'leave', group: groupId, ts: TS, body: {} });
    // The pass lands while the leave waits, so the outbox holds only the leave.
    await device.store.enqueue(groupId, last.record);
    await device.sync.syncOnce();
    const outbox = (await device.store.getGroup(groupId))?.outbox ?? [];
    await device.store.markSent(groupId, outbox[0] ?? new Uint8Array());
    await device.store.markLeaving(groupId, leave.record);
    await settleRemoval(device.store, groupId, () => TS);
    expect((await outboxOf(device.store, groupId)).map((e) => e?.type)).toEqual(['leave']);

    await settleRemoval(device.store, 'no-such-group', () => TS);
    await device.store.markArchived(groupId, 'dissolved');
    await settleRemoval(device.store, groupId, () => TS);
    expect((await device.store.getGroup(groupId))?.archived).toEqual({ reason: 'dissolved' });
  });

  it('queues no remove from a suspended member’s device', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last } = history(group);
    // Ana, the founding steward, suspends Ben before the vote closes; his device holds the pass.
    const suspend = signedAs('ana', {
      type: 'suspend',
      group: groupId,
      ts: TS,
      body: { member: authorOf('ben') },
    });
    const device = await openDevice(fake.fetch);
    const { secretKey, author } = testKeys('ben');
    await device.store.addGroup({
      groupId,
      secret: group.secret,
      signingKey: secretKey,
      kxKey: testKx('ben').kxKey,
      me: { author, name: 'Ben' },
    });
    const records = [group.genesis, ...events, last, suspend].map((e) => e.record);
    await device.store.enqueueAll(groupId, records);
    expect(await device.sync.syncOnce()).toBe(true);
    expect(await outboxOf(device.store, groupId)).toEqual([]);
  });
});

describe('a removed member’s group and backup files (#78)', () => {
  it('brings a file’s group whose log holds this member’s remove back read-only, so it never syncs', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'cal', [...events, last, remove('ben')]);
    const held = (await device.store.getGroup(groupId)) ?? never();
    expect(held.archived).toEqual({ reason: 'removed' });
    const { secret, signingKey, me, log, cursor, relayNow, instance, lastSyncAt } = held;
    const copy: BackedUpGroup = {
      groupId,
      secret,
      signingKey,
      me,
      log,
      cursor,
      relayNow,
      instance,
      lastSyncAt,
      missingHistory: false,
    };
    const file = await sealBackup(
      encodeSnapshot({ groups: [copy], personal: [] }),
      'a long walk',
      4,
    );
    const other = await openStore('removal-restored');
    stores.push(other);
    const sync = createSync({
      store: other,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      clock: () => TS,
    });
    opened.push(sync);

    expect(await importGroups(other, file, 'a long walk')).toBe(1);

    const restored = (await other.getGroup(groupId)) ?? never();
    expect(restored.archived).toEqual({ reason: 'removed' });
    const requests = mailboxRequests(fake, group.mailbox);
    expect(await sync.syncOnce()).toBe(true);
    expect(mailboxRequests(fake, group.mailbox)).toBe(requests);
  });
});

describe('settleRemoval with no push upkeep', () => {
  it('archives the removed member’s group from its log alone, with nothing to forget', async () => {
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const store = await openStore(DB);
    stores.push(store);
    const { secretKey, author } = testKeys('cal');
    await store.addGroup({
      groupId,
      secret: group.secret,
      signingKey: secretKey,
      me: { author, name: 'Cal' },
    });
    const records = [group.genesis, ...events, last, remove('ben')].map((event, i) => ({
      seq: i + 1,
      received: START,
      bytes: event.record,
    }));
    const pull = {
      records,
      cursor: records.length,
      relayNow: START,
      instance: 'i',
      lastSyncAt: TS,
    };
    await store.applyPull(groupId, pull, (bytes) => parseRecord(bytes)?.id ?? null);

    await settleRemoval(store, groupId, () => TS);

    expect((await store.getGroup(groupId))?.archived).toEqual({ reason: 'removed' });
  });
});
