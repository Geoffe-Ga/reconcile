/**
 * No forged result survives clearing (#268, from #111's review).
 *
 * The threat: a Member, who holds only `read`, posts a fabricated `result`
 * right after a Proposal opens. Once a device clears the Proposal's ballots,
 * the fold reads the first `result` after the Proposal, in relay order, as
 * its record (`firstResults` in engine/fold.ts). So a forgery that outlived
 * clearing would become the permanent outcome.
 *
 * Two guards in two files stop it, and these tests pin both:
 * - While the ballots are held, the fold takes only a result that arrives
 *   after the close and matches them (`heldResultCounts`, `matchesBallots`),
 *   and clearing keeps exactly that one (`expiredBallots`), deleting every
 *   other result for the Proposal from the log and the outbox in the same
 *   change (`clearIn` in db.ts).
 * - Once cleared, every ingest drops a result for the Proposal while the log
 *   holds one: a pull and an invite's merge (`withoutCleared`), and a backup
 *   file's, a link's and the relay backup's restore (`keptCopy`). The invite
 *   merge runs through the app in app/actions.test.ts.
 *
 * Each test checks the cleared log against the fold with the forgery left
 * in, so it can't pass on a forgery the fold would ignore anyway.
 */
import { describe, expect, it } from 'vitest';

