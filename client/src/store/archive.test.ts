/**
 * A dissolved group on this device (#108; docs/spec/phase-1-spec.md §7,
 * Dissolve; ADR-0051, ADR-0057, ADR-0075 §5), through fake-indexeddb, the fake
 * relay and an injected device clock.
 *
 * The device that folds a dissolve Proposal's final pass posts one
 * `dissolve`. Once one folds, the group is archived: its outbox goes, and no
 * PUT or GET names its mailbox again. With wipe, the first launch at least a
 * week after the dissolve's receipt erases every record of it; without, the
 * first launch 30 days after clears every ballot and note and keeps each
 * outcome and its totals. Both count by the device's own clock, because no
 * relay time arrives after a dissolve.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sealBackup } from '../crypto/backup';
import { deriveMailboxId, deriveSealKey } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { parseRecord, type Score, type SignedEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { createRelay, type Fetch } from '../net/relay';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { containsBytes, scanDb } from '../test/scanDb';
import { MINUTE_MS, settleDissolve, shownState, sweepArchives } from './archive';
import { type BackedUpGroup, type Group, openStore, type Store } from './db';
import type { PersonalDocument } from './personal';
import { fetchRelayBackup, startRelayBackup } from './relayBackup';
import { encodeSnapshot, exportGroups, importGroups } from './snapshot';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const DB = 'dissolve-device';
const TS = 1_762_650_000_000;
/** The relay minute every event before the dissolve arrives at. */
const START = 29_000_000;
/** The relay minute the dissolve arrives at. */
const DISSOLVED = START + 10;
const CANARY_GROUP = 'Canary Court Tenants';
const CANARY_NOTE = 'Canary note: the bins smell of fish.';
const opened: Sync[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/**
 * Ana's genesis, the group secret, and the mailbox and key it derives. Every
 * member carries an encryption key (#98), as the app makes one at Create
 * group and Join, unless `kx` is false: a group kept before #98.
 */
function founding(kx = true) {
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: CANARY_GROUP,
      founder: 'Ana',
      title: 'House rules',
      atoms: ['Quiet after 11pm.', 'Bins out on Sunday.'],
      ...(kx ? { kx: testKx('ana').kx } : {}),
    },
  });
  const secret = new Uint8Array(32).fill(7);
  return { genesis, secret, kx, mailbox: deriveMailboxId(secret), key: deriveSealKey(secret) };
}

type Founded = ReturnType<typeof founding>;

/** The events of a group that passes an edit, Ben's ballot carrying the canary note, then a dissolve Proposal. */
function history(group: Founded, wipe: boolean) {
  const draft = { group: group.genesis.id, ts: TS };
  const g = group.genesis.id;
  const edit = signedAs('ana', {
    ...draft,
    type: 'proposal',
    body: {
      atom: `${g}.1`,
      title: 'Bins on Monday',
      why: 'It moved.',
      text: 'Bins out on Monday.',
    },
  });
  const motion = signedAs('ana', {
    ...draft,
    type: 'proposal',
    body: { target: { kind: 'dissolve', wipe }, title: 'Dissolve', why: 'We have all moved out.' },
  });
  const vote = (name: string, proposal: SignedEvent, score: Score, note?: string) =>
    signedAs(name, {
      ...draft,
      type: 'vote',
      body: {
        proposal: proposal.id,
        scores: { [proposal.id]: score },
        ...(note === undefined ? {} : { note }),
      },
    });
  const joins = ['ben', 'cal'].map((name) => {
    const body = { name: name === 'ben' ? 'Ben' : 'Cal', ...kxOf(group, name) };
    return signedAs(name, { ...draft, type: 'join', body });
  });
  const events = [
    ...joins,
    edit,
    vote('ana', edit, 4),
    vote('ben', edit, 3, CANARY_NOTE),
    vote('cal', edit, 4),
    motion,
    vote('ana', motion, 4),
    vote('ben', motion, 4),
  ];
  return { events, edit, motion, last: vote('cal', motion, 4) };
}

async function openDevice(fetch: Fetch): Promise<{ store: Store; sync: Sync }> {
  const store = await openStore(DB);
  stores.push(store);
  const sync = createSync({
    store,
    relay: createRelay({ fetch }),
    seal: xchachaSeal,
    clock: () => TS,
  });
  opened.push(sync);
  return { store, sync };
}

