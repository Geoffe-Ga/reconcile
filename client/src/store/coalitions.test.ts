/**
 * A device's coalition entries (#114): one per coalition secret its groups
 * hold, and what the device queues for each after a pass. Logs are signed
 * and folded through the engine (`test/coalitions.ts`); each test keeps them
 * in a real store.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { roomCommit, seatKxOf, unwrapInner } from '../crypto/room';
import { verifySeatProof } from '../crypto/seat';
import { parseRecord, type ParsedEvent } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import {
  COALITION_STATEMENT,
  Logs,
  NESTED_STATEMENTS,
  NestedLogs,
  seatKey,
  seatSecret,
  testSecret,
} from '../test/coalitions';
import { sealSeatSecrets } from '../crypto/innerSeal';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import {
  coalitionKeys,
  ensureEntries,
  foldWithCoalitions,
  heldCoalitions,
  newEntry,
  outsideFor,
  retireCoalitionsOf,
  settleCoalitions,
  stillSyncs,
} from './coalitions';
import { type Group, openStore, type Store } from './db';
import { eventIdOf } from './eventId';

freshIndexedDBPerTest();

const R = 29_375_000;
const SECRET = fromBase64url(testSecret('coalition'));
const ENTRY = deriveCoalitionEntryId(SECRET);
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function device(name = 'device'): Promise<Store> {
  const store = await openStore(name);
  stores.push(store);
  return store;
}

/** Keeps `records` as group `groupId` on `store`, as `who`'s membership. */
async function keepGroup(
  store: Store,
  groupId: string,
  who: string,
  records: readonly LogRecord[],
) {
  const keys = testKeys(who);
  await store.addGroup({
    groupId,
    secret: new Uint8Array(32).fill(groupId.length),
    signingKey: keys.secretKey,
    me: { author: authorOf(who), name: who },
  });
  const pull = { records: [...records], relayNow: R + 100, instance: 'i', lastSyncAt: 1 };
  await store.applyPull(groupId, pull, eventIdOf);
}

/** Keeps the coalition's log as its entry on `store`, as `who`'s key, with `plan`, pulled at `relayNow`. */
async function keepEntry(
  store: Store,
  logs: Logs,
  who: string,
  plan: Partial<Pick<Group, 'joinAs' | 'admitting'>> & { name?: string } = {},
  relayNow = R + 100,
) {
  const { name = who, ...rest } = plan;
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: SECRET,
    signingKey: testKeys(who).secretKey,
    me: { author: authorOf(who), name },
    ...rest,
  });
  const records = logs.logs.coalition ?? [];
  if (records.length === 0) return;
  const pull = { records: [...records], relayNow, instance: 'i', lastSyncAt: 1 };
  await store.applyPull(ENTRY, pull, eventIdOf);
}

