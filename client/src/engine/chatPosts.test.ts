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
  isDiscordId,
  isThreadUrl,
  mayClaim,
  mayRecordThread,
  NOTICE_MINUTES,
  threadFor,
  threadIdOf,
  threadUrl,
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

const GUILD = '1188000000000000001';
const THREAD = '1309000000000000003';
const THREAD_URL = `https://discord.com/channels/${GUILD}/${THREAD}`;

describe('a Proposal’s Discord thread link (#123)', () => {
  it('is discord.com/channels/ with a server id and a thread id, each 17 to 20 digits', () => {
    expect(threadUrl(GUILD, THREAD)).toBe(THREAD_URL);
    expect(isThreadUrl(THREAD_URL)).toBe(true);
    expect(threadIdOf(THREAD_URL)).toBe(THREAD);
    fc.assert(
      fc.property(
        fc.stringMatching(/^\d{17,20}$/),
        fc.stringMatching(/^\d{17,20}$/),
        (guild, thread) => {
          expect(isDiscordId(guild)).toBe(true);
          expect(threadUrl(guild, thread)).toBe(`https://discord.com/channels/${guild}/${thread}`);
          expect(threadIdOf(threadUrl(guild, thread))).toBe(thread);
        },
      ),
    );
  });

  it.each([
    ['an id of 16 digits', '1188000000000001', THREAD],
    ['an id of 21 digits', GUILD, '130900000000000000031'],
    ['an id with a letter', GUILD, '1309000000000000x03'],
    ['an empty id', GUILD, ''],
    ['an id with a path', GUILD, `${THREAD}/1`],
  ])('is never made from %s', (_name, guild, thread) => {
    expect(threadUrl(guild, thread)).toBeNull();
  });

  it.each([
    ['another host', `https://example.com/channels/${GUILD}/${THREAD}`],
    ['discordapp.com', `https://discordapp.com/channels/${GUILD}/${THREAD}`],
    ['a look-alike host', `https://discord.com.example.com/channels/${GUILD}/${THREAD}`],
    ['http:', `http://discord.com/channels/${GUILD}/${THREAD}`],
    ['a path past the thread id', `${THREAD_URL}/1400000000000000001`],
    ['a trailing slash', `${THREAD_URL}/`],
    ['a query', `${THREAD_URL}?x=1`],
    ['a fragment', `${THREAD_URL}#x`],
    ['short ids', 'https://discord.com/channels/1188/1309'],
    ['a server id of 16 digits', `https://discord.com/channels/1188000000000001/${THREAD}`],
    ['a thread id of 21 digits', `https://discord.com/channels/${GUILD}/130900000000000000031`],
    ['any character for the dot', `https://discordxcom/channels/${GUILD}/${THREAD}`],
    ['a direct-message link', `https://discord.com/channels/@me/${THREAD}`],
    ['a capital in the host', `https://Discord.com/channels/${GUILD}/${THREAD}`],
    ['a line break after it', `${THREAD_URL}\n`],
    ['a number', 1309],
    ['an object that prints as a link', { toString: () => THREAD_URL }],
    ['nothing', null],
  ])('is refused for %s', (_name, url) => {
    expect(isThreadUrl(url)).toBe(false);
    expect(threadIdOf(url)).toBeNull();
  });

  it('takes only an id of 17 to 20 digits as a Discord id', () => {
    for (const id of ['12345678901234567', '12345678901234567890'])
      expect(isDiscordId(id)).toBe(true);
    for (const id of ['1234567890123456', '123456789012345678901', ' 12345678901234567', 17]) {
      expect(isDiscordId(id)).toBe(false);
    }
  });
});

