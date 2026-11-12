/**
 * A removal on this device (#115; docs/spec/phase-1-spec.md §7, Removal),
 * through fake-indexeddb, the fake relay and the real sync loop.
 *
 * The device that folds a removal's final pass posts one `remove`, and the
 * key change follows it, wrapped to everyone but the person removed (#98).
 * The removed member's own device archives the group once the `remove`
 * folds: its outbox goes, its push registration is forgotten (#99), and no
 * request names any of its weekly mailboxes again (#110). A file holding such a log comes back
 * read-only.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { sealBackup } from '../crypto/backup';
import { deriveCoalitionEntryId } from '../crypto/card';
import { deriveSealKey, deriveWeekMailboxId, WEEK_MINUTES, weekOf } from '../crypto/groupKeys';
import { open, xchachaSeal } from '../crypto/seal';
import { parseRecord, type Score, type SignedEvent } from '../engine/event';
import { resultFor } from '../engine/expiry';
import { fold } from '../engine/fold';
import { removedClearMinute } from '../engine/removal';
import { DAY_MINUTES } from '../engine/rules';
import { newSigningKeys } from '../crypto/sign';
import { createRelay, type Fetch } from '../net/relay';
import { COALITION_STATEMENT, seatSecret, testSecret } from '../test/coalitions';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { relayTook } from '../test/outbox';
import { MINUTE_MS, shownState, sweepArchives } from './archive';
import { type BackedUpGroup, type Group, openStore, type Store } from './db';
import { foldGroup } from './expiry';
import type { PushUpkeep } from './push';
import { fetchRelayBackup, startRelayBackup } from './relayBackup';
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
      documents: [{ title: 'House rules', atoms: ['Quiet after 11pm.'] }],
      kx: testKx('ana').kx,
    },
  });
  const secret = new Uint8Array(32).fill(9);
  // The fake relay's first week, which these tests stay in (#110).
  const mailbox = deriveWeekMailboxId(secret, weekOf(START));
  return { genesis, secret, mailbox, key: deriveSealKey(secret) };
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

/** The mailbox id a relay request names, or '' for none. */
function mailboxIn(url: string): string {
  return /\/v1\/mailbox\/([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? '';
}

/** The ids `secret` gives its mailboxes, from five weeks before START's to the week after (#110). */
function weeksOf(secret: Uint8Array): string[] {
  const week = weekOf(START);
  return [-5, -4, -3, -2, -1, 0, 1].map((offset) => deriveWeekMailboxId(secret, week + offset));
}

/** How many requests named any of `secret`'s weekly mailboxes. */
function groupRequests(fake: FakeRelay, secret: Uint8Array): number {
  const ids = weeksOf(secret);
  return fake.requests.filter((request) => ids.includes(mailboxIn(request.url))).length;
}

/** The type and mailbox of each PUT the fake relay took that opens under `secret`'s key, oldest first. */
function putsUnder(fake: FakeRelay, secret: Uint8Array): { type: string; mailbox: string }[] {
  const key = deriveSealKey(secret);
  return fake.requests.flatMap((request) => {
    if (request.method !== 'PUT') return [];
    const mailbox = mailboxIn(request.url);
    const bytes = open(mailbox, key, request.body ?? new Uint8Array());
    return bytes === null ? [] : [{ type: parseRecord(bytes)?.event.type ?? '?', mailbox }];
  });
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

  it('posts the remove and then its key change to the outgoing epoch’s mailbox for the week the relay is in (#110)', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'ana', events);

    // A week on, with the removal still open, Ben's 4 closes it early.
    fake.minute += WEEK_MINUTES;
    await device.store.enqueue(groupId, last.record);
    expect(await device.sync.syncOnce()).toBe(true);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);

    const nextWeek = deriveWeekMailboxId(group.secret, weekOf(START) + 1);
    expect(putsUnder(fake, group.secret).slice(-3)).toEqual([
      { type: 'vote', mailbox: nextWeek },
      { type: 'remove', mailbox: nextWeek },
      { type: 'key-rotate', mailbox: nextWeek },
    ]);
    expect((await device.store.getGroup(groupId))?.epoch).toBe(1);
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
    const requests = groupRequests(fake, group.secret);
    // The control: the device did name them while Cal was in the group.
    expect(requests).toBeGreaterThan(0);
    fake.minute += 5;
    expect(await device.sync.syncOnce()).toBe(true);
    fake.minute += WEEK_MINUTES;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(groupRequests(fake, group.secret)).toBe(requests);
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
    await relayTook(device.store, groupId, outbox.slice(0, 1));
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

    expect(await importGroups(other, file, 'a long walk')).toEqual({ groups: 1, older: false });

    const restored = (await other.getGroup(groupId)) ?? never();
    expect(restored.archived).toEqual({ reason: 'removed' });
    const requests = groupRequests(fake, group.secret);
    expect(await sync.syncOnce()).toBe(true);
    expect(groupRequests(fake, group.secret)).toBe(requests);
  });
});

