/**
 * Why a Dispatch put to a vote, and every promotion record built from it,
 * always fits a record (#377, from #323's review). `proposeDispatch`, like
 * `sendDispatch`, runs no `allFit` check, unlike the other `propose*`
 * functions: the composer's limits keep it far under the relay's 64,000
 * bytes. A Dispatch's title is at most 80 code points and its text 500
 * (`engine/dispatches.ts`), each code point at most 6 bytes once the event
 * is JSON (a control character's `\u0001` escape), and its Document is one
 * of the group's own, whose ids are short. A promotion record (#126) restates
 * only the Dispatch's id, title and text, its ceiling, level and seat at each
 * level: it carries no Document and never nests the level below's, so it
 * doesn't grow as it rises. These tests pin that at the largest of each,
 * lifted three levels, so a later change that lets either grow fails here,
 * and the size check it would then need is added with it.
 */
import { describe, expect, it } from 'vitest';

import { MAX_RECORD_BYTES } from '../crypto/record';
import { MAX_LEVEL, motionHorizon } from '../engine/coalition';
import { promotionsOwed, resultsToReport } from '../engine/crossing';
import { DISPATCH_TEXT_MAX, DISPATCH_TITLE_MAX } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';
import { NestedLogs, seatKey, threeLevels } from '../test/coalitions';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { checkDispatchText, checkDispatchTitle } from './proposalFields';
import { proposeDispatch } from './proposals';

freshIndexedDBPerTest();

/**
 * The most bytes the composer lets a Dispatch's words take: every code point
 * a control character, which the composer takes (it trims only spaces) and
 * JSON spells in 6 bytes. No code point takes more: a 4-byte one goes as is.
 */
const LARGEST = {
  title: '\u0001'.repeat(DISPATCH_TITLE_MAX),
  text: '\u0001'.repeat(DISPATCH_TEXT_MAX),
};

/**
 * An eighth of the cap: the most these records may take, so each has room
 * to grow before it nears the relay's limit.
 */
const BOUND = MAX_RECORD_BYTES / 8;

describe('the largest Dispatch put to a vote fits a record (#377)', () => {
  it('is words the composer takes', () => {
    expect([checkDispatchTitle(LARGEST.title), checkDispatchText(LARGEST.text)]).toEqual([
      null,
      null,
    ]);
    expect(checkDispatchTitle(`${LARGEST.title}\u0001`)).not.toBeNull();
    expect(checkDispatchText(`${LARGEST.text}\u0001`)).not.toBeNull();
  });

  it('queues a record of at most an eighth of the cap, with the longest Document reference a group holds', async () => {
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    // The longest Document id: a founding Document's, `${genesisId}:${k}` (engine/documents.ts).
    const doc = `${groupId}:${String(Number.MAX_SAFE_INTEGER)}`;

    const proposed = await proposeDispatch(ana.services, groupId, {
      ...LARGEST,
      doc,
      ceiling: 'coalitions',
    });

    expect(proposed.outcome).toBe('proposed');
    const group = await ana.services.store.getGroup(groupId);
    const record = group?.outbox.at(-1) ?? group?.log.at(-1)?.bytes;
    expect(record?.length).toBeGreaterThan(DISPATCH_TEXT_MAX * 6);
    expect(record?.length).toBeLessThanOrEqual(BOUND);
    ana.services.store.close();
  });
});

/** The state of `log` in `states`, failing the test when there is none. */
function stateOf(states: Record<string, GroupState>, log: string): GroupState {
  const state = states[log];
  if (state === undefined) throw new Error(`no log is named "${log}"`);
  return state;
}

/** The coalitions above group A, nearest first, with the seat bound in each and the other seat. */
const LINES = [
  { log: 'C', lower: 'A', bound: 'cal', other: ['dee', 'B'] },
  { log: 'D', lower: 'C', bound: 'fay', other: ['hal', 'E'] },
  { log: 'F', lower: 'D', bound: 'ivy', other: ['jon', 'G'] },
] as const;

describe('its promotion record at every level fits a record too (#377)', () => {
  it('stays the same size from level 1 to level 3, at most an eighth of the cap', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const at = 29_375_030;
    const p = logs.dispatchVote('A', at, 'ana', 'coalitions', LARGEST, { title: LARGEST.title });
    logs.vote('A', at + 1, 'ana', p, 4);
    const sizes: number[] = [];
    let minute = at + 2;
    for (const { log, lower, bound, other } of LINES) {
      const states = logs.foldAll((minute += 1));
      const [record] = promotionsOwed(stateOf(states, lower), stateOf(states, log), seatKey(lower));
      if (record === undefined) throw new Error(`Expected a record from ${lower} into ${log}.`);
      const motion = logs.promoteIn(log, (minute += 1), bound, record);
      sizes.push(logs.logs[log]?.at(-1)?.bytes.length ?? 0);
      const after = logs.foldAll(minute);
      expect(
        resultsToReport(stateOf(after, lower), stateOf(after, log), seatKey(lower)),
      ).toContainEqual({ motion, seat: seatKey(lower), result: 'pass' });
      logs.resultIn(log, (minute += 1), bound, motion, lower, 'pass');
      logs.resultIn(log, minute, other[0], motion, other[1], 'pass');
      // The next line's record goes up once this pass is final, at its horizon (#387).
      const decided = stateOf(logs.foldAll(minute), log);
      const proposal = decided.proposals.find((p) => p.id === motion);
      minute = motionHorizon(decided.coalition, proposal ?? { id: motion, deadline: minute });
    }

    expect(sizes).toHaveLength(MAX_LEVEL);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    for (const size of sizes) {
      expect(size).toBeGreaterThan(DISPATCH_TEXT_MAX * 6);
      expect(size).toBeLessThanOrEqual(BOUND);
    }
  });
});