/** The events waiting in the entry's outbox. */
async function queued(store: Store): Promise<ParsedEvent[]> {
  const entry = await store.getGroup(ENTRY);
  return (entry?.outbox ?? []).flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

/** Group A (ana, ben), founded at R, with ana's reconcile Proposal for seat A, passed unless told. */
function groupA(logs: Logs, pass = true): string {
  const id = logs.group('A', R, ['ana', 'ben'], 'Riverside');
  const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ana', proposal, pass ? 4 : 0, pass ? undefined : 'No.');
  logs.vote('A', R + 5, 'ben', proposal, pass ? 4 : 0, pass ? undefined : 'No.');
  return id;
}

const clock = () => 1_762_650_000_000;

describe('ensureEntries', () => {
  it('keeps one entry per coalition secret its groups hold, in their logs or waiting to send', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);

    await ensureEntries(store);
    const [entry] = await store.listCoalitions();
    expect(await store.listCoalitions()).toHaveLength(1);
    expect(entry).toMatchObject({ kind: 'coalition', groupId: ENTRY, me: { name: '' } });
    expect(base64url(entry?.secret ?? new Uint8Array())).toBe(testSecret('coalition'));
    expect(entry?.me.author).not.toBe(authorOf('ana'));

    await ensureEntries(store);
    const [again] = await store.listCoalitions();
    expect(again?.signingKey).toEqual(entry?.signingKey);
    expect(await store.listGroups()).toHaveLength(1);
  });

  it('counts a reconcile Proposal still in a group’s outbox, and nothing else there', async () => {
    const store = await device();
    const logs = new Logs();
    const a = logs.group('A', R, ['ana'], 'Riverside');
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    const target = {
      kind: 'reconcile',
      secret: testSecret('coalition'),
      inner: testSecret('inner'),
      seat: base64url(new Uint8Array(32).fill(4)),
      ...COALITION_STATEMENT,
    } as const;
    const proposal = signedAs('ana', {
      type: 'proposal',
      group: a,
      ts: 0,
      body: { target, title: 'Reconcile', why: '' },
    });
    const vote = signedAs('ana', {
      type: 'vote',
      group: a,
      ts: 0,
      body: { proposal: 'x', scores: { x: 4 } },
    });
    await store.enqueueAll(a, [vote.record, Uint8Array.of(1, 2, 3), proposal.record]);

    await ensureEntries(store);
    expect((await store.listCoalitions()).map((e) => e.groupId)).toEqual([ENTRY]);
  });
});

describe('settleCoalitions', () => {
  it('joins under the planned group’s seat once the genesis names it, once', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.coalition(R + 10, ['A', 'B']);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'cal', { joinAs: a, name: 'Cal C.' });

    expect(await settleCoalitions(store, clock)).toEqual([ENTRY]);
    const [join] = await queued(store);
    expect(join?.event).toMatchObject({
      type: 'join',
      group: logs.ids.coalition,
      author: authorOf('cal'),
      body: { name: 'Cal C.', seat: seatKey('A') },
    });
    const body = join?.event.type === 'join' ? join.event.body : null;
    const proof = fromBase64url(body?.proof ?? '');
    const coalition = logs.ids.coalition ?? '';
    expect(
      verifySeatProof(
        fromBase64url(seatKey('A')),
        proof,
        coalition,
        fromBase64url(authorOf('cal')),
      ),
    ).toBe(true);
    expect((await store.getGroup(ENTRY))?.joinAs).toBeUndefined();
    expect(await settleCoalitions(store, clock)).toEqual([]);
  });

  it('waits to join until the person has a name there', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.coalition(R + 10, ['A', 'B']);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'cal', { joinAs: a, name: '' });

    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);
    expect((await store.getGroup(ENTRY))?.joinAs).toBe(a);
  });

  it('waits to join without a name, without a genesis that names the seat, or with a join queued', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.coalition(R + 10, ['B', 'C']);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'cal', { joinAs: a });

    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect((await store.getGroup(ENTRY))?.joinAs).toBe(a);
  });

  it('reports what the group owes for the seat its participant is bound to, once', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'kim', 'A');
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'kim');

    expect(await settleCoalitions(store, clock)).toEqual([ENTRY]);
    expect((await queued(store)).map(({ event }) => event.body)).toEqual([
      { motion: logs.ids.coalition, seat: seatKey('A'), result: 'pass' },
    ]);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toHaveLength(1);
  });

  it('reports nothing for a participant whose group isn’t on the device', async () => {
    const store = await device();
    const logs = new Logs();
    groupA(logs);
    logs.coalition(R + 10, ['A', 'B']);
    logs.join(R + 11, 'kim', 'A');
    await keepEntry(store, logs, 'kim');

    expect(await settleCoalitions(store, clock)).toEqual([]);
  });

  it('skips a coalition with no genesis yet, and one that was declined', async () => {
    const store = await device();
    const logs = new Logs();
    groupA(logs);
    await keepEntry(store, logs, 'kim', { joinAs: 'nowhere' });
    expect(await settleCoalitions(store, clock)).toEqual([]);

    const declined = await device('declined');
    const failed = new Logs();
    failed.coalition(R, ['A', 'B']);
    failed.join(R + 1, 'kim', 'A');
    failed.result(R + 2, 'kim', failed.ids.coalition ?? '', 'A', 'fail');
    await keepEntry(declined, failed, 'zed', { joinAs: 'nowhere' });
    expect(await settleCoalitions(declined, clock)).toEqual([]);
    const [entry] = await declined.listCoalitions();
    expect(entry !== undefined && stillSyncs(entry)).toBe(false);
  });
});

