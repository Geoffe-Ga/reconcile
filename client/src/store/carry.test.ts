/**
 * Carried scores (#126; ADR-0037, ADR-0065): a device carries its person's
 * score on a Dispatch to a promotion motion in another group they're
 * eligible in, cast under their identity there at a random relay minute in
 * the rest of the window, never with a note, and never a 0 on its own. Logs
 * are signed and folded through the engine (`test/coalitions.ts`); each test
 * keeps them in a real store, with the relay's clock and the random bytes
 * injected.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { type Ceiling, parseRecord, type ParsedEvent } from '../engine/event';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import type { LogRecord } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { Logs, seatKey, testSecret } from '../test/coalitions';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, testKeys } from '../test/keys';
import { findCanaries, textCanary } from '../test/scan';
import {
  copiedNote,
  KEEP_DAYS,
  notesElsewhere,
  type Random,
  scheduleCarried,
  settleCarries,
  skipCarry,
} from './carry';
import { holdings } from './coalitions';
import { openStore, type Store } from './db';
import { eventIdOf } from './eventId';

freshIndexedDBPerTest();

const R = 29_375_000;
const ENTRY = deriveCoalitionEntryId(fromBase64url(testSecret('coalition')));
const WINDOW = 7 * DAY_MINUTES;
const clock = () => 1_762_650_000_000;
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Random bytes that read as `value`, big-endian, in the 6 bytes a draw takes. */
function bytesOf(value: number): Uint8Array {
  const bytes = new Uint8Array(6);
  let rest = value;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/** A source that gives `value`'s bytes, and records each length asked for. */
function fixed(value: number): Random & { readonly asked: number[] } {
  const asked: number[] = [];
  const random = (length: number) => {
    asked.push(length);
    return bytesOf(value).slice(0, length);
  };
  return Object.assign(random, { asked });
}

describe('scheduleCarried', () => {
  it('draws the issue’s example: 4,211 minutes into a window from 29,870,000 to 29,880,080', () => {
    const random = fixed(4_211);
    const carry = { dispatchId: 'd', score: 3, from: 29_870_000, deadline: 29_880_080 } as const;
    expect(scheduleCarried(carry, random)).toEqual({ castAt: 29_874_211 });
    expect(random.asked).toEqual([6]);
  });

  it('reads 48 bits, so a draw past the window wraps into it: every minute is about as likely', () => {
    const carry = { dispatchId: 'd', score: 3, from: 100, deadline: 110 } as const;
    expect(scheduleCarried(carry, fixed(2 ** 48 - 1))).toEqual({
      castAt: 100 + ((2 ** 48 - 1) % 10),
    });
    expect(scheduleCarried(carry, fixed(0))).toEqual({ castAt: 100 });
    expect(scheduleCarried(carry, fixed(19))).toEqual({ castAt: 109 });
  });

  it('draws a minute from `from` up to, but never at, the deadline, whatever the bytes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 1 }),
        fc.integer({ min: 29_000_000, max: 30_000_000 }),
        fc.integer({ min: 1, max: 28 * DAY_MINUTES }),
        (value, from, span) => {
          const { castAt } = scheduleCarried(
            { dispatchId: 'd', score: 2, from, deadline: from + span },
            fixed(value),
          );
          expect(castAt).toBeGreaterThanOrEqual(from);
          expect(castAt).toBeLessThan(from + span);
        },
      ),
    );
  });

  it('refuses a window with no minute left', () => {
    const late = { dispatchId: 'd', score: 3, from: 200, deadline: 200 } as const;
    expect(() => scheduleCarried(late, fixed(1))).toThrow(RangeError);
  });
});

