import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveWeekMailboxId, WEEK_MINUTES, weekOf } from '../crypto/groupKeys';
import { DAY_MINUTES } from '../engine/rules';
import {
  CATCH_UP_WEEKS,
  keptWeeks,
  mailboxAt,
  mailboxesFrom,
  type MailboxAt,
  pollWeeks,
  REGISTER_DAYS,
} from './mailbox';

const group = { secret: new Uint8Array(32).fill(9) };
const NOW = 29_000_000;
/** NOW's week, which ends 160 minutes after NOW. */
const WEEK = 2876;

describe('mailboxAt: the one seam for a group’s mailbox at a relay minute (#99, #110)', () => {
  it('is the mailbox of the minute’s week, from the group’s secret', () => {
    expect(weekOf(NOW)).toBe(WEEK);
    expect(mailboxAt(group, NOW)).toBe(deriveWeekMailboxId(group.secret, WEEK));
  });

  it('stays all week, and turns over with the week, on Thursday at 00:00 UTC', () => {
    const start = WEEK * WEEK_MINUTES;
    const next = (WEEK + 1) * WEEK_MINUTES;

    expect(mailboxAt(group, start)).toBe(mailboxAt(group, next - 1));
    expect(mailboxAt(group, next - 1)).not.toBe(mailboxAt(group, next));
    expect(mailboxAt(group, next)).toBe(deriveWeekMailboxId(group.secret, WEEK + 1));
    expect(new Date(next * 60_000).toISOString()).toBe('2025-02-20T00:00:00.000Z');
  });
});

describe('mailboxesFrom: every mailbox a push registration needs', () => {
  it('is each week’s mailbox from now to 30 days on, in order', () => {
    const names = mailboxesFrom(group, NOW);

    expect(REGISTER_DAYS).toBe(30);
    expect(names).toEqual(
      [0, 1, 2, 3, 4, 5].map((n) => deriveWeekMailboxId(group.secret, WEEK + n)),
    );
  });

  it('gives each mailbox `mailboxAt` names from now to 30 days on, once each, in order', () => {
    const asked: number[] = [];
    const weekly: MailboxAt = (_group, minute) => {
      asked.push(minute);
      return `week-${String(Math.floor(minute / (7 * DAY_MINUTES)))}`;
    };
    const first = Math.floor(NOW / (7 * DAY_MINUTES));
    const last = Math.floor((NOW + 30 * DAY_MINUTES) / (7 * DAY_MINUTES));
    const weeks = Array.from({ length: last - first + 1 }, (_, n) => `week-${String(first + n)}`);

    const names = mailboxesFrom(group, NOW, weekly);

    expect(asked[0]).toBe(NOW);
    expect(asked.at(-1)).toBe(NOW + 30 * DAY_MINUTES);
    expect(names).toEqual(weeks);
    expect(names).toHaveLength(6);
    expect(asked).toHaveLength(31);
  });
});

describe('pollWeeks: the weeks a sync pass reads (#110)', () => {
  it('reads this week and last, however recently the device synced', () => {
    expect(pollWeeks(WEEK, WEEK)).toEqual([WEEK - 1, WEEK]);
    expect(pollWeeks(WEEK - 1, WEEK)).toEqual([WEEK - 1, WEEK]);
    expect(pollWeeks(null, WEEK)).toEqual([WEEK - 1, WEEK]);
  });

  it('reads each week since the last sync once, back to the last 5', () => {
    expect(CATCH_UP_WEEKS).toBe(5);
    expect(pollWeeks(WEEK - 2, WEEK)).toEqual([WEEK - 2, WEEK - 1, WEEK]);
    expect(pollWeeks(WEEK - 3, WEEK)).toEqual([WEEK - 3, WEEK - 2, WEEK - 1, WEEK]);
    expect(pollWeeks(WEEK - 4, WEEK)).toEqual([WEEK - 4, WEEK - 3, WEEK - 2, WEEK - 1, WEEK]);
    expect(pollWeeks(WEEK - 5, WEEK)).toEqual([WEEK - 4, WEEK - 3, WEEK - 2, WEEK - 1, WEEK]);
    expect(pollWeeks(0, WEEK)).toEqual([WEEK - 4, WEEK - 3, WEEK - 2, WEEK - 1, WEEK]);
  });

  it('reads this week and last when the relay’s clock is behind the last sync’s', () => {
    expect(pollWeeks(WEEK + 3, WEEK)).toEqual([WEEK - 1, WEEK]);
  });

  it('starts at week 0', () => {
    expect(pollWeeks(null, 0)).toEqual([0]);
    expect(pollWeeks(0, 1)).toEqual([0, 1]);
  });

  it('is always this week and last, then back to the last sync’s week, ascending, at most 5', () => {
    const lasts = fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null });
    fc.assert(
      fc.property(lasts, fc.integer({ min: 1, max: 10_000 }), (last, week) => {
        const weeks = pollWeeks(last, week);
        const from = Math.max(Math.min(last ?? week, week - 1), week - CATCH_UP_WEEKS + 1, 0);

        expect(weeks).toEqual(Array.from({ length: week - from + 1 }, (_, n) => from + n));
        expect(weeks.slice(-2)).toEqual([week - 1, week]);
        expect(weeks.length).toBeLessThanOrEqual(CATCH_UP_WEEKS);
      }),
    );
  });
});

describe('keptWeeks: whose cursors a group keeps (#110)', () => {
  it('is the last 5 weeks, this one included', () => {
    expect(keptWeeks(WEEK)).toEqual([WEEK - 4, WEEK - 3, WEEK - 2, WEEK - 1, WEEK]);
    expect(keptWeeks(2)).toEqual([0, 1, 2]);
  });

  it('holds every week a pass reads', () => {
    const lasts = fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null });
    fc.assert(
      fc.property(lasts, fc.integer({ min: 0, max: 10_000 }), (last, week) => {
        const kept = keptWeeks(week);
        for (const read of pollWeeks(last, week)) expect(kept).toContain(read);
      }),
    );
  });
});