/** A formed coalition of A and B, and Elm Row (seat C), which asks in, with `dee` bringing it. */
async function admitting(pass: boolean | null) {
  const store = await device();
  const logs = new Logs();
  const at = logs.formed(R, ['A', 'B'], ['kim', 'zed']);
  const c = logs.group('C', at, ['dee'], 'Elm Row');
  const proposal = logs.reconcile('C', at + 1, 'dee', 'C');
  if (pass !== null)
    logs.vote('C', at + 2, 'dee', proposal, pass ? 4 : 0, pass ? undefined : 'No.');
  await keepGroup(store, c, 'dee', logs.logs.C ?? []);
  const plan = { group: c, proposal, title: 'Admit Elm Row', why: '' };
  await keepEntry(store, logs, 'hal', { admitting: plan, name: 'Hal' });
  return { store, logs, c };
}

describe('settleCoalitions admitting a group', () => {
  it('waits while the group’s own vote is open', async () => {
    const { store } = await admitting(null);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect((await store.getGroup(ENTRY))?.admitting).toBeDefined();
  });

  it('drops the plan once the group didn’t pass', async () => {
    const { store } = await admitting(false);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect((await store.getGroup(ENTRY))?.admitting).toBeUndefined();
    expect(await queued(store)).toEqual([]);
  });

  it('proposes admitting it with its seat’s proof once it passed, and plans to join under it', async () => {
    const { store, logs, c } = await admitting(true);
    expect(await settleCoalitions(store, clock)).toEqual([ENTRY]);

    const [admit] = await queued(store);
    expect(admit?.event).toMatchObject({
      type: 'proposal',
      author: authorOf('hal'),
      body: {
        target: {
          kind: 'admit',
          seat: { name: 'Elm Row', key: seatKey('C') },
          kx: seatKxOf(seatSecret('C')),
        },
        title: 'Admit Elm Row',
        why: '',
      },
    });
    const entry = await store.getGroup(ENTRY);
    expect(entry?.admitting).toBeUndefined();
    expect(entry?.joinAs).toBe(c);
    expect(logs.ids.coalition).toBeDefined();
  });
});

/**
 * A device in Riverside (A, with inner) whose coalition entry is kim's, bound
 * to seat A, after Elm Row (C) was admitted into the coalition of A and B,
 * whose genesis commits to `committed` (#371), with `more` added to the logs
 * first, pulled at `at` minutes past C's seat, on the device `name`.
 */
async function seatedWith(
  more: (logs: Logs, seated: number) => void = () => undefined,
  at = 1,
  name = 'device',
  committed = testSecret('inner'),
) {
  const store = await device(name);
  const logs = new Logs();
  const a = groupA(logs);
  const formed = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed'], committed);
  const seated = logs.admitted(formed, 'dee', 'C', 'Elm Row', [
    ['kim', 'A'],
    ['zed', 'B'],
  ]);
  more(logs, seated);
  await keepGroup(store, a, 'ana', logs.logs.A ?? []);
  await keepEntry(store, logs, 'kim', {}, seated + at);
  return { store, logs, seated };
}

/** The inner a queued wrap for seat `seat` opens to with that seat's secret, or null. */
function opened(event: ParsedEvent['event'] | undefined, coalitionId: string, seat: string) {
  if (event?.type !== 'room-wrap') return null;
  const place = { coalitionId, seat: event.body.seat, wrap: event.body.wrap };
  const commit = roomCommit(fromBase64url(testSecret('inner')));
  return unwrapInner({ ...place, seatSecret: seatSecret(seat), commit });
}

