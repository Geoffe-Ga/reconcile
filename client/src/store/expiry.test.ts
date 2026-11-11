/**
 * Ballot expiry on real devices (#111): fake IndexedDB, the in-memory relay,
 * and relay time moved on by hand. After the window, no ballot score or
 * note may remain anywhere on the device, nothing may bring one back, and
 * the decision and its totals stay.
 */
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveWeekMailboxId, newGroupSecret, weekOf } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { parseRecord, type SignedEvent } from '../engine/event';
import { fold, proposalTally } from '../engine/fold';
import { createRelay, type Relay } from '../net/relay';
import { contains, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { Logs } from '../test/coalitions';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { openStore, type Group, type Store } from './db';
import { eventIdOf } from './eventId';
import { clearExpiredBallots, foldGroup, resultsDue, signResults } from './expiry';
import { channelOf, createSync, openRecords, type Sync } from './sync';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const TS = 1_762_650_000_000;
/** 30 days in relay minutes: `ballotExpiryDays` × 1,440. */
const WINDOW = 43_200;
/** Note text that must never outlive the window, in any encoding the device keeps. */
const ANA_NOTE = 'canary-ana-7f3c: the hall is too loud';
const BEN_NOTE = 'canary-ben-91d2: fine by me';
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
});

interface Device {
  readonly name: string;
  readonly store: Store;
  readonly sync: Sync;
  group(): Promise<Group>;
}

/**
 * A device for `name` in the group with `secret`, in its own IndexedDB
 * database, with the encryption key its genesis or join carries (#98).
 */
async function device(name: string, relay: Relay, secret: Uint8Array): Promise<Device> {
  const store = await openStore(`reconcile-${name}`);
  const { secretKey: signingKey, author } = testKeys(name);
  const { kxKey } = testKx(name);
  await store.addGroup({ groupId: GROUP, secret, signingKey, kxKey, me: { author, name } });
  return attach(name, store, relay);
}

function attach(name: string, store: Store, relay: Relay): Device {
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
  opened.push(sync);
  return {
    name,
    store,
    sync,
    group: async () => {
      const found = await store.getGroup(GROUP);
      if (found === undefined) throw new Error('the group is gone');
      return found;
    },
  };
}

/**
 * Every value in every object store of every IndexedDB database here, or of
 * `only` that device's own when two devices share one test's IndexedDB.
 */
async function everythingStored(only?: Device): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const { name, version } of await indexedDB.databases()) {
    if (name === undefined || (only !== undefined && name !== `reconcile-${only.name}`)) continue;
    const db = await openDB(name, version);
    for (const storeName of db.objectStoreNames) {
      const stored: readonly unknown[] = await db.getAll(storeName);
      values.push(...stored);
    }
    db.close();
  }
  return values;
}

