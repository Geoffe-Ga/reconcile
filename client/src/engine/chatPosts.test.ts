import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, type LogBuilder } from '../test/votes';
import {
  BOT_MOMENTS,
  type BotMoment,
  claimFor,
  dueClaims,
  dueMoment,
  isBotMoment,
  mayClaim,
  NOTICE_MINUTES,
} from './chatPosts';
import { DAY_MINUTES } from './rules';

const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/rV7-first_token';

/** A Proposal received at `received`, running to `deadline`, closed early at `closedAt`. */
const proposal = (received: number, deadline: number, closedAt: number | null = null) => ({
  received,
  deadline,
  closedAt,
});

/** Ana, Ben and Cal, with the chat bot turned on by a vote that closed early at the log's minute. */
function botOn(): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  log.minute += 10;
  const on = log.rules('Ana', 'chatBot', { webhook: WEBHOOK });
  log.minute += 10;
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
  log.minute += 10;
  return log;
}

describe('the moments the bot posts (#119)', () => {
  it('are a new Proposal, its last day and its result: never a version', () => {
    expect(BOT_MOMENTS).toEqual(['open', 'closing', 'result']);
    expect(NOTICE_MINUTES).toBe(DAY_MINUTES);
    for (const moment of BOT_MOMENTS) expect(isBotMoment(moment)).toBe(true);
    for (const other of ['version', 'Open', '', 'toString', null, 1, undefined]) {
      expect(isBotMoment(other)).toBe(false);
    }
  });
});

describe('dueMoment: the one moment due at a relay minute', () => {
  const R = 29_375_000;
  const D = R + 7 * DAY_MINUTES;

  it('is open until a day before the deadline, closing in the last day, then the result for a day', () => {
    const p = proposal(R, D);
    expect(dueMoment(p, R)).toBe('open');
    expect(dueMoment(p, D - DAY_MINUTES - 1)).toBe('open');
    expect(dueMoment(p, D - DAY_MINUTES)).toBe('closing');
    expect(dueMoment(p, D - 1)).toBe('closing');
    expect(dueMoment(p, D)).toBe('result');
    expect(dueMoment(p, D + DAY_MINUTES - 1)).toBe('result');
    expect(dueMoment(p, D + DAY_MINUTES)).toBeNull();
  });

  it('skips closing when the vote closes early before its last day, and dates the result from the close', () => {
    const closed = R + 60;
    const p = proposal(R, D, closed);
    expect(dueMoment(p, closed - 1)).toBe('open');
    expect(dueMoment(p, closed)).toBe('result');
    expect(dueMoment(p, closed + DAY_MINUTES - 1)).toBe('result');
    expect(dueMoment(p, closed + DAY_MINUTES)).toBeNull();
    expect(dueMoment(p, D - 1)).toBeNull();
  });

  it('turns from closing to the result at an early close in the last day', () => {
    const closed = D - 30;
    const p = proposal(R, D, closed);
    expect(dueMoment(p, closed - 1)).toBe('closing');
    expect(dueMoment(p, closed)).toBe('result');
    expect(dueMoment(p, closed + DAY_MINUTES)).toBeNull();
  });

  it('moves only forward: once a moment has passed, it is never due again', () => {
    const order: (BotMoment | null)[] = ['open', 'closing', 'result', null];
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 28 }),
        fc.option(fc.integer({ min: 0, max: 28 * DAY_MINUTES }), { nil: null }),
        fc.array(fc.integer({ min: 0, max: 31 * DAY_MINUTES }), { minLength: 2 }),
        (days, early, offsets) => {
          const deadline = R + days * DAY_MINUTES;
          const closedAt = early === null || R + early >= deadline ? null : R + early;
          const p = proposal(R, deadline, closedAt);
          const seen = [...offsets].sort((a, b) => a - b).map((at) => dueMoment(p, R + at));
          const places = seen.map((moment) => order.indexOf(moment));
          expect(places).toEqual([...places].sort((a, b) => a - b));
        },
      ),
    );
  });
});