describe('mayRecordThread and threadFor: who records a Proposal’s thread (#123, #245)', () => {
  /** The bot on, Ben's edit, and Cal's winning claim of its opening. */
  function opened() {
    const log = botOn();
    const edit = log.propose('Ben');
    log.chatPosted('Cal', edit, 'open');
    return { log, edit };
  }

  it('lets the member who won the open claim record it, once', () => {
    const { log, edit } = opened();
    expect(mayRecordThread(log.state(), authorOf('cal'), edit)).toBe(true);
    expect(threadFor(log.state(), edit)).toBeUndefined();

    const id = log.chatThread('Cal', edit, THREAD_URL);
    const state = log.state();
    expect(threadFor(state, edit)).toEqual({
      id,
      seq: log.records.length,
      received: log.minute,
      by: authorOf('cal'),
      proposal: edit,
      url: THREAD_URL,
    });
    expect(mayRecordThread(state, authorOf('cal'), edit)).toBe(false);
  });

  it('lets nobody else record it, nor anyone before any claim has won', () => {
    const log = botOn();
    const edit = log.propose('Ben');
    expect(mayRecordThread(log.state(), authorOf('ben'), edit)).toBe(false);
    log.chatPosted('Cal', edit, 'open');
    for (const name of ['ana', 'ben', 'zed']) {
      expect(mayRecordThread(log.state(), authorOf(name), edit)).toBe(false);
    }
    expect(mayRecordThread(log.state(), authorOf('cal'), 'no-such-proposal')).toBe(false);
  });

  it('lets the winner of a later moment’s claim record it while none is kept, and nobody else (#245)', () => {
    const log = botOn();
    const edit = log.propose('Ben', { window: 3 });
    // A 3-day vote is closing from its second day, and nobody claimed its opening.
    log.minute += 2 * DAY_MINUTES;
    log.chatPosted('Cal', edit, 'closing');
    expect(claimFor(log.state(), edit, 'closing')?.by).toBe(authorOf('cal'));
    expect(mayRecordThread(log.state(), authorOf('cal'), edit)).toBe(true);
    for (const name of ['ana', 'ben', 'zed']) {
      expect(mayRecordThread(log.state(), authorOf(name), edit)).toBe(false);
    }

    log.chatThread('Cal', edit, THREAD_URL);
    // Its result's winner posts into the kept thread, and records none of their own.
    log.minute += DAY_MINUTES;
    log.chatPosted('Ana', edit, 'result');
    expect(claimFor(log.state(), edit, 'result')?.by).toBe(authorOf('ana'));
    expect(mayRecordThread(log.state(), authorOf('ana'), edit)).toBe(false);
    expect(threadFor(log.state(), edit)?.by).toBe(authorOf('cal'));
  });

  it('lets the opening’s winner record it when a later moment’s winner hasn’t yet, and then no one (#245)', () => {
    const { log, edit } = opened();
    log.minute += 6 * DAY_MINUTES;
    log.chatPosted('Ana', edit, 'closing');
    // Cal won the opening and Ana the closing: either may record the thread, the first kept.
    expect(mayRecordThread(log.state(), authorOf('cal'), edit)).toBe(true);
    expect(mayRecordThread(log.state(), authorOf('ana'), edit)).toBe(true);
    log.chatThread('Ana', edit, THREAD_URL);
    expect(mayRecordThread(log.state(), authorOf('cal'), edit)).toBe(false);
    expect(threadFor(log.state(), edit)?.by).toBe(authorOf('ana'));
  });

  it('lets the open claimant record nothing while the bot is narrowed, off, or they have left or are suspended', () => {
    const narrowed = opened();
    const off = narrowed.log.rules('Ana', 'chatBot', null);
    narrowed.log.narrow('Ana', 'chatBot', off);
    expect(mayRecordThread(narrowed.log.state(), authorOf('cal'), narrowed.edit)).toBe(false);

    const left = opened();
    left.log.leave('Cal');
    expect(mayRecordThread(left.log.state(), authorOf('cal'), left.edit)).toBe(false);

    const suspended = opened();
    suspended.log.suspend('Ana', 'Cal');
    expect(mayRecordThread(suspended.log.state(), authorOf('cal'), suspended.edit)).toBe(false);
  });

  it('keeps at most one thread per Proposal, from a member who won one of its claims, with a valid link, however records arrive', () => {
    const who = fc.constantFrom('Ana', 'Ben', 'Cal', 'Zed');
    const link = fc.oneof(
      fc
        .tuple(fc.stringMatching(/^\d{17,20}$/), fc.stringMatching(/^\d{17,20}$/))
        .map(([guild, thread]) => `https://discord.com/channels/${guild}/${thread}`),
      fc.constantFrom(`${THREAD_URL}/1`, `http://discord.com/channels/${GUILD}/${THREAD}`, ''),
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(who, link), { maxLength: 6 }), (records) => {
        const { log, edit } = opened();
        for (const [name, url] of records) log.chatThread(name, edit, url);
        const state = log.state();
        expect(state.chatThreads.length).toBeLessThanOrEqual(1);
        const first = records.find(([name, url]) => name === 'Cal' && isThreadUrl(url));
        expect(threadFor(state, edit)?.url).toBe(first?.[1]);
        for (const thread of state.chatThreads) expect(thread.by).toBe(authorOf('cal'));
      }),
      { numRuns: 60 },
    );
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

  it('records no thread either, even from the open claimant of a Proposal still open (#123)', () => {
    const log = botOn();
    const edit = log.propose('Ben');
    log.chatPosted('Cal', edit, 'open');
    log.minute += 1;
    const motion = log.proposeDissolve('Ana', false);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('Ben', motion);
    log.minute += 1;
    const late = log.chatThread('Cal', edit, THREAD_URL);

    const state = log.state();
    expect(state.dissolved).not.toBeNull();
    expect(state.chatThreads).toEqual([]);
    expect(state.ignored.map((record) => record.id)).toContain(late);
  });
});