/** `name`'s encryption key for a join body, when the group's members carry one (#98). */
function kxOf(group: Founded, name: string): { kx?: string } {
  return group.kx ? { kx: testKx(name).kx } : {};
}

/** Keeps the group on Ana's device and sends everything up to the motion's last ballot. */
async function keep(store: Store, sync: Sync, group: Founded, events: readonly SignedEvent[]) {
  const { secretKey, author } = testKeys('ana');
  const groupId = group.genesis.id;
  await store.addGroup({
    groupId,
    secret: group.secret,
    signingKey: secretKey,
    ...(group.kx ? { kxKey: testKx('ana').kxKey } : {}),
    me: { author, name: 'Ana' },
  });
  await store.enqueueAll(groupId, [group.genesis.record, ...events.map((e) => e.record)]);
  expect(await sync.syncOnce()).toBe(true);
}

/** The event types in the group's outbox, by author name. */
async function outboxOf(store: Store, groupId: string) {
  const group = await store.getGroup(groupId);
  return (group?.outbox ?? []).map((bytes) => parseRecord(bytes)?.event);
}

/** How many requests named the group's mailbox. */
function mailboxRequests(fake: FakeRelay, group: Founded): number {
  return fake.requests.filter((request) => request.url.includes(group.mailbox)).length;
}

/** A device clock at relay minute `minute`, in device milliseconds. */
const clockAt = (minute: number) => () => minute * MINUTE_MS;

/** Ana's device, in a group whose dissolve has folded and been archived. */
async function dissolvedDevice(wipe: boolean) {
  const fake = createFakeRelay({ minute: START });
  const group = founding();
  const { events, edit, motion, last } = history(group, wipe);
  const { store, sync } = await openDevice(fake.fetch);
  await keep(store, sync, group, [...events, last]);
  fake.minute = DISSOLVED;
  expect(await sync.syncOnce()).toBe(true);
  return { fake, group, store, sync, edit, motion, groupId: group.genesis.id };
}

describe('dissolving on this device', () => {
  it('posts one dissolve once the pass is final, and none before', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, motion, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    const groupId = group.genesis.id;
    await keep(store, sync, group, events);
    expect(await outboxOf(store, groupId)).toEqual([]);

    await store.enqueue(groupId, last.record);
    fake.minute += 1;
    expect(await sync.syncOnce()).toBe(true);

    const queued = await outboxOf(store, groupId);
    expect(queued.map((event) => [event?.type, event?.author, event?.body])).toEqual([
      ['dissolve', authorOf('ana'), { proposal: motion.id }],
    ]);
    await settleDissolve(store, groupId, () => TS);
    expect(await outboxOf(store, groupId)).toHaveLength(1);
  });

  it('archives once a dissolve folds: the outbox goes, and no PUT or GET names the mailbox again', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, edit, last } = history(group, false);
    const groupId = group.genesis.id;
    let store: Store | null = null;
    // A ballot this member casts while the pass that brings the dissolve is under way.
    const late = signedAs('ana', {
      type: 'vote',
      group: groupId,
      ts: TS,
      body: { proposal: edit.id, scores: { [edit.id]: 4 } },
    });
    const fetch: Fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reading = init?.method !== 'PUT' && url.includes(group.mailbox);
      if (reading && fake.minute === DISSOLVED) await store?.enqueue(groupId, late.record);
      return fake.fetch(input, init);
    };
    const device = await openDevice(fetch);
    store = device.store;
    await keep(device.store, device.sync, group, [...events, last]);
    fake.minute = DISSOLVED;

    expect(await device.sync.syncOnce()).toBe(true);

    const kept = await device.store.getGroup(groupId);
    expect(kept?.archived).toEqual({ reason: 'dissolved' });
    expect(kept?.outbox).toEqual([]);
    expect(shownState(kept ?? never()).dissolved).toEqual({ received: DISSOLVED, wipe: false });
    const before = fake.requests.length;
    fake.minute += 5;
    expect(await device.sync.syncOnce()).toBe(true);
    expect(await device.sync.syncOnce()).toBe(true);
    expect(fake.requests.length).toBe(before);
    await expect(device.store.enqueue(groupId, late.record)).rejects.toThrow('read-only');
  });

  it('opens the archive offline, after a reload, with its Document and outcomes', async () => {
    const { fake, group, groupId, edit } = await dissolvedDevice(false);
    const requests = mailboxRequests(fake, group);
    for (const store of stores.splice(0)) store.close();
    fake.offline = true;

    const { store, sync } = await openDevice(fake.fetch);
    expect(await sync.syncOnce()).toBe(true);
    const state = shownState((await store.getGroup(groupId)) ?? never());
    expect(state.dissolved).toEqual({ received: DISSOLVED, wipe: false });
    expect(state.atoms.map((atom) => atom.text)).toEqual([
      'Quiet after 11pm.',
      'Bins out on Monday.',
    ]);
    expect(state.proposals.find((p) => p.id === edit.id)?.outcome.kind).toBe('pass');
    expect(mailboxRequests(fake, group)).toBe(requests);
  });
});