import { createRelay } from '../net/relay';
import { parseRecord } from '../engine/event';
import {
  fold,
  type GroupState,
  type LogRecord,
  type Proposal,
  proposalTally,
} from '../engine/fold';
import { createFakeRelay } from '../test/fakeRelay';
import {
  type Forger,
  type Forgery,
  type ForgedLog,
  forgedLog,
  keepLog,
  type ReadAt,
  RELAY_INSTANCE,
} from '../test/forgedResult';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, testKeys } from '../test/keys';
import { containsBytes, scanDb } from '../test/scanDb';
import { type Group, openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import { clearExpiredBallots, foldGroup } from './expiry';
import { fetchRelayBackup, startRelayBackup } from './relayBackup';
import { exportGroups, importGroups, importSnapshot, takeSnapshot } from './snapshot';

freshIndexedDBPerTest();

/** 30 days in relay minutes: `ballotExpiryDays` × 1,440. */
const WINDOW = 43_200;
const SYNCED_AT = 1_762_650_000_000;
/** A cheap scrypt cost, N = 2^4, for a backup file. */
const CHEAP = 4;
const PASSPHRASE = 'a long walk to the river';
/** Ana's Proposal's text, which her group adopts. */
const PASSED_TEXT = 'Quiet after 11pm.';

/** The group on `store`. */
async function groupOn(store: Store, groupId: string): Promise<Group> {
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  return group;
}

/** The Proposal `id` in a folded state. */
function proposalIn(state: GroupState, id: string): Proposal {
  const found = state.proposals.find((proposal) => proposal.id === id);
  if (found === undefined) throw new Error('Expected the Proposal.');
  return found;
}

/** The type of each event in a log. */
function types(log: readonly LogRecord[]): string[] {
  return log.map((record) => parseRecord(record.bytes)?.event.type ?? '?');
}

/** The event id of each `result` in a log. */
function resultIds(log: readonly LogRecord[]): string[] {
  return log.flatMap((record) => {
    const parsed = parseRecord(record.bytes);
    return parsed?.event.type === 'result' ? [parsed.id] : [];
  });
}

/** `log` with `record` back in its place in relay order. */
function withRecord(log: readonly LogRecord[], record: LogRecord): LogRecord[] {
  return [...log, record].sort((a, b) => a.seq - b.seq);
}

/** Where a device's copy stands: read past the window, so its ballots are due to clear. */
function expired(forged: ForgedLog, lastSyncAt = SYNCED_AT): ReadAt {
  return { relayNow: forged.closedAt + WINDOW, lastSyncAt };
}

/** Ana's device, holding the log, cleared as its sync pass would clear it. */
async function clearedDevice(forged: ForgedLog): Promise<Store> {
  const store = await openStore('ana');
  await keepLog(store, forged, 'ana', expired(forged));
  expect(await clearExpiredBallots(store, forged.group)).toEqual([forged.proposal]);
  return store;
}

/**
 * Checks that the device `name` holds the cleared log, with the genuine
 * result its one result and no ballot, the forgery nowhere in its database,
 * and that the cleared fold reads the genuine outcome, which it wouldn't with
 * the forgery left in.
 */
async function expectGenuineOnly(store: Store, name: string, forged: ForgedLog): Promise<void> {
  const { group: groupId, proposal, genuine } = forged;
  const group = await groupOn(store, groupId);
  expect(group.cleared).toEqual([proposal]);
  expect(types(group.log)).toEqual(['genesis', 'join', 'join', 'proposal', 'result']);
  expect(resultIds(group.log)).toEqual([genuine.id]);
  expect(group.outbox).toEqual([]);
  expect(containsBytes((await scanDb(name)).bytes, forged.forged.record.bytes)).toBe(false);
  const state = foldGroup(group);
  const read = proposalIn(state, proposal);
  expect(read).toMatchObject({ cleared: true, final: true, closedAt: forged.closedAt });
  expect(read.result?.id).toBe(genuine.id);
  expect(read.outcome).toMatchObject({ kind: 'pass', version: proposal });
  expect(state.atoms[0]?.text).toBe(PASSED_TEXT);

  // Left in, the forgery would decide it: read ahead as its record, or, for a premature one,
  // which can't be a record, leaving it none, so it would lapse.
  const leftIn = fold(withRecord(group.log, forged.forged.record), group.relayNow, [], [proposal]);
  const premature = forged.forgery === 'premature';
  expect(proposalIn(leftIn, proposal).result?.id ?? null).toBe(premature ? null : forged.forged.id);
  expect(proposalIn(leftIn, proposal).outcome.kind).toBe(premature ? 'lapse' : 'fail');
}

/** Each forgery, by whom, as the table's title names it. */
const FORGERIES: readonly (readonly [string, Forger, Forgery])[] = [
  ['a Member’s invented result, a minute after it opens', 'cal', 'invented'],
  ['a Member’s premature result, matching the ballots before any was cast', 'cal', 'premature'],
  ['a Member’s result after the close, with counts the ballots don’t give', 'cal', 'mismatched'],
  ['a voter’s invented result, a minute after it opens', 'ben', 'invented'],
  ['a voter’s premature result, matching the ballots before any was cast', 'ben', 'premature'],
  ['a voter’s result after the close, with counts the ballots don’t give', 'ben', 'mismatched'],
];

describe('a forged result and clearing (#268)', () => {
  it.each(FORGERIES)(
    '%s: only the result the ballots give survives, from the log and the outbox, and decides it',
    async (_title, forger, forgery) => {
      const forged = forgedLog(forger, forgery);
      const { group: groupId, proposal, genuine } = forged;
      // The forger's own device, where a copy of the forgery still waits to be sent.
      const store = await openStore(forger);
      await keepLog(store, forged, forger, expired(forged));
      await store.enqueue(groupId, forged.forged.record.bytes);
      const kept = await groupOn(store, groupId);
      expect(resultIds(kept.log)).toEqual([forged.forged.id, genuine.id]);
      const held = foldGroup(kept);
      const before = proposalIn(held, proposal);
      expect(before.result?.id).toBe(genuine.id);
      expect(before.outcome).toMatchObject({ kind: 'pass', version: proposal });
      expect(before.mismatched).toEqual(forgery === 'mismatched' ? [authorOf(forger)] : []);
      expect(held.atoms[0]?.text).toBe(PASSED_TEXT);

      expect(await clearExpiredBallots(store, groupId)).toEqual([proposal]);

      await expectGenuineOnly(store, forger, forged);
      const after = proposalIn(foldGroup(await groupOn(store, groupId)), proposal);
      expect(after).toMatchObject({ ballots: [], mismatched: [] });
      expect(after.result?.closedAt).toBe(before.result?.closedAt);
      expect(proposalTally(after)).toEqual(proposalTally(before));
    },
  );
});

describe('a forged early result arriving after clearing (#268)', () => {
  it.each([
    ['the same relay, in its place before the genuine result', RELAY_INSTANCE],
    ['a fresh relay database, which reads every mailbox from its start', 'relay-2'],
  ])('is dropped by a pull from %s', async (_title, instance) => {
    const forged = forgedLog();
    const store = await clearedDevice(forged);
    const group = await groupOn(store, forged.group);

    await store.applyPull(
      forged.group,
      {
        records: [...forged.records],
        cursor: group.cursor,
        relayNow: group.relayNow ?? 0,
        instance,
        lastSyncAt: SYNCED_AT + 1,
      },
      eventIdOf,
    );

    await expectGenuineOnly(store, 'ana', forged);
  });

  it('is dropped by a newcomer’s pull, once their invite has handed them the result the inviter kept', async () => {
    const forged = forgedLog();
    const inviter = await groupOn(await clearedDevice(forged), forged.group);
    const store = await openStore('dee');
    const { secretKey, author } = testKeys('dee');
    await store.addGroup({
      groupId: forged.group,
      secret: inviter.secret,
      signingKey: secretKey,
      me: { author, name: 'dee' },
      cleared: [forged.proposal],
    });
    const at = { relayNow: inviter.relayNow ?? 0, instance: RELAY_INSTANCE, lastSyncAt: SYNCED_AT };
    await store.applyPull(
      forged.group,
      { ...at, records: inviter.log, cursor: inviter.cursor },
      eventIdOf,
    );

    await store.applyPull(
      forged.group,
      { ...at, records: [forged.forged.record], cursor: inviter.cursor },
      eventIdOf,
    );

    await expectGenuineOnly(store, 'dee', forged);
  });

  /** How a copy of the group from Ana's other device, synced later, reaches this one. */
  const RESTORES: readonly (readonly [string, (from: Store, to: Store) => Promise<unknown>])[] = [
    [
      'a backup file’s restore (#78)',
      async (from, to) => {
        const { file } = await exportGroups(from, PASSPHRASE, CHEAP);
        return importGroups(to, file, PASSPHRASE);
      },
    ],
    [
      'a link’s import (#96)',
      async (from, to) => importSnapshot(to, (await takeSnapshot(from, 'link')).plaintext, 'link'),
    ],
    [
      'the relay backup’s restore (#97)',
      async (from, to) => {
        const relay = createRelay({ fetch: createFakeRelay().fetch });
        await startRelayBackup({ store: from, relay, now: () => SYNCED_AT });
        const key = (await from.getRelayBackup())?.key ?? new Uint8Array();
        const plaintext = await fetchRelayBackup(relay, key);
        if (plaintext === null) throw new Error('Expected the relay backup.');
        return importSnapshot(to, plaintext);
      },
    ],
  ];

  it.each(RESTORES)(
    'is dropped by %s, whose later copy still holds it and the ballots',
    async (_title, restore) => {
      const forged = forgedLog();
      const store = await clearedDevice(forged);
      const other = await openStore('ana-laptop');
      await keepLog(other, forged, 'ana', expired(forged, SYNCED_AT + 60_000));
      expect(resultIds((await groupOn(other, forged.group)).log)).toContain(forged.forged.id);

      await restore(other, store);

      expect((await groupOn(store, forged.group)).lastSyncAt).toBe(SYNCED_AT + 60_000);
      await expectGenuineOnly(store, 'ana', forged);
    },
  );
});