describe('settleCoalitions wrapping the room’s inner for an admitted seat (#313)', () => {
  it('wraps inner to the admitted seat’s kx from a participant whose group holds it, once', async () => {
    const { store, logs } = await seatedWith();
    expect(await settleCoalitions(store, clock)).toEqual([ENTRY]);

    const [wrap, ...more] = await queued(store);
    expect(more).toEqual([]);
    expect(wrap?.event).toMatchObject({
      type: 'room-wrap',
      author: authorOf('kim'),
      body: { seat: seatKey('C') },
    });
    const id = logs.ids.coalition ?? '';
    expect(opened(wrap?.event, id, 'C')).toEqual(fromBase64url(testSecret('inner')));
    expect(opened(wrap?.event, id, 'B')).toBeNull();
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toHaveLength(1);
  });

  it('wraps nothing before the seat is taken, while the pass on it can still be contested', async () => {
    const { store } = await seatedWith(undefined, -1);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);
  });

  it('wraps nothing once its own participant has, and still wraps when another of its seat or another seat has (#371)', async () => {
    const own = await seatedWith((logs, seated) => logs.wrap(seated + 1, 'kim', 'C'), 2);
    expect(await settleCoalitions(own.store, clock)).toEqual([]);

    // Ben's wrap, from kim's own seat, may hold a room of his own: kim's device can't open it to
    // check, so it wraps the one the genesis commits to all the same, which repairs a wrong one.
    const seatMate = await seatedWith(
      (logs, seated) => {
        logs.join(seated + 1, 'ben', 'A');
        logs.wrap(seated + 2, 'ben', 'C');
      },
      3,
      'seat-mate',
    );
    expect(await settleCoalitions(seatMate.store, clock)).toEqual([ENTRY]);
    expect((await queued(seatMate.store)).map(({ event }) => event.type)).toEqual(['room-wrap']);

    const other = await seatedWith((logs, seated) => logs.wrap(seated + 1, 'zed', 'C'), 2, 'other');
    expect(await settleCoalitions(other.store, clock)).toEqual([ENTRY]);
    expect((await queued(other.store)).map(({ event }) => event.type)).toEqual(['room-wrap']);
  });

  it('wraps nothing when the inner its group holds isn’t the one the genesis commits to, which no device takes (#371)', async () => {
    const { store } = await seatedWith(undefined, 1, 'device', testSecret('another-inner'));
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);
  });

  it('wraps nothing from the admitted group’s own participant, before or after it holds inner', async () => {
    const store = await device();
    const logs = new Logs();
    const formed = logs.formed(R, ['A', 'B'], ['kim', 'zed']);
    const c = logs.group('C', formed, ['dee'], 'Elm Row');
    const proposal = logs.reconcile('C', formed + 1, 'dee', 'C', { inner: false });
    logs.vote('C', formed + 2, 'dee', proposal, 4);
    const seated = logs.admitted(formed + 3, 'dee', 'C', 'Elm Row', [
      ['kim', 'A'],
      ['zed', 'B'],
    ]);
    logs.join(seated + 1, 'dee', 'C');
    await keepGroup(store, c, 'dee', logs.logs.C ?? []);
    await keepEntry(store, logs, 'dee', {}, seated + 2);

    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);

    // Once kim's wrap gives Elm Row inner, its device still wraps nothing for its own seat.
    logs.wrap(seated + 3, 'kim', 'C');
    const pull = { records: [...(logs.logs.coalition ?? [])], relayNow: seated + 4 };
    await store.applyPull(ENTRY, { ...pull, instance: 'i', lastSyncAt: 1 }, eventIdOf);
    expect((await heldCoalitions(store))[0]?.state.coalition?.wraps).toHaveLength(1);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);
  });
});