describe('a dissolve that wipes every copy', () => {
  it('keeps the group at day 6 and a minute short of day 7, and leaves no record of it after a launch at day 7', async () => {
    const { store, group, groupId } = await dissolvedDevice(true);
    const week = DISSOLVED + 7 * DAY_MINUTES;

    await sweepArchives(store, clockAt(DISSOLVED + 6 * DAY_MINUTES));
    expect(await store.getGroup(groupId)).toBeDefined();
    await sweepArchives(store, clockAt(week - 1));
    expect(await store.getGroup(groupId)).toBeDefined();
    expect((await scanDb(DB)).text).toContain(CANARY_GROUP);

    // The launch: a new store on the same database.
    for (const open of stores.splice(0)) open.close();
    const launched = await openStore(DB);
    stores.push(launched);
    await sweepArchives(launched, clockAt(week));

    expect(await launched.listGroups()).toEqual([]);
    const after = await scanDb(DB);
    expect(after.text).not.toContain(groupId);
    expect(after.text).not.toContain(CANARY_GROUP);
    expect(after.text).not.toContain(CANARY_NOTE);
    expect(containsBytes(after.bytes, group.secret)).toBe(false);
  });
});

describe('a dissolve that keeps read-only copies', () => {
  const month = DISSOLVED + 30 * DAY_MINUTES;

  it('is never wiped, and holds its ballots and notes until a minute short of 30 days', async () => {
    const { store, groupId } = await dissolvedDevice(false);

    await sweepArchives(store, clockAt(DISSOLVED + 7 * DAY_MINUTES));
    await sweepArchives(store, clockAt(month - 1));

    expect(typesIn((await store.getGroup(groupId)) ?? never())).toContain('vote');
    expect((await scanDb(DB)).text).toContain(CANARY_NOTE);
  });

  it('clears every ballot and note at 30 days, keeping each outcome and its totals', async () => {
    const { store, groupId, edit, motion } = await dissolvedDevice(false);
    const before = shownState((await store.getGroup(groupId)) ?? never());

    await sweepArchives(store, clockAt(month));

    const cleared = (await store.getGroup(groupId)) ?? never();
    expect(typesIn(cleared)).not.toContain('vote');
    const scan = await scanDb(DB);
    expect(scan.text).not.toContain(CANARY_NOTE);
    expect(scan.text).toContain(CANARY_GROUP);
    expectKept(shownState(cleared), before);
    const tallies = cleared.archived?.cleared?.tallies ?? {};
    const totals = tallies[edit.id]?.versions.map((v) => [v.scorers, v.sum, v.zeros]);
    expect(totals).toEqual([[3, 11, 0]]);
    expect(tallies[motion.id]?.outcome.kind).toBe('pass');
    expect(cleared.archived?.cleared?.at).toBe(month * MINUTE_MS);

    // A later launch changes nothing.
    await sweepArchives(store, clockAt(month + 400 * DAY_MINUTES));
    expect(await store.getGroup(groupId)).toEqual(cleared);
  });
});