/** Every string and byte array inside `value`, however deeply nested, as bytes. */
function leaves(value: unknown): Uint8Array[] {
  if (typeof value === 'string') return [utf8(value)];
  // Stored bytes come back from another realm's Uint8Array, so `instanceof` would miss them.
  if (ArrayBuffer.isView(value)) {
    return [new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  }
  if (value instanceof Map) return [...value.entries()].flatMap(leaves);
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(leaves);
  return [];
}

/** True when `needle` appears in anything stored (by `only`, if named), in UTF-8 or as raw bytes. */
async function onDevice(needle: Uint8Array, only?: Device): Promise<boolean> {
  const stored = (await everythingStored(only)).flatMap(leaves);
  return stored.some((bytes) => contains(bytes, needle));
}

/** The type of each event in a log or outbox. */
function types(records: readonly (Uint8Array | { readonly bytes: Uint8Array })[]): string[] {
  return records.map((item) => {
    const bytes = 'bytes' in item ? item.bytes : item;
    return parseRecord(bytes)?.event.type ?? '?';
  });
}

/** A decided vote on two devices, and the relay they share. */
interface Decided {
  readonly fake: FakeRelay;
  readonly relay: Relay;
  readonly secret: Uint8Array;
  readonly ana: Device;
  readonly ben: Device;
  readonly proposal: SignedEvent;
  readonly ballots: readonly SignedEvent[];
  readonly closedAt: number;
}

/**
 * Two members' decided vote: both score it, the second ballot closes it
 * early, then, unless `quiet`, a minute passes and the result goes up and
 * comes back: Ana's first pass finds none due yet, her second queues it, her
 * third posts it and reads it back, and Ben reads it. A quiet group has no
 * result yet: Ana has read both ballots, but no device synced after the close.
 */
async function decidedTogether(quiet = false): Promise<Decided> {
  const fake = createFakeRelay();
  const relay = createRelay({ fetch: fake.fetch });
  const secret = newGroupSecret();
  const ana = await device('ana', relay, secret);
  const ben = await device('ben', relay, secret);
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      title: 'House rules',
      atoms: ['Quiet after 10pm.', 'Bins out on Sunday.'],
      kx: testKx('ana').kx,
    },
  });
  const group = genesis.id;
  await ana.store.enqueue(GROUP, genesis.record);
  await ana.sync.syncOnce();
  await ben.store.enqueue(
    GROUP,
    signedAs('ben', { type: 'join', group, ts: TS, body: { name: 'Ben', kx: testKx('ben').kx } })
      .record,
  );
  await ben.sync.syncOnce();
  fake.minute += 1;
  const proposal = signedAs('ana', {
    type: 'proposal',
    group,
    ts: TS,
    body: {
      atom: `${group}.0`,
      title: 'Later quiet hours',
      why: 'Shift work.',
      text: 'Quiet after 11pm.',
    },
  });
  await ana.store.enqueue(GROUP, proposal.record);
  await ana.sync.syncOnce();
  fake.minute += 1;
  const ballot = (name: string, note: string, salt: string) =>
    signedAs(name, {
      type: 'vote',
      group,
      ts: TS,
      body: { proposal: proposal.id, scores: { [proposal.id]: 3 }, note, salt },
    });
  const ballots = [
    ballot('ana', ANA_NOTE, 'AQIDBAUGBwgJCgsMDQ4PEA'),
    ballot('ben', BEN_NOTE, 'ERITFBUWFxgZGhscHR4fIA'),
  ];
  await ana.store.enqueue(GROUP, ballots[0]?.record ?? new Uint8Array());
  await ana.sync.syncOnce();
  await ben.store.enqueue(GROUP, ballots[1]?.record ?? new Uint8Array());
  await ben.sync.syncOnce();
  const closedAt = fake.minute;
  if (quiet) {
    // In the closing minute Ana reads Ben's ballot too, but no result is due until the next.
    await ana.sync.syncOnce();
    return { fake, relay, secret, ana, ben, proposal, ballots, closedAt };
  }
  // A minute on, Ana's device owes the result: it syncs once more to be sure, queues it, posts it.
  fake.minute += 1;
  await syncEach(ana, ana, ana, ben);
  return { fake, relay, secret, ana, ben, proposal, ballots, closedAt };
}

/** Runs one sync pass on each device, in turn. */
async function syncEach(...devices: readonly Device[]): Promise<void> {
  for (const d of devices) await d.sync.syncOnce();
}

