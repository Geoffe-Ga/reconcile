/**
 * A device's coalition entries (#114): one per coalition secret its groups
 * hold, and what the device queues for each after a pass. Logs are signed
 * and folded through the engine (`test/coalitions.ts`); each test keeps them
 * in a real store.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { verifySeatProof } from '../crypto/seat';
import { parseRecord, type ParsedEvent } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import {
  COALITION_STATEMENT,
  Logs,
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

/** Keeps the coalition's log as its entry on `store`, as `who`'s key, with `plan`. */
async function keepEntry(
  store: Store,
  logs: Logs,
  who: string,
  plan: Partial<Pick<Group, 'joinAs' | 'admitting'>> & { name?: string } = {},
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
  const pull = { records: [...records], relayNow: R + 100, instance: 'i', lastSyncAt: 1 };
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

  it('posts the promotion record its group owes for the seat its participant is bound to, once (#126)', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.formed(R + 10, ['A', 'B'], ['kim', 'dee']);
    const words = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };
    const p = logs.dispatchVote('A', R + 20, 'ana', 1, words);
    logs.vote('A', R + 21, 'ana', p, 4);
    logs.vote('A', R + 21, 'ben', p, 4, 'canary-note');
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'kim');

    expect(await settleCoalitions(store, clock)).toEqual([ENTRY]);
    const posted = (await queued(store)).map(({ event }) => event);
    expect(posted).toEqual([
      expect.objectContaining({
        type: 'proposal',
        group: logs.ids.coalition,
        author: authorOf('kim'),
        body: {
          target: {
            kind: 'promote',
            dispatch: { id: p, ...words },
            ceiling: 1,
            level: 1,
            from: seatKey('A'),
          },
          title: words.title,
          why: '',
        },
      }),
    ]);
    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toHaveLength(1);
  });

  it('posts no promotion record for a Dispatch the group is still voting on (#126)', async () => {
    const store = await device();
    const logs = new Logs();
    const a = groupA(logs);
    logs.formed(R + 10, ['A', 'B'], ['kim', 'dee']);
    const p = logs.dispatchVote('A', R + 20, 'ana', 1, { title: 'Rally', text: '' });
    logs.vote('A', R + 21, 'ana', p, 4);
    await keepGroup(store, a, 'ana', logs.logs.A ?? []);
    await keepEntry(store, logs, 'kim');

    expect(await settleCoalitions(store, clock)).toEqual([]);
    expect(await queued(store)).toEqual([]);
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
        target: { kind: 'admit', seat: { name: 'Elm Row', key: seatKey('C') } },
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
});