describe('a dissolve beside personal Documents (#93)', () => {
  /** A personal Document on Ana's device, which no group holds. */
  const statement: PersonalDocument = {
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    title: 'My mission statement',
    text: 'I show up for my neighbors.\n',
    createdAt: TS,
    updatedAt: TS,
  };

  it('leaves every personal Document on the device when it wipes the group a week on', async () => {
    const { store, groupId } = await dissolvedDevice(true);
    await store.savePersonal(statement);

    await sweepArchives(store, clockAt(DISSOLVED + 7 * DAY_MINUTES));

    expect(await store.getGroup(groupId)).toBeUndefined();
    expect(await store.listPersonal()).toEqual([statement]);
  });

  it('leaves every personal Document on the device when it clears the archive at 30 days', async () => {
    const { store, groupId } = await dissolvedDevice(false);
    await store.savePersonal(statement);

    await sweepArchives(store, clockAt(DISSOLVED + 30 * DAY_MINUTES));

    expect((await store.getGroup(groupId))?.archived?.cleared).toBeDefined();
    expect(await store.listPersonal()).toEqual([statement]);
  });
});

describe('sweepArchives', () => {
  it('leaves alone a group that goes on, and an archive whose log holds no dissolve', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events } = history(group, true);
    const { store, sync } = await openDevice(fake.fetch);
    const groupId = group.genesis.id;
    await keep(store, sync, group, events);
    const before = await store.getGroup(groupId);

    await sweepArchives(store, clockAt(START + 400 * DAY_MINUTES));
    expect(await store.getGroup(groupId)).toEqual(before);
    // #115 archives a removed member's copy with no dissolve in its log.
    await store.markArchived(groupId, 'dissolved');
    const archived = await store.getGroup(groupId);
    await sweepArchives(store, clockAt(START + 400 * DAY_MINUTES));
    expect(await store.getGroup(groupId)).toEqual(archived);
  });
});

describe('settleDissolve', () => {
  it('posts nothing for a group this device is leaving, or whose join the relay hasn’t returned', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    const groupId = group.genesis.id;
    await keep(store, sync, group, [...events, last]);
    const leave = signedAs('ana', { type: 'leave', group: groupId, ts: TS, body: {} });
    // Ana's own dissolve is queued already; take it out, then mark the group leaving.
    const queued = (await store.getGroup(groupId))?.outbox ?? [];
    for (const bytes of queued) await store.markSent(groupId, bytes);
    await store.markLeaving(groupId, leave.record);
    await settleDissolve(store, groupId, () => TS);
    expect((await outboxOf(store, groupId)).map((event) => event?.type)).toEqual(['leave']);

    // Kim's device holds the log, but the relay never returned a join from her.
    const kim = testKeys('kim');
    await store.purgeGroup(groupId);
    await store.addGroup({
      groupId,
      secret: group.secret,
      signingKey: kim.secretKey,
      me: { author: kim.author, name: 'Kim' },
    });
    fake.minute += 1;
    expect(await sync.syncOnce()).toBe(true);
    expect(await outboxOf(store, groupId)).toEqual([]);
    await settleDissolve(store, 'no-such-group', () => TS);
  });
});

describe('a dissolve beside key changes (#98)', () => {
  it('archives a group kept before #98 without queueing a kx, and the pass that archives it succeeds', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding(false);
    const { events, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    const groupId = group.genesis.id;
    await keep(store, sync, group, [...events, last]);
    // The device made an encryption key and queued its kx beside its dissolve.
    expect((await outboxOf(store, groupId)).map((event) => event?.type)).toEqual([
      'dissolve',
      'kx',
    ]);
    fake.minute = DISSOLVED;

    expect(await sync.syncOnce()).toBe(true);

    const kept = (await store.getGroup(groupId)) ?? never();
    expect(kept.archived).toEqual({ reason: 'dissolved' });
    expect(kept.outbox).toEqual([]);
    // The kx landed after the dissolve, so the fold ignored it, and no other is queued.
    expect(shownState(kept).members.find((m) => m.author === authorOf('ana'))?.kx).toBeNull();
    const requests = fake.requests.length;
    fake.minute += 5;
    expect(await sync.syncOnce()).toBe(true);
    expect(fake.requests.length).toBe(requests);
  });

  it('starts no key change for a leave that lands just before the dissolve, and sends nothing after', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    const groupId = group.genesis.id;
    await keep(store, sync, group, [...events, last]);
    expect((await outboxOf(store, groupId)).map((event) => event?.type)).toEqual(['dissolve']);
    // Cal's device posts his leave before Ana's device has read it, so her dissolve still goes.
    const leave = signedAs('cal', { type: 'leave', group: groupId, ts: TS, body: {} });
    const cal = createRelay({ fetch: fake.fetch });
    await cal.putBlob(group.mailbox, xchachaSeal.seal(group.mailbox, group.key, leave.record), 30);
    fake.minute = DISSOLVED;
    const before = fake.requests.length;

    expect(await sync.syncOnce()).toBe(true);

    const kept = (await store.getGroup(groupId)) ?? never();
    expect(typesIn(kept).slice(-2)).toEqual(['leave', 'dissolve']);
    expect(kept.archived).toEqual({ reason: 'dissolved' });
    const state = shownState(kept);
    expect([state.dissolved?.received, state.epoch, state.rotationDue]).toEqual([
      DISSOLVED,
      0,
      false,
    ]);
    // One PUT, Ana's dissolve, and the GET that read it back: no key-rotate, in any mailbox.
    const sent = fake.requests.slice(before);
    expect(sent.map((request) => request.method)).toEqual(['PUT', 'GET']);
    expect(kept.epoch ?? 0).toBe(0);
    fake.minute += 5;
    expect(await sync.syncOnce()).toBe(true);
    expect(fake.requests.length).toBe(before + sent.length);
  });
});