describe('folding a group with its coalitions', () => {
  it('opens the motions its seat decides, and none for a group without a seat', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'kim');
    await keepEntry(store, logs, 'kim');
    const coalitions = await heldCoalitions(store);
    const records = logs.logs.A ?? [];

    expect(
      foldWithCoalitions({ log: records, relayNow: at + 1 }, coalitions).proposals.map((p) => p.id),
    ).toContain(motion);
    expect(outsideFor(fold([], null), coalitions)).toEqual([]);
    expect(foldWithCoalitions({ log: records, relayNow: at + 1 }, [])).toEqual(
      fold(records, at + 1),
    );
    expect(a).toBe(fold(records, null).group);
  });

  it('syncs every group, and a coalition until it was declined', () => {
    const group = { log: [], relayNow: null } as unknown as Group;
    expect(stillSyncs(group)).toBe(true);
    expect(stillSyncs({ ...group, kind: 'coalition' })).toBe(true);
  });

  it('makes a fresh key and the derived id for a new entry, with no name unless planned', () => {
    const entry = newEntry(SECRET);
    expect(entry).toMatchObject({ kind: 'coalition', groupId: ENTRY, me: { name: '' } });
    expect(newEntry(SECRET, { name: 'Ana', joinAs: 'g' })).toMatchObject({
      me: { name: 'Ana' },
      joinAs: 'g',
    });
    expect(newEntry(SECRET).signingKey).not.toEqual(entry.signingKey);
  });
});

describe('a coalition entry’s plan in the store', () => {
  it('sets and clears the name, the group to join under and an admission, in one change each', async () => {
    const store = await device();
    await store.addGroup(newEntry(SECRET));
    const heard: string[] = [];
    store.subscribe((id) => heard.push(id));
    const admit = { group: 'g', proposal: 'p', title: 'Admit Elm Row', why: '' };

    await store.planCoalition(ENTRY, { name: 'Ana', joinAs: 'g', admitting: admit });
    expect(await store.getGroup(ENTRY)).toMatchObject({
      me: { name: 'Ana' },
      joinAs: 'g',
      admitting: admit,
    });
    await store.planCoalition(ENTRY, {});
    expect(await store.getGroup(ENTRY)).toMatchObject({ me: { name: 'Ana' }, joinAs: 'g' });
    await store.planCoalition(ENTRY, { joinAs: null, admitting: null });
    const entry = await store.getGroup(ENTRY);
    expect(entry?.joinAs).toBeUndefined();
    expect(entry?.admitting).toBeUndefined();
    expect(heard).toEqual([ENTRY, ENTRY, ENTRY]);
  });

  it('refuses a group’s record, which has no plan', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);

    await expect(store.planCoalition(a, { name: 'Ana' })).rejects.toThrow('coalition');
    expect((await store.getGroup(a))?.me.name).toBe('ana');
  });
});

describe('a group whose ballots have expired (#111)', () => {
  it('folds with its cleared Proposals beside the coalition’s motions', async () => {
    const store = await device();
    const logs = new Logs();
    groupA(logs);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'kim');
    await keepEntry(store, logs, 'kim');
    const coalitions = await heldCoalitions(store);
    const records = logs.logs.A ?? [];
    const reconcile = fold(records, null).proposals[0]?.id ?? '';

    const kept = foldWithCoalitions({ log: records, relayNow: at + 1 }, coalitions);
    const cleared = foldWithCoalitions(
      { log: records, relayNow: at + 1, cleared: [reconcile] },
      coalitions,
    );
    expect(cleared.proposals.find((p) => p.id === reconcile)?.cleared).toBe(true);
    expect(kept.proposals.find((p) => p.id === reconcile)?.cleared).toBe(false);
    expect(cleared.coalitions.map((c) => c.key)).toEqual(kept.coalitions.map((c) => c.key));
    expect(cleared.proposals.map((p) => p.id)).toContain(motion);
  });
});

