/**
 * A device's coalition entries (#114): one per coalition secret its groups
 * hold, and what the device queues for each after a pass. Logs are signed
 * and folded through the engine (`test/coalitions.ts`); each test keeps them
 * in a real store.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { seatKxOf, unwrapInner } from '../crypto/room';
import { verifySeatProof } from '../crypto/seat';
import { parseRecord, type ParsedEvent } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import { COALITION_STATEMENT, Logs, seatKey, seatSecret, testSecret } from '../test/coalitions';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import {
  ensureEntries,
  foldWithCoalitions,
  heldCoalitions,
  newEntry,
  outsideFor,
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
 * to seat A, after Elm Row (C) was admitted into the coalition of A and B, with
 * `more` added to the logs first, pulled at `at` minutes past C's seat, on the
 * device `name`.
 */
async function seatedWith(
  more: (logs: Logs, seated: number) => void = () => undefined,
  at = 1,
  name = 'device',
) {
  const store = await device(name);
  const logs = new Logs();
  const a = groupA(logs);
  const formed = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
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
  return unwrapInner({ ...place, seatSecret: seatSecret(seat) });
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

  it('wraps nothing once someone from its own seat has, and still wraps when only another seat has', async () => {
    const own = await seatedWith((logs, seated) => {
      logs.join(seated + 1, 'ben', 'A');
      logs.wrap(seated + 2, 'ben', 'C');
    }, 3);
    expect(await settleCoalitions(own.store, clock)).toEqual([]);

    const other = await seatedWith((logs, seated) => logs.wrap(seated + 1, 'zed', 'C'), 2, 'other');
    expect(await settleCoalitions(other.store, clock)).toEqual([ENTRY]);
    expect((await queued(other.store)).map(({ event }) => event.type)).toEqual(['room-wrap']);
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