/** The backup file's passphrase, and a cheap scrypt cost for tests. */
const PASSPHRASE = 'a long walk to the river';
const CHEAP = 4;

/** `group` as a backup file would hold it, with `changes`: what `restoreGroups` takes. */
function copyOf(group: Group, changes: Partial<BackedUpGroup> = {}): BackedUpGroup {
  const { groupId, secret, signingKey, me, log, cursor, relayNow, instance, lastSyncAt } = group;
  const copy = { groupId, secret, signingKey, me, log, cursor, relayNow, instance, lastSyncAt };
  return { ...copy, missingHistory: group.missingHistory === true, ...changes };
}

/** A file sealing `groups`, and any `personal` Documents (#93), under the test passphrase. */
const fileOf = (groups: readonly BackedUpGroup[], personal: readonly PersonalDocument[] = []) =>
  sealBackup(encodeSnapshot({ groups, personal }), PASSPHRASE, CHEAP);

describe('a dissolved group and backup files (#78)', () => {
  it('leaves the read-only copy out of a backup file, which held the group while it went on', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    await keep(store, sync, group, [...events, last]);
    expect((await exportGroups(store, PASSPHRASE, CHEAP)).groupIds).toEqual([group.genesis.id]);

    fake.minute = DISSOLVED;
    expect(await sync.syncOnce()).toBe(true);
    expect((await store.getGroup(group.genesis.id))?.archived).toEqual({ reason: 'dissolved' });

    expect((await exportGroups(store, PASSPHRASE, CHEAP)).groupIds).toEqual([]);
  });

  it('leaves the read-only copy out of the relay backup too (#97)', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, last } = history(group, false);
    const { store, sync } = await openDevice(fake.fetch);
    const relay = createRelay({ fetch: fake.fetch });
    const services = { store, relay, now: () => TS };
    await keep(store, sync, group, [...events, last]);
    await startRelayBackup(services);
    const key = (await store.getRelayBackup())?.key ?? never();
    const groupsIn = async () =>
      (
        JSON.parse(new TextDecoder().decode((await fetchRelayBackup(relay, key)) ?? never())) as {
          groups: { groupId: string }[];
        }
      ).groups.map(({ groupId }) => groupId);
    expect(await groupsIn()).toEqual([group.genesis.id]);

    fake.minute = DISSOLVED;
    expect(await sync.syncOnce()).toBe(true);
    await startRelayBackup(services);

    expect(await groupsIn()).toEqual([]);
  });

  it('keeps the read-only copy when a file holds the group live and synced later', async () => {
    const { fake, group, store, sync, groupId } = await dissolvedDevice(false);
    const held = (await store.getGroup(groupId)) ?? never();
    // The copy a device that never fetched the dissolve made a day later.
    const live = held.log.filter((record) => parseRecord(record.bytes)?.event.type !== 'dissolve');
    const later = (held.lastSyncAt ?? 0) + DAY_MINUTES * MINUTE_MS;
    const file = await fileOf([copyOf(held, { log: live, lastSyncAt: later })]);

    expect(await importGroups(store, file, PASSPHRASE)).toBe(1);

    const kept = (await store.getGroup(groupId)) ?? never();
    expect(kept).toEqual({ ...held, backup: 'saved' });
    expect(shownState(kept).dissolved).toEqual({ received: DISSOLVED, wipe: false });
    const requests = mailboxRequests(fake, group);
    expect(await sync.syncOnce()).toBe(true);
    expect(mailboxRequests(fake, group)).toBe(requests);
  });

  it('brings a file’s group whose log holds the dissolve back read-only, so it never syncs', async () => {
    const { fake, group, store, groupId } = await dissolvedDevice(false);
    // A file an older app made: the group's log holds the dissolve, with no mark on it.
    const file = await fileOf([copyOf((await store.getGroup(groupId)) ?? never())]);
    const other = await openStore('dissolve-restored');
    stores.push(other);
    const sync = createSync({
      store: other,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      clock: () => TS,
    });
    opened.push(sync);

    expect(await importGroups(other, file, PASSPHRASE)).toBe(1);

    const restored = (await other.getGroup(groupId)) ?? never();
    expect(restored.archived).toEqual({ reason: 'dissolved' });
    expect(restored.outbox).toEqual([]);
    expect(shownState(restored).dissolved).toEqual({ received: DISSOLVED, wipe: false });
    const requests = mailboxRequests(fake, group);
    fake.minute += 5;
    expect(await sync.syncOnce()).toBe(true);
    expect(mailboxRequests(fake, group)).toBe(requests);
    await expect(other.enqueue(groupId, group.genesis.record)).rejects.toThrow('read-only');
  });
});