describe('ballot expiry on a device', () => {
  it('keeps the ballots 43,199 minutes after the close, and deletes them at 43,200, keeping the result and totals', async () => {
    const { fake, ana, ben, ballots, closedAt, proposal } = await decidedTogether();
    const before = await ana.group();
    expect(types(before.log)).toEqual(['genesis', 'join', 'proposal', 'vote', 'vote', 'result']);
    expect(types((await ben.group()).log)).toEqual(types(before.log));
    const totalsBefore = proposalTally(foldGroup(before).proposals[0] ?? never());
    expect(await onDevice(utf8(ANA_NOTE))).toBe(true);

    fake.minute = closedAt + WINDOW - 1;
    await syncEach(ana, ben);
    expect(types((await ana.group()).log)).toContain('vote');
    expect((await ana.group()).cleared).toBeUndefined();
    expect(await onDevice(utf8(BEN_NOTE))).toBe(true);

    fake.minute = closedAt + WINDOW;
    await syncEach(ana, ben);
    for (const d of [ana, ben]) {
      const after = await d.group();
      expect(types(after.log)).toEqual(['genesis', 'join', 'proposal', 'result']);
      expect(after.cleared).toEqual([proposal.id]);
      const state = foldGroup(after);
      expect(state.proposals[0]).toMatchObject({ cleared: true, ballots: [], final: true });
      expect(proposalTally(state.proposals[0] ?? never())).toEqual(totalsBefore);
      expect(state.atoms[0]?.text).toBe('Quiet after 11pm.');
    }
    for (const needle of [
      utf8(ANA_NOTE),
      utf8(BEN_NOTE),
      ...ballots.map((b) => b.bytes),
      ...ballots.map((b) => b.record),
    ]) {
      expect(await onDevice(needle)).toBe(false);
    }
  });

  it('clears once its own result comes back, for a device back after 30 days away', async () => {
    const { fake, ana } = await decidedTogether(true);
    fake.minute += WINDOW + 5;

    // The first pass finds the result due, and the second, after syncing again, queues it.
    await syncEach(ana, ana);
    expect(types((await ana.group()).outbox)).toEqual(['result']);
    expect(types((await ana.group()).log)).toContain('vote');

    // The third posts it to this week's mailbox (#110), reads it back, then clears.
    await ana.sync.syncOnce();
    expect(types((await ana.group()).log)).toEqual(['genesis', 'join', 'proposal', 'result']);
    expect((await ana.group()).outbox).toEqual([]);
    expect(await onDevice(utf8(ANA_NOTE), ana)).toBe(false);
  });

  it('adds nothing back when the relay delivers the old ballots again, even from seq 0 of a new instance', async () => {
    const { fake, relay, secret, ana, ben, ballots, closedAt } = await decidedTogether();
    fake.minute = closedAt + WINDOW;
    await ana.sync.syncOnce();
    expect(types((await ana.group()).log)).not.toContain('vote');
    // Ben hasn't synced since, so his device still holds them: the search finds what's there.
    for (const ballot of ballots) expect(await onDevice(ballot.record, ben)).toBe(true);

    // A fresh relay database, which this week's mailbox holds the old ballots in again: a new
    // instance, so Ana reads every mailbox from its start (#110).
    fake.restart({ keep: true });
    const week = channelOf(secret, weekOf(fake.minute));
    for (const ballot of ballots) {
      await relay.putBlob(
        week.mailbox,
        xchachaSeal.seal(week.mailbox, week.key, ballot.record),
        30,
      );
    }
    const from = fake.requests.length;
    await ana.sync.syncOnce();
    await ana.sync.syncOnce();

    const read = fake.requests.slice(from).filter((r) => r.url.includes(week.mailbox));
    expect(read.some((r) => r.method === 'GET' && r.url.includes('after=0'))).toBe(true);
    expect(types((await ana.group()).log)).toEqual(['genesis', 'join', 'proposal', 'result']);
    for (const ballot of ballots) expect(await onDevice(ballot.record, ana)).toBe(false);
  });

  it('adds nothing back from a weekly mailbox it catches up on (#110), though it reads that mailbox', async () => {
    const { fake, relay, secret, ana, ballots, closedAt, proposal } = await decidedTogether();
    fake.minute = closedAt + WINDOW;
    await ana.sync.syncOnce();
    expect((await ana.group()).cleared).toEqual([proposal.id]);
    // A stale device sends Ben's ballot again in a later week, beside a new event.
    fake.minute += 7 * 1_440;
    const week = channelOf(secret, weekOf(fake.minute));
    const level = signedAs('ben', {
      type: 'level',
      group: parseRecord(proposal.record)?.event.group ?? '',
      ts: TS,
      body: { level: 'member' },
    });
    for (const record of [ballots[1]?.record ?? new Uint8Array(), level.record]) {
      await relay.putBlob(week.mailbox, xchachaSeal.seal(week.mailbox, week.key, record), 30);
    }
    // Ana is away two more weeks, then catches up on each week she missed, once.
    fake.minute += 14 * 1_440;
    const from = fake.requests.length;
    await ana.sync.syncOnce();

    const read = fake.requests.slice(from).filter((r) => r.url.includes(week.mailbox));
    expect(read.map((r) => r.method)).toEqual(['GET']);
    expect(types((await ana.group()).log)).toEqual([
      'genesis',
      'join',
      'proposal',
      'result',
      'level',
    ]);
    for (const ballot of ballots) expect(await onDevice(ballot.record, ana)).toBe(false);
  });

  it('adds nothing back from an older copy of the log merged in, as an invite merge or a backup import would', async () => {
    const { fake, ana, closedAt } = await decidedTogether();
    const older = (await ana.group()).log;
    expect(leaves(older).some((bytes) => contains(bytes, utf8(ANA_NOTE)))).toBe(true);
    fake.minute = closedAt + WINDOW;
    await ana.sync.syncOnce();

    // #73's merge and #78's import go through applyPull, which drops what expired.
    await ana.store.applyPull(
      GROUP,
      {
        records: older,
        cursor: (await ana.group()).cursor,
        relayNow: fake.minute,
        instance: fake.instance,
        lastSyncAt: TS,
      },
      eventIdOf,
    );
    await clearExpiredBallots(ana.store, GROUP);

    expect(types((await ana.group()).log)).toEqual(['genesis', 'join', 'proposal', 'result']);
    expect(await onDevice(utf8(ANA_NOTE), ana)).toBe(false);
  });

  it('lets a device that reads the history from the relay afterwards fold the same Document, then clear what the relay still held', async () => {
    const { fake, relay, secret, ana, closedAt } = await decidedTogether();
    fake.minute = closedAt + WINDOW;
    await ana.sync.syncOnce();

    // A device that reads the group's history from the relay, which still holds the old blobs
    // here; app/actions.test.ts joins through a real invite envelope.
    const channel = channelOf(secret, weekOf(closedAt));
    const page = await relay.getBlobs(channel.mailbox, 0);
    const cal = await device('cal', relay, secret);
    await cal.store.applyPull(
      GROUP,
      {
        records: openRecords(xchachaSeal, channel, page.records),
        cursor: page.records.at(-1)?.seq ?? 0,
        relayNow: page.now,
        instance: page.instance,
        lastSyncAt: TS,
      },
      eventIdOf,
    );
    expect(foldGroup(await cal.group()).atoms).toEqual(foldGroup(await ana.group()).atoms);
    expect(await onDevice(utf8(BEN_NOTE), cal)).toBe(true);

    await cal.sync.syncOnce();

    const calState = foldGroup(await cal.group());
    expect(calState.atoms).toEqual(foldGroup(await ana.group()).atoms);
    expect(types((await cal.group()).log)).not.toContain('vote');
    expect(calState.proposals[0]?.cleared).toBe(true);
    expect(await onDevice(utf8(BEN_NOTE), cal)).toBe(false);
  });

  it('sends nothing new to the relay when it clears', async () => {
    const { fake, ana, closedAt, secret } = await decidedTogether();
    fake.minute = closedAt + WINDOW;
    const puts = fake.requests.filter((r) => r.method === 'PUT').length;
    await ana.sync.syncOnce();
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts);
    expect(fake.blobs(deriveWeekMailboxId(secret, weekOf(closedAt))).length).toBeGreaterThan(0);
  });
});