describe('a removal and the relay backup (#97)', () => {
  /** The ids of the groups the relay backup under `key` holds. */
  async function groupsIn(fake: FakeRelay, key: Uint8Array): Promise<string[]> {
    const plaintext = await fetchRelayBackup(createRelay({ fetch: fake.fetch }), key);
    if (plaintext === null) throw new Error('expected a relay backup');
    const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as {
      groups: { groupId: string; epoch?: number; log: unknown[] }[];
    };
    return snapshot.groups.map(
      ({ groupId, epoch, log }) => `${groupId}@${String(epoch ?? 0)}#${String(log.length)}`,
    );
  }

  it('leaves the removed member’s read-only copy out of their relay backup', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const device = await openDevice(fake.fetch);
    const services = {
      store: device.store,
      relay: createRelay({ fetch: fake.fetch }),
      now: () => TS,
    };
    await keep(device, group, 'cal', [...events, last]);
    await startRelayBackup(services);
    const key = (await device.store.getRelayBackup())?.key ?? never();
    expect(await groupsIn(fake, key)).toEqual([`${groupId}@0#6`]);

    await device.store.enqueue(groupId, remove('ben').record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);
    await startRelayBackup(services);

    expect(await groupsIn(fake, key)).toEqual([]);
  });

  it('holds off while the key change after a remove is due, then holds the group at its new key', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const device = await openDevice(fake.fetch);
    const services = {
      store: device.store,
      relay: createRelay({ fetch: fake.fetch }),
      now: () => TS,
    };
    await keep(device, group, 'ana', [...events, last]);
    await startRelayBackup(services);
    const key = (await device.store.getRelayBackup())?.key ?? never();
    expect(await groupsIn(fake, key)).toEqual([`${groupId}@0#6`]);
    // Ben's remove reaches this device's log before it has written the key change it now owes.
    const held = (await device.store.getGroup(groupId)) ?? never();
    const record = { seq: held.cursor + 1, received: START + 1, bytes: remove('ben').record };
    const pull = {
      records: [record],
      cursor: held.cursor + 1,
      relayNow: START + 1,
      instance: held.instance ?? never(),
      lastSyncAt: TS,
    };
    await device.store.applyPull(groupId, pull, (bytes) => parseRecord(bytes)?.id ?? null);
    await startRelayBackup(services);
    // Still the copy from before the remove: the log it holds is one record short.
    expect(await groupsIn(fake, key)).toEqual([`${groupId}@0#6`]);

    // The remove goes up as it would have from Ben's device, and the pass writes the key change.
    const relay = createRelay({ fetch: fake.fetch });
    await relay.putBlob(
      group.mailbox,
      xchachaSeal.seal(group.mailbox, group.key, record.bytes),
      30,
    );
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);
    expect((await device.store.getGroup(groupId))?.epoch).toBe(1);
    await startRelayBackup(services);
    expect((await groupsIn(fake, key))[0]).toMatch(new RegExp(`^${groupId}@1#`));
  });
});

describe('a removal beside a shared personal Document (#105)', () => {
  it('leaves the Document and its share by link as they were when it archives the group', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'cal', [...events, last]);
    const statement = {
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      title: 'My mission statement',
      text: 'I show up for my neighbours.\n',
      createdAt: TS,
      updatedAt: TS,
    };
    await device.store.savePersonal(statement);
    const share = {
      seed: new Uint8Array(32).fill(4),
      ...newSigningKeys(),
      n: 2,
      lastPostedAt: TS,
      pending: false,
    };
    await device.store.updateShare(statement.id, () => share);
    const before = await device.store.getPersonal(statement.id);

    await device.store.enqueue(groupId, remove('ben').record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);

    expect((await device.store.getGroup(groupId))?.archived).toEqual({ reason: 'removed' });
    expect(await device.store.getPersonal(statement.id)).toEqual(before);
  });
});