describe('mayClaim and dueClaims: what the fold keeps and what a device claims', () => {
  it('lets a member claim the moment due while the bot is on, once', () => {
    const log = botOn();
    const edit = log.propose('Ben');
    const state = log.state();
    expect(mayClaim(state, authorOf('cal'), edit, 'open')).toBe(true);
    expect(dueClaims(state, authorOf('cal'))).toEqual(
      expect.arrayContaining([{ proposal: edit, moment: 'open' }]),
    );

    log.chatPosted('Ben', edit, 'open');
    const claimed = log.state();
    expect(claimFor(claimed, edit, 'open')).toMatchObject({ by: authorOf('ben'), proposal: edit });
    expect(mayClaim(claimed, authorOf('cal'), edit, 'open')).toBe(false);
    expect(dueClaims(claimed, authorOf('cal'))).not.toContainEqual({
      proposal: edit,
      moment: 'open',
    });
  });

  it('lets nobody claim a moment that isn’t due, or a Proposal it doesn’t know', () => {
    const log = botOn();
    const edit = log.propose('Ben');
    const state = log.state();
    expect(mayClaim(state, authorOf('cal'), edit, 'closing')).toBe(false);
    expect(mayClaim(state, authorOf('cal'), edit, 'result')).toBe(false);
    expect(mayClaim(state, authorOf('cal'), 'no-such-proposal', 'open')).toBe(false);
    const closing = log.state(deadlineOf(log.minute) - DAY_MINUTES);
    expect(mayClaim(closing, authorOf('cal'), edit, 'closing')).toBe(true);
    expect(mayClaim(closing, authorOf('cal'), edit, 'open')).toBe(false);
  });

  it('lets nobody claim while the bot is off', () => {
    const log = groupLog({ members: ['Ben'] });
    const edit = log.propose('Ben');
    const state = log.state();
    expect(mayClaim(state, authorOf('ana'), edit, 'open')).toBe(false);
    expect(dueClaims(state, authorOf('ana'))).toEqual([]);
  });

  it('lets nobody claim while a steward’s narrowing holds the bot off', () => {
    const log = botOn();
    const off = log.rules('Ana', 'chatBot', null);
    log.narrow('Ana', 'chatBot', off);
    const edit = log.propose('Ben');
    const state = log.state();
    expect(state.rules.optIns.chatBot).toEqual({ webhook: WEBHOOK });
    expect(mayClaim(state, authorOf('cal'), edit, 'open')).toBe(false);
    expect(dueClaims(state, authorOf('cal'))).toEqual([]);
  });

  it('lets no one claim who isn’t a member, has left, or is suspended', () => {
    const log = botOn();
    log.leave('Cal');
    const edit = log.propose('Ben');
    expect(mayClaim(log.state(), authorOf('zed'), edit, 'open')).toBe(false);
    expect(mayClaim(log.state(), authorOf('cal'), edit, 'open')).toBe(false);
    log.suspend('Ana', 'Ben');
    expect(mayClaim(log.state(), authorOf('ben'), edit, 'open')).toBe(false);
    expect(dueClaims(log.state(), authorOf('ben'))).toEqual([]);
    expect(mayClaim(log.state(), authorOf('ana'), edit, 'open')).toBe(true);
  });

  it('keeps at most one claim per moment, each of the moment due at its receipt, from a member, however claims arrive', () => {
    const claimant = fc.constantFrom('Ana', 'Ben', 'Cal', 'Zed');
    const moment = fc.constantFrom(...BOT_MOMENTS, 'version');
    const step = fc.integer({ min: 0, max: 3 * DAY_MINUTES });
    fc.assert(
      fc.property(fc.array(fc.tuple(claimant, moment, step), { maxLength: 8 }), (claims) => {
        const log = botOn();
        const edit = log.propose('Ben', { window: 3 });
        for (const [name, claimed, wait] of claims) {
          log.minute += wait;
          log.chatPosted(name, edit, claimed);
        }
        const state = log.state();
        const keys = state.chatPosts.map((post) => `${post.proposal} ${post.moment}`);
        expect(new Set(keys).size).toBe(keys.length);
        const [, proposed] = state.proposals;
        for (const post of state.chatPosts) {
          expect(post.by).not.toBe(authorOf('zed'));
          if (proposed !== undefined) expect(dueMoment(proposed, post.received)).toBe(post.moment);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('claims the result of the vote that turned the bot on, for a day after it closed', () => {
    const log = botOn();
    const [on] = log.state().proposals;
    if (on === undefined) throw new Error('Expected the on-Proposal.');
    expect(dueClaims(log.state(), authorOf('ben'))).toEqual([
      { proposal: on.id, moment: 'result' },
    ]);
    const closed = on.closedAt ?? 0;
    expect(dueClaims(log.state(closed + DAY_MINUTES - 1), authorOf('ben'))).toHaveLength(1);
    expect(dueClaims(log.state(closed + DAY_MINUTES), authorOf('ben'))).toEqual([]);
  });
});

describe('a claim after the group dissolves (#108)', () => {
  it('is ignored, even a claim of the dissolve’s own result while it is still due', () => {
    const log = botOn();
    const motion = log.proposeDissolve('Ana', false);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('Ben', motion);
    log.minute += 1;
    const late = log.chatPosted('Cal', motion, 'result');

    const state = log.state();
    const dissolve = state.proposals.find((p) => p.id === motion);
    if (dissolve === undefined) throw new Error('Expected the dissolve Proposal.');
    expect(state.dissolved).not.toBeNull();
    expect(dueMoment(dissolve, state.at)).toBe('result');
    expect(state.chatPosts).toEqual([]);
    expect(state.ignored.map((record) => record.id)).toContain(late);
  });
});