describe('coalitionKeys (#122)', () => {
  const STATEMENT_D = {
    name: 'Metro Renters',
    title: 'Shared ground',
    atoms: ['Rent stays fair.'],
  };

  /** Group A's log, reconciling into C, and C's log, formed, with its sealed motion into D. */
  function nestedLogs(seat = 'C') {
    const logs = new NestedLogs();
    logs.group('A', R, ['ana']);
    logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', COALITION_STATEMENT);
    logs.formedIn('C', R + 2, [['A'], ['B']], ['cal', 'dee']);
    const into = logs.sealedInto('C', R + 6, 'cal', 'D', STATEMENT_D);
    return { logs, into, seat };
  }

  /** Group A and coalition C as a device keeps them, the entry's id derived from C's secret. */
  function asGroups(logs: NestedLogs) {
    const group = { groupId: 'A', log: logs.logs.A ?? [], outbox: [], relayNow: R + 10 };
    const secret = fromBase64url(testSecret('C'));
    const entry = {
      kind: 'coalition' as const,
      groupId: deriveCoalitionEntryId(secret),
      secret,
      log: logs.logs.C ?? [],
      outbox: [],
      relayNow: R + 10,
    };
    return { group: group as unknown as Group, entry: entry as unknown as Group };
  }

  it('opens a coalition’s sealed seat above under the inner a group’s target carries', () => {
    const { logs, into } = nestedLogs();
    const { group, entry } = asGroups(logs);
    const keys = coalitionKeys([group], [entry]);
    const c = keys.get(entry.groupId);
    expect(c?.from).toEqual([{ holder: 'A', proposal: expect.any(String) as string }]);
    expect([...(c?.seats.keys() ?? [])]).toEqual([seatKey('A')]);
    const d = keys.get(deriveCoalitionEntryId(fromBase64url(testSecret('D'))));
    expect(d?.from).toEqual([{ holder: entry.groupId, proposal: into }]);
    expect(base64url(d?.inner ?? new Uint8Array())).toBe(testSecret('innerD'));
    expect([...(d?.seats.keys() ?? [])]).toEqual([seatKey('C')]);
  });

  it('opens nothing for a coalition whose inner no group on the device holds, as a follower’s', () => {
    const { logs } = nestedLogs();
    const { entry } = asGroups(logs);
    expect(coalitionKeys([], [entry]).size).toBe(0);
  });

  it('leaves out a sealed seat whose secret doesn’t make the key its motion states', () => {
    const logs = new NestedLogs();
    logs.group('A', R, ['ana']);
    logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', COALITION_STATEMENT);
    logs.formedIn('C', R + 2, [['A'], ['B']], ['cal', 'dee']);
    const sealed = sealSeatSecrets(logs.ids.C ?? '', fromBase64url(testSecret('innerC')), {
      secret: fromBase64url(testSecret('D')),
      inner: fromBase64url(testSecret('innerD')),
      seat: seatSecret('X'),
    });
    const target = { kind: 'reconcile', sealed, key: seatKey('C'), ...STATEMENT_D } as const;
    logs.add('C', R + 6, 'cal', { type: 'proposal', body: { target, title: 'Into D', why: 'W' } });
    const { group, entry } = asGroups(logs);
    const keys = coalitionKeys([group], [entry]);
    expect(keys.has(deriveCoalitionEntryId(fromBase64url(testSecret('D'))))).toBe(false);
    expect(keys.has(entry.groupId)).toBe(true);
  });

  /** A log as a device keeps it: a group's, or a coalition's entry under the id its secret makes. */
  function kept(records: readonly LogRecord[], relayNow: number, secret?: string): Group {
    const coalition =
      secret === undefined
        ? { groupId: 'A' }
        : { kind: 'coalition', groupId: deriveCoalitionEntryId(fromBase64url(secret)) };
    return { ...coalition, log: records, outbox: [], relayNow } as unknown as Group;
  }

  it('gives a group admitted into a formed coalition its inner only from a wrap for its seat, and then reaches above it (#313)', () => {
    const logs = new NestedLogs();
    const formed = logs.formed(R, ['X', 'Y'], ['cal', 'dee']);
    logs.group('A', formed, ['ana']);
    logs.reconcile('A', formed + 1, 'ana', 'A', { inner: false });
    const seated = logs.admitted(formed + 2, 'ana', 'A', 'Riverside', [
      ['cal', 'X'],
      ['dee', 'Y'],
    ]);
    const id = logs.ids.coalition ?? '';
    const sealed = sealSeatSecrets(id, fromBase64url(testSecret('inner')), {
      secret: fromBase64url(testSecret('D')),
      inner: fromBase64url(testSecret('innerD')),
      seat: seatSecret('coalition'),
    });
    const target = {
      kind: 'reconcile',
      sealed,
      key: seatKey('coalition'),
      ...STATEMENT_D,
    } as const;
    logs.add('coalition', seated + 1, 'cal', {
      type: 'proposal',
      body: { target, title: 'Into D', why: 'W' },
    });
    const d = deriveCoalitionEntryId(fromBase64url(testSecret('D')));
    const keysAt = () =>
      coalitionKeys(
        [kept(logs.logs.A ?? [], seated + 10)],
        [kept(logs.logs.coalition ?? [], seated + 10, testSecret('coalition'))],
      );

    const before = keysAt();
    expect([...(before.get(ENTRY)?.seats.keys() ?? [])]).toEqual([seatKey('A')]);
    expect(before.get(ENTRY)?.inner).toBeNull();
    expect(before.has(d)).toBe(false);

    logs.wrap(seated + 2, 'cal', 'A');
    const after = keysAt();
    expect(base64url(after.get(ENTRY)?.inner ?? new Uint8Array())).toBe(testSecret('inner'));
    expect(base64url(after.get(d)?.inner ?? new Uint8Array())).toBe(testSecret('innerD'));
  });

  it('keeps a coalition above with no inner while its seat there, sealed without one, waits for a wrap (#313)', () => {
    const logs = new NestedLogs();
    logs.group('A', R, ['ana']);
    logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', COALITION_STATEMENT);
    const c = logs.formedIn('C', R + 2, [['A'], ['B']], ['cal', 'dee']);
    const sealed = sealSeatSecrets(logs.ids.C ?? '', fromBase64url(testSecret('innerC')), {
      secret: SECRET,
      seat: seatSecret('C'),
    });
    const target = {
      kind: 'reconcile',
      sealed,
      key: seatKey('C'),
      ...COALITION_STATEMENT,
    } as const;
    logs.add('C', c, 'cal', { type: 'proposal', body: { target, title: 'Into D', why: 'W' } });
    const formed = logs.formed(c + 1, ['X', 'Y'], ['kim', 'zed']);
    const seated = logs.admitted(formed, 'cal', 'C', 'Eastside', [
      ['kim', 'X'],
      ['zed', 'Y'],
    ]);
    const keysAt = () =>
      coalitionKeys(
        [kept(logs.logs.A ?? [], seated + 10)],
        [
          kept(logs.logs.C ?? [], seated + 10, testSecret('C')),
          kept(logs.logs.coalition ?? [], seated + 10, testSecret('coalition')),
        ],
      );

    const before = keysAt().get(ENTRY);
    expect([...(before?.seats.keys() ?? [])]).toEqual([seatKey('C')]);
    expect(before?.inner).toBeNull();

    // A wrap whose inner the coalition's genesis doesn't commit to opens, and gives nothing (#371).
    logs.wrap(
      seated + 1,
      'zed',
      'C',
      logs.wrapFor('C', logs.ids.coalition, testSecret('zed-room')),
    );
    expect(keysAt().get(ENTRY)?.inner).toBeNull();

    logs.wrap(seated + 2, 'kim', 'C');
    const after = keysAt().get(ENTRY);
    expect(base64url(after?.inner ?? new Uint8Array())).toBe(testSecret('inner'));
  });
});