describe('Dispatches beside Proposal numbers and threads (#112, #123)', () => {
  it('numbers only Proposals, and a Proposal carrying a Dispatch keeps its number and thread through its pass', () => {
    const log = botOn();
    const sent = log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
    log.minute += 1;
    const edit = log.propose('Ben', { dispatch: { title: 'Updated: House rules', text: '' } });
    log.chatPosted('Cal', edit, 'open');
    log.chatThread('Cal', edit, THREAD_URL);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, edit, 4);

    const state = log.state();
    // The bot's own rules Proposal is 1; the Dispatch between them takes no number.
    expect(state.proposals.map((p) => [p.id, p.number])).toEqual([
      [state.proposals[0]?.id, 1],
      [edit, 2],
    ]);
    expect(state.dispatches.map((dispatch) => dispatch.id)).toEqual([sent, edit]);
    expect(threadFor(state, edit)?.url).toBe(THREAD_URL);
    expect(state.chatThreads).toHaveLength(1);
  });
});

describe('a claim beside a passed removal (#115)', () => {
  it('lets the person a passed removal names claim nothing and record no thread, as the fold takes neither', () => {
    // The bot on, and Ben's edit, whose opening Cal claims.
    const log = botOn();
    const edit = log.propose('Ben');
    const opened = log.minute;
    log.chatPosted('Cal', edit, 'open');
    // Ana's removal of Cal passes on Ana's and Ben's 4s, closing early.
    const removal = log.proposeRemoval('Ana', 'Cal');
    for (const voter of ['Ana', 'Ben']) log.vote(voter, removal, 4);
    // The edit's last day.
    log.minute = deadlineOf(opened) - DAY_MINUTES;
    const state = log.state();
    expect(mayClaim(state, authorOf('cal'), edit, 'closing')).toBe(false);
    expect(dueClaims(state, authorOf('cal'))).toEqual([]);
    expect(mayRecordThread(state, authorOf('cal'), edit)).toBe(false);
    // The fold agrees: neither lands, while Ben may still claim.
    log.chatPosted('Cal', edit, 'closing');
    log.chatThread('Cal', edit, THREAD_URL);
    expect(claimFor(log.state(), edit, 'closing')).toBeUndefined();
    expect(threadFor(log.state(), edit)).toBeUndefined();
    expect(mayClaim(log.state(), authorOf('ben'), edit, 'closing')).toBe(true);
  });
});