describe('copiedNote', () => {
  it('finds a note written elsewhere, whatever its spacing, case or Unicode form', () => {
    const elsewhere = ['Not with   them.', 'Café first'];
    expect(copiedNote(' not with them. ', elsewhere)).toBe(true);
    expect(copiedNote('CAFÉ FIRST', elsewhere)).toBe(true);
    expect(copiedNote('Not with them yet.', elsewhere)).toBe(false);
    expect(copiedNote('', ['', '  '])).toBe(false);
  });

  it('finds it through zero-width characters and curly or straight punctuation (#378)', () => {
    const elsewhere = ['Don’t send it — “not yet”…'];
    expect(copiedNote('Don\'t send it - "not yet"...', elsewhere)).toBe(true);
    expect(copiedNote('Do\u200Bn’t se\u200Dnd it\u2060 — “not yet”…\uFEFF', elsewhere)).toBe(true);
    expect(copiedNote('Don‘t send it – ＂not yet＂…', elsewhere)).toBe(true);
    expect(copiedNote('Don‘t send it – „not yet‟…', elsewhere)).toBe(true);
    expect(copiedNote('Don’t send it — “not now”…', elsewhere)).toBe(false);
    // A note of nothing but zero-width characters is no note.
    expect(copiedNote('\u200B\u200D', ['\u200C'])).toBe(false);
  });
});

/** The original reason Cy gave in Riverside, which must never reach another group. */
const ORIGINAL = 'canary-original-reason';

/**
 * Riverside (A: ana, and Cy as gus) and Oak St (B: ben, and Cy as ivy) form
 * the coalition, kim bound to A's seat and dee to B's. Cy's device holds A
 * and B under separate keys, and the coalition's log. A puts a Dispatch with
 * ceiling 1 to its vote at R + 20; ana scores it 4 and gus `score`, with
 * `note`, closing it at R + 21; kim posts the record at R + 30, so its
 * motion opens in B with a deadline of R + 30 + 7 days.
 */
function scenario(
  score: 0 | 1 | 2 | 3 | 4 = 3,
  note?: string,
  { lateJoin = false, ceiling = 1 }: { lateJoin?: boolean; ceiling?: Ceiling } = {},
) {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'gus'], 'Riverside');
  const intoA = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ana', intoA, 4);
  logs.vote('A', R + 4, 'gus', intoA, 4);
  logs.group('B', R, lateJoin ? ['ben'] : ['ben', 'ivy'], 'Oak St');
  const intoB = logs.reconcile('B', R + 3, 'ben', 'B');
  logs.vote('B', R + 4, 'ben', intoB, 4);
  if (!lateJoin) logs.vote('B', R + 4, 'ivy', intoB, 4);
  logs.formed(R + 10, ['A', 'B'], ['kim', 'dee']);
  const dispatch = logs.dispatchVote('A', R + 20, 'ana', ceiling, {
    title: 'Rally Saturday',
    text: 'Meet at the river at ten.',
  });
  logs.vote('A', R + 21, 'ana', dispatch, 4);
  logs.vote('A', R + 21, 'gus', dispatch, score, note);
  const words = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };
  const record = {
    target: {
      kind: 'promote',
      dispatch: { id: dispatch, ...words },
      ceiling,
      level: 1,
      from: seatKey('A'),
    },
    title: words.title,
    why: '',
  } as const;
  const motion = logs.promoteIn('coalition', R + 30, 'kim', record);
  if (lateJoin) logs.add('B', R + 31, 'ivy', { type: 'join', body: { name: 'ivy' } });
  return { logs, dispatch, motion, deadline: R + 30 + WINDOW };
}

/** Cy's device: A as gus, B as ivy, and the coalition's log, each read at relay minute `now`. */
async function cyDevice(logs: Logs, now: number): Promise<Store> {
  const store = await openStore('cy');
  stores.push(store);
  for (const [groupId, log, who] of [
    [logs.ids.A ?? '', 'A', 'gus'],
    [logs.ids.B ?? '', 'B', 'ivy'],
  ] as const) {
    await store.addGroup({
      groupId,
      secret: new Uint8Array(32).fill(log === 'A' ? 1 : 2),
      signingKey: testKeys(who).secretKey,
      me: { author: authorOf(who), name: who },
    });
    await pullAt(store, groupId, logs.logs[log] ?? [], now);
  }
  await store.addGroup({
    kind: 'coalition',
    groupId: ENTRY,
    secret: fromBase64url(testSecret('coalition')),
    signingKey: testKeys('jon').secretKey,
    me: { author: authorOf('jon'), name: '' },
  });
  await pullAt(store, ENTRY, logs.logs.coalition ?? [], now);
  return store;
}