describe('a removal beside ballot expiry (#111)', () => {
  /** The removal's result, as Ana's device would sign it from what `device` holds. */
  async function resultOf(device: { store: Store }, groupId: string, removal: string) {
    const held = (await device.store.getGroup(groupId)) ?? never();
    const proposal = foldGroup(held).proposals.find((p) => p.id === removal) ?? never();
    return signedAs('ana', {
      type: 'result',
      group: groupId,
      ts: TS,
      body: resultFor(proposal),
    });
  }

  it('archives a removed device on a remove that arrives after it cleared the removal’s ballots', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, removal, last, remove } = history(group);
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'cal', [...events, last]);
    fake.minute += 1;
    await device.store.enqueue(groupId, (await resultOf(device, groupId, removal.id)).record);
    expect(await device.sync.syncOnce()).toBe(true);
    // Thirty days on, the device clears the removal's ballots, keeping its result.
    fake.minute += 30 * DAY_MINUTES;
    expect(await device.sync.syncOnce()).toBe(true);
    const cleared = (await device.store.getGroup(groupId)) ?? never();
    expect(cleared.cleared).toContain(removal.id);
    expect(cleared.archived).toBeUndefined();

    await device.store.enqueue(groupId, remove('ben').record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);

    const held = (await device.store.getGroup(groupId)) ?? never();
    expect(held.archived).toEqual({ reason: 'removed' });
    expect(foldGroup(held).former.map((m) => m.author)).toEqual([authorOf('cal')]);
  });

  /** Cal's device, removed after posting his response, with its archived state and the minute it clears. */
  async function removedCopy() {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, removal, last, remove } = history(group);
    const response = signedAs('cal', {
      type: 'removal-response',
      group: groupId,
      ts: TS,
      body: { proposal: removal.id, text: 'I disagree.' },
    });
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'cal', [...events, response, last, remove('ben')]);
    const archived = (await device.store.getGroup(groupId)) ?? never();
    const state = foldGroup(archived);
    const at = removedClearMinute(state.rules, state.removals[0] ?? never()) ?? never();
    return { store: device.store, groupId, removal: removal.id, archived, state, at };
  }

  it('clears a removed copy’s ballots, notes and response by the device clock, ballotExpiryDays after the remove', async () => {
    const { store, groupId, removal, archived, state, at } = await removedCopy();
    expect(archived.archived).toEqual({ reason: 'removed' });
    expect(state.responses).toHaveLength(1);

    await sweepArchives(store, () => (at - 1) * MINUTE_MS);
    expect((await store.getGroup(groupId))?.archived?.cleared).toBeUndefined();
    await sweepArchives(store, () => at * MINUTE_MS);

    const cleared = ((await store.getGroup(groupId)) ?? never()).archived?.cleared ?? never();
    expect(cleared.at).toBe(at * MINUTE_MS);
    expect(cleared.state.proposals.flatMap((p) => p.ballots)).toEqual([]);
    expect(cleared.state.responses).toEqual([]);
    expect(cleared.state.removals).toEqual(state.removals);
    expect(cleared.tallies[removal]?.outcome.kind).toBe('pass');
  });
});

describe('a removal beside coalitions (#114)', () => {
  it('stops syncing the coalition only the removed group held, once its remove folds', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const groupId = group.genesis.id;
    const { events, last, remove } = history(group);
    const target = {
      kind: 'reconcile',
      secret: testSecret('coalition'),
      inner: testSecret('inner'),
      seat: base64url(seatSecret('A')),
      ...COALITION_STATEMENT,
    } as const;
    const reconcile = signedAs('ana', {
      type: 'proposal',
      group: groupId,
      ts: TS,
      body: { target, title: 'Reconcile', why: 'We share a river.' },
    });
    const device = await openDevice(fake.fetch);
    await keep(device, group, 'cal', [...events, reconcile, last]);
    const entry = deriveCoalitionEntryId(fromBase64url(testSecret('coalition')));
    expect((await device.store.getGroup(entry))?.archived).toBeUndefined();
    const ids = weeksOf(fromBase64url(testSecret('coalition')));
    const named = () =>
      fake.requests.filter((request) => ids.includes(mailboxIn(request.url))).length;
    // The control: while Cal is in the group, his device reads the coalition.
    expect(named()).toBeGreaterThan(0);

    await device.store.enqueue(groupId, remove('ben').record);
    fake.minute += 1;
    expect(await device.sync.syncOnce()).toBe(true);
    expect((await device.store.getGroup(groupId))?.archived).toEqual({ reason: 'removed' });
    expect((await device.store.getGroup(entry))?.archived).toEqual({ reason: 'removed' });

    const before = named();
    fake.minute += 5;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(named()).toBe(before);
    // Nor is one made again from the removed copy by a fresh loop, as after a restore.
    await device.store.purgeGroup(entry);
    device.sync.stop();
    const fresh = await openDevice(fake.fetch);
    fake.minute += 5;
    expect(await fresh.sync.syncOnce()).toBe(true);
    expect(await fresh.store.getGroup(entry)).toBeUndefined();
    expect(named()).toBe(before);
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