describe('halting the sync loop (Erase, #78) as a group dissolves', () => {
  it('waits for the pass that archives the group, runs no chat bot for it, and sends nothing after', async () => {
    const fake = createFakeRelay({ minute: START });
    const group = founding();
    const { events, last } = history(group, false);
    const groupId = group.genesis.id;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const fetch: Fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Hold the GET of the pass that brings the dissolve.
      if (init?.method !== 'PUT' && url.includes(group.mailbox) && fake.minute === DISSOLVED) {
        holding = true;
        await held;
      }
      return fake.fetch(input, init);
    };
    const store = await openStore(DB);
    stores.push(store);
    const chatBot = { run: vi.fn(() => Promise.resolve()) };
    const sync = createSync({
      store,
      relay: createRelay({ fetch }),
      seal: xchachaSeal,
      clock: () => TS,
      chatBot,
    });
    opened.push(sync);
    await keep(store, sync, group, [...events, last]);
    expect(chatBot.run).toHaveBeenCalledOnce();
    fake.minute = DISSOLVED;

    const passing = sync.syncOnce();
    await expect.poll(() => holding).toBe(true);
    let halted = false;
    const halting = sync.halt().then(() => {
      halted = true;
    });
    await Promise.resolve();
    expect(halted).toBe(false);
    release();
    await halting;

    expect(await passing).toBe(true);
    expect((await store.getGroup(groupId))?.archived).toEqual({ reason: 'dissolved' });
    expect(chatBot.run).toHaveBeenCalledOnce();
    const requests = fake.requests.length;
    fake.minute += 5;
    expect(await sync.syncOnce()).toBe(false);
    expect(fake.requests.length).toBe(requests);
  });
});

/** A cleared archive shows what it did before: each outcome, the Document and the dissolve, with no ballot. */
function expectKept(after: GroupState, before: GroupState): void {
  expect(after.proposals.map((p) => [p.id, p.final, p.outcome])).toEqual(
    before.proposals.map((p) => [p.id, p.final, p.outcome]),
  );
  expect(after.proposals.flatMap((p) => p.ballots)).toEqual([]);
  expect(after.atoms).toEqual(before.atoms);
  expect(after.dissolved).toEqual(before.dissolved);
}

/** The type of each event in the group's log. */
function typesIn(group: Group): (string | undefined)[] {
  return group.log.map((record) => parseRecord(record.bytes)?.event.type);
}

/** Fails a test that reached a value it expected to exist. */
function never(): never {
  throw new Error('Expected a value here.');
}