/** Saves `records` for `groupId` as a pull at relay minute `now`: the relay's clock, injected. */
async function pullAt(store: Store, groupId: string, records: readonly LogRecord[], now: number) {
  await store.applyPull(
    groupId,
    { records: [...records], relayNow: now, instance: 'i', lastSyncAt: 1 },
    eventIdOf,
  );
}

/** Moves every log on Cy's device to relay minute `now`, with nothing new. */
async function tick(store: Store, now: number) {
  for (const group of [...(await store.listGroups()), ...(await store.listCoalitions())]) {
    await pullAt(store, group.groupId, [], now);
  }
}

/** One settle of Cy's carried scores, with `random`. */
async function settle(store: Store, random: Random) {
  return settleCarries(store, await holdings(store), { random, clock });
}

/** The events waiting in group `groupId`'s outbox. */
async function queued(store: Store, groupId: string): Promise<ParsedEvent[]> {
  const group = await store.getGroup(groupId);
  return (group?.outbox ?? []).flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

describe('settleCarries', () => {
  it('keeps the score Cy gave in A, with the Dispatch’s ceiling, the ballot’s minute and 30 days from A’s decision, and no note', async () => {
    const { logs, dispatch } = scenario(3, ORIGINAL);
    const store = await cyDevice(logs, R + 22);

    await settle(store, fixed(0));

    const a = await store.getGroup(logs.ids.A ?? '');
    const until = R + 21 + KEEP_DAYS * DAY_MINUTES;
    expect(a?.scores).toEqual([{ dispatch, score: 3, ceiling: 1, at: R + 21, until }]);
    expect(JSON.stringify(a?.scores)).not.toContain(ORIGINAL);
  });

  it('schedules a carried 3 inside the window, casts it at the first settle at or after its minute, and with no note', async () => {
    const { logs, motion, deadline, dispatch } = scenario(3, ORIGINAL);
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    const random = fixed(500);

    expect(await settle(store, random)).toEqual([]);
    const castAt = R + 40 + 500;
    expect((await store.getGroup(b))?.carries).toEqual([
      { motion, dispatch, score: 3, castAt, deadline },
    ]);
    expect(castAt).toBeLessThan(deadline);

    await tick(store, castAt - 1);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);

    await tick(store, castAt);
    expect(await settle(store, fixed(0))).toEqual([b]);
    const [vote] = await queued(store, b);
    expect(vote?.event).toMatchObject({
      type: 'vote',
      group: b,
      author: authorOf('ivy'),
      body: { proposal: motion, scores: { [motion]: 3 } },
    });
    expect(vote?.event.body).not.toHaveProperty('note');
    expect(vote?.event.body).toHaveProperty('salt');
    expect((await store.getGroup(b))?.carries).toBeUndefined();
    const outbox = (await store.getGroup(b))?.outbox ?? [];
    expect(findCanaries(outbox[0] ?? new Uint8Array(), [textCanary('note', ORIGINAL)])).toEqual([]);

    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toHaveLength(1);
  });

  it('casts nothing while the member can’t vote there, as a suspension leaves them, and keeps the plan', async () => {
    const { logs, motion } = scenario(3, ORIGINAL);
    // Ben, B's founder and steward, suspends Cy's ivy there before the minute comes (#102).
    logs.add('B', R + 35, 'ben', { type: 'suspend', body: { member: authorOf('ivy') } });
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(500));
    const castAt = R + 40 + 500;
    expect((await store.getGroup(b))?.carries?.map((plan) => plan.motion)).toEqual([motion]);

    await tick(store, castAt);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
    expect((await store.getGroup(b))?.carries?.map((plan) => plan.castAt)).toEqual([castAt]);
  });

  it('never casts at or after the deadline: a minute the device reaches only then is dropped', async () => {
    const { logs, deadline } = scenario(3);
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(deadline - (R + 40) - 1));
    expect((await store.getGroup(b))?.carries?.[0]?.castAt).toBe(deadline - 1);

    await tick(store, deadline);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
    expect((await store.getGroup(b))?.carries).toBeUndefined();
  });

  it('casts nothing once the person chose Don’t cast, and plans no other', async () => {
    const { logs, motion } = scenario(3);
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(10));
    await skipCarry(store, b, motion);

    await tick(store, R + 60);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
    expect((await store.getGroup(b))?.carries).toEqual([
      expect.objectContaining({ motion, skipped: true }),
    ]);
  });

  it('casts nothing once the person has voted there themselves, and drops the plan', async () => {
    const { logs, motion } = scenario(3);
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(10));
    logs.vote('B', R + 45, 'ivy', motion, 2);
    await pullAt(store, b, (logs.logs.B ?? []).slice(-1), R + 60);
    await tick(store, R + 60);

    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
    expect((await store.getGroup(b))?.carries).toBeUndefined();
  });

  it('plans a carried 0 but never casts it on its own', async () => {
    const { logs, motion } = scenario(0, ORIGINAL);
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(10));
    expect((await store.getGroup(b))?.carries).toEqual([
      expect.objectContaining({ motion, score: 0 }),
    ]);

    await tick(store, R + 60);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
    // Nothing of the reason Cy gave in A is kept for B: the plan holds the score alone.
    const kept = await store.getGroup(b);
    expect(JSON.stringify({ carries: kept?.carries, scores: kept?.scores })).not.toContain(
      ORIGINAL,
    );
  });

  it('finds the person’s own note on the Dispatch in their other groups, so a copy can be refused', async () => {
    const { logs, dispatch } = scenario(0, ORIGINAL);
    const store = await cyDevice(logs, R + 40);

    expect(await notesElsewhere(store, logs.ids.B ?? '', dispatch)).toEqual([ORIGINAL]);
    expect(await notesElsewhere(store, logs.ids.A ?? '', dispatch)).toEqual([]);
    expect(await notesElsewhere(store, logs.ids.B ?? '', 'another')).toEqual([]);
  });

  it('schedules nothing for a person who joined after the motion opened, who isn’t eligible on it', async () => {
    const { logs } = scenario(3, undefined, { lateJoin: true });
    const b = logs.ids.B ?? '';
    const store = await cyDevice(logs, R + 40);

    await settle(store, fixed(10));
    expect((await store.getGroup(b))?.carries).toBeUndefined();
    await tick(store, R + 60);
    expect(await settle(store, fixed(0))).toEqual([]);
    expect(await queued(store, b)).toEqual([]);
  });

  it('drops a score once its ceiling is reached: the coalition’s decision at that level is final', async () => {
    const { logs, motion } = scenario(3);
    const a = logs.ids.A ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(10));
    logs.result(R + 50, 'kim', motion, 'A', 'pass');
    logs.result(R + 50, 'dee', motion, 'B', 'pass');
    await pullAt(store, ENTRY, (logs.logs.coalition ?? []).slice(-2), R + 50);
    const final = R + 30 + WINDOW + RESULT_GRACE_MINUTES;
    await tick(store, final - 1);
    await settle(store, fixed(0));
    expect((await store.getGroup(a))?.scores).toHaveLength(1);

    await tick(store, final);
    await settle(store, fixed(0));
    expect((await store.getGroup(a))?.scores).toBeUndefined();
  });

  it('keeps a score for 30 days after the last decision on its Dispatch it has seen, then drops it', async () => {
    const { logs, motion, dispatch } = scenario(3, undefined, { ceiling: 'coalitions' });
    const a = logs.ids.A ?? '';
    const store = await cyDevice(logs, R + 40);
    await settle(store, fixed(10));
    // A decided at R + 21; the coalition's motion is final at its deadline + 7 days.
    logs.result(R + 50, 'kim', motion, 'A', 'pass');
    logs.result(R + 50, 'dee', motion, 'B', 'pass');
    await pullAt(store, ENTRY, (logs.logs.coalition ?? []).slice(-2), R + 50);
    const final = R + 30 + WINDOW + RESULT_GRACE_MINUTES;
    await tick(store, final);
    await settle(store, fixed(0));
    const until = final + KEEP_DAYS * DAY_MINUTES;
    expect((await store.getGroup(a))?.scores).toEqual([
      { dispatch, score: 3, ceiling: 'coalitions', at: R + 21, until },
    ]);

    await tick(store, until - 1);
    await settle(store, fixed(0));
    expect((await store.getGroup(a))?.scores).toHaveLength(1);
    await tick(store, until);
    await settle(store, fixed(0));
    expect((await store.getGroup(a))?.scores).toBeUndefined();
  });
});