describe('retiring the coalitions a removed group alone held (#115, #122)', () => {
  /** Keeps the coalition `name`'s entry on `store`, with `records` as its log. */
  async function keepCoalition(store: Store, name: string, records: readonly LogRecord[]) {
    const secret = fromBase64url(testSecret(name));
    const groupId = deriveCoalitionEntryId(secret);
    await store.addGroup({
      kind: 'coalition',
      groupId,
      secret,
      signingKey: testKeys('cal').secretKey,
      me: { author: authorOf('cal'), name: 'cal' },
    });
    if (records.length > 0) {
      const pull = { records: [...records], relayNow: R + 100, instance: 'i', lastSyncAt: 1 };
      await store.applyPull(groupId, pull, eventIdOf);
    }
    return groupId;
  }

  /**
   * Group A in Eastside Housing (C), C formed with its sealed seat in Metro
   * Renters (D), and both coalitions' entries on `store`; and group B in C
   * too, its target carrying C's inner or not, as `b` says. Returns the
   * entries' ids.
   */
  async function nestedOn(store: Store, b: 'none' | 'inner' | 'no-inner') {
    const logs = new NestedLogs();
    logs.group('A', R, ['ana']);
    logs.reconcileInto('A', R + 1, 'ana', 'C', 'A', NESTED_STATEMENTS.C);
    await keepGroup(store, 'A', 'ana', logs.logs.A ?? []);
    if (b !== 'none') {
      logs.group('B', R, ['ana']);
      const target = {
        kind: 'reconcile',
        secret: testSecret('C'),
        seat: base64url(seatSecret('B')),
        ...NESTED_STATEMENTS.C,
        ...(b === 'inner' ? { inner: testSecret('innerC') } : {}),
      } as const;
      logs.add('B', R + 1, 'ana', { type: 'proposal', body: { target, title: 'In', why: 'W' } });
      await keepGroup(store, 'B', 'ana', logs.logs.B ?? []);
    }
    const at = logs.formedIn('C', R + 2, [['A'], ['B']], ['cal', 'dee'], NESTED_STATEMENTS.C);
    logs.sealedInto('C', at, 'cal', 'D', NESTED_STATEMENTS.D);
    const c = await keepCoalition(store, 'C', logs.logs.C ?? []);
    const d = await keepCoalition(store, 'D', []);
    return { c, d };
  }

  /** Removes group A from `store`'s member, as `settleRemoval` does, and retires what it alone held. */
  async function removeA(store: Store) {
    const removed = await store.getGroup('A');
    if (removed === undefined) throw new Error('Expected group A.');
    await store.markArchived('A', 'removed');
    await retireCoalitionsOf(store, removed);
  }

  it('retires the coalitions above that only its coalitions reached, as well as its own', async () => {
    const store = await device();
    const { c, d } = await nestedOn(store, 'none');
    await removeA(store);
    expect((await store.getGroup(c))?.archived).toEqual({ reason: 'removed' });
    expect((await store.getGroup(d))?.archived).toEqual({ reason: 'removed' });
  });

  it('keeps every coalition another group on the device still reaches, above it included', async () => {
    const store = await device();
    const { c, d } = await nestedOn(store, 'inner');
    await removeA(store);
    expect((await store.getGroup(c))?.archived).toBeUndefined();
    expect((await store.getGroup(d))?.archived).toBeUndefined();
  });

  it('keeps a coalition above one another group still holds, though it holds no inner there yet (#313)', async () => {
    const store = await device();
    const { c, d } = await nestedOn(store, 'no-inner');
    await removeA(store);
    // B reaches D again once a wrap gives it C's inner, so D's entry stays to sync then.
    expect((await store.getGroup(c))?.archived).toBeUndefined();
    expect((await store.getGroup(d))?.archived).toBeUndefined();
  });
});