/** Only the service worker touches Cache Storage, and it never keeps anything from `/v1`. */
const SOURCES = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('Cache Storage', () => {
  it('is used only by the service worker, which caches the app’s own files and never the relay’s, and by Erase, which empties it (#78)', () => {
    const users = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter(([, text]) => /\bcaches\b/.test(text))
      .map(([path]) => path);
    expect(users).toEqual(['../net/serviceWorker.ts', './erase.ts']);
  });
});

function never(): never {
  throw new Error('Expected a Proposal.');
}

describe('resultsDue', () => {
  /** A group of Ana and Ben whose one Proposal both scored, closing it at the start. */
  function closed() {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana');
    log.vote('ana', proposalId, 3);
    log.vote('ben', proposalId, 4);
    return { state: log.state(), proposalId };
  }

  it('names a closed Proposal with no result once the relay is past its close', () => {
    const { state, proposalId } = closed();
    const me = { author: authorOf('ana'), name: 'Ana' };
    expect(resultsDue(state, { me, relayNow: START_MINUTE + 1 }).map((p) => p.id)).toEqual([
      proposalId,
    ]);
    expect(resultsDue(state, { me, relayNow: START_MINUTE })).toEqual([]);
  });

  it('names none for a device that isn’t a member, or is leaving, since nothing is queued after a leave (#77)', () => {
    const { state } = closed();
    const relayNow = START_MINUTE + 1;
    const kim = { author: authorOf('kim'), name: 'Kim' };
    expect(resultsDue(state, { me: kim, relayNow })).toEqual([]);
    const ana = { author: authorOf('ana'), name: 'Ana' };
    expect(resultsDue(state, { me: ana, relayNow, leaving: utf8('leave') })).toEqual([]);
  });

  it('names none whose result already waits in the outbox, so none is queued twice', () => {
    const { state, proposalId } = closed();
    const me = { author: authorOf('ana'), name: 'Ana' };
    const relayNow = START_MINUTE + 1;
    const due = resultsDue(state, { me, relayNow });
    const signingKey = testKeys('ana').secretKey;
    const outbox = signResults(state, { signingKey }, due, TS);
    expect(due.map((p) => p.id)).toEqual([proposalId]);
    expect(resultsDue(state, { me, relayNow, outbox })).toEqual([]);
  });

  it('names none once the group has dissolved (#108), since the fold takes nothing after its dissolve', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposal = log.propose('ana');
    log.vote('ana', proposal, 4);
    log.vote('ben', proposal, 4);
    const ending = log.proposeDissolve('ana', false);
    log.vote('ana', ending, 4);
    log.vote('ben', ending, 4);
    log.minute += 1;
    log.dissolve('ben', ending);
    const relayNow = log.minute + 1;
    const state = log.state(relayNow);
    expect(state.dissolved).not.toBeNull();
    const me = { author: authorOf('ana'), name: 'Ana' };
    expect(resultsDue(state, { me, relayNow })).toEqual([]);
    expect(resultsDue({ ...state, dissolved: null }, { me, relayNow })).toHaveLength(2);
  });

  it('names none in a coalition’s own log (#100), which takes no result, even for a motion it has decided', () => {
    const logs = new Logs();
    const at = logs.formed(START_MINUTE, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    logs.result(at + 1, 'kim', motion, 'A', 'fail');
    const relayNow = at + 2;
    const state = fold(logs.logs.coalition ?? [], relayNow);
    expect(state.proposals.find((p) => p.id === motion)).toMatchObject({ final: true });
    const me = { author: authorOf('kim'), name: 'kim' };
    expect(resultsDue(state, { me, relayNow })).toEqual([]);
    expect(resultsDue({ ...state, coalition: null }, { me, relayNow })).toHaveLength(1);
  });
});
