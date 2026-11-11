import { describe, expect, it } from 'vitest';

import { DOOR } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { LEVELS } from './capabilities';
import { DAY_MINUTES, DEFAULT_RULES } from './rules';
import {
  activeSuspension,
  canStand,
  EMPTY_SEATS,
  electionsDue,
  FIRST_SECOND_SEAT_TERM_DAYS,
  mayNarrow,
  mayProposeSteward,
  maySuspend,
  mayTurnOffNow,
  mayUseSuspend,
  NARROW_GAP_DAYS,
  REASON_MAX,
  reasonFits,
  type Seat,
  seatOf,
  SEATS,
  seatTakesElection,
  SUSPENSION_GAP_DAYS,
  vacate,
} from './stewards';

const ANA = authorOf('ana');
const BEN = authorOf('ben');
const CAL = authorOf('cal');
const KIM = authorOf('kim');

/** The following and voting levels, by place, so no level id is spelled out here. */
const [FOLLOWING, VOTING] = LEVELS;

/** Ana founds a group joined by `members`, each a Co-Creator. */
const group = (members: readonly string[]) => groupLog({ members });

/** Six voting members: Ana and five more. */
const SIX = ['Ben', 'Cal', 'Dee', 'Eve', 'Fay'];

/** Ben's election to seat 1, which everyone in Ana, Ben and Cal's group passes at once. */
function benElected() {
  const log = group(['Ben', 'Cal']);
  const proposal = log.steward('Ben', 1, 'Ben');
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  return { log, termEnd: START_MINUTE + 182 * DAY_MINUTES };
}

describe('seats and limits', () => {
  it('has two seats, empty before genesis', () => {
    expect(SEATS).toEqual([1, 2]);
    expect(EMPTY_SEATS).toEqual([
      { seat: 1, holder: null, termEnd: null, elected: false },
      { seat: 2, holder: null, termEnd: null, elected: false },
    ]);
  });

  it('gives seat 2 a first term of half the default term, 91 of 182 days', () => {
    expect(FIRST_SECOND_SEAT_TERM_DAYS).toBe(91);
    expect(2 * FIRST_SECOND_SEAT_TERM_DAYS).toBe(DEFAULT_RULES.stewards.termDays);
  });

  it('caps a reason at 280 code points and waits 30 days between suspensions (ADR-0072, ADR-0075)', () => {
    expect(REASON_MAX).toBe(280);
    expect(SUSPENSION_GAP_DAYS).toBe(30);
    expect(reasonFits(null)).toBe(true);
    expect(reasonFits('a'.repeat(280))).toBe(true);
    expect(reasonFits('a'.repeat(281))).toBe(false);
  });
});

describe('electionsDue', () => {
  it('is empty while the founder holds seat 1 in a group of 2 voting members', () => {
    expect(electionsDue(group(['Ben']).state())).toEqual([]);
  });

  it('falls due for seat 1 at 3 voting members, while the founder still holds it', () => {
    expect(electionsDue(group(['Ben', 'Cal']).state())).toEqual([1]);
  });

  it('isn’t due while a steward Proposal on the seat is open', () => {
    const log = group(['Ben', 'Cal']);
    log.steward('Ben', 1, 'Cal');
    expect(electionsDue(log.state())).toEqual([]);
  });

  it('isn’t due while an elected steward’s term runs, and falls due when it ends', () => {
    const { log, termEnd } = benElected();
    expect(seatOf(log.state(), BEN)?.termEnd).toBe(termEnd);
    expect(electionsDue(log.state(termEnd - 1))).toEqual([]);
    expect(electionsDue(log.state(termEnd))).toEqual([1]);
  });

  it('falls due for seat 2 too at 6 voting members, while it is empty', () => {
    expect(electionsDue(group(SIX).state())).toEqual([1, 2]);
  });

  it('falls due for seat 1 once a recall has emptied it', () => {
    const log = group(['Ben', 'Cal']);
    const recall = log.steward('Ben', 1, null);
    log.vote('Ben', recall, 4);
    log.vote('Cal', recall, 4);
    const state = log.state();
    expect(state.stewards[0]?.holder).toBeNull();
    expect(electionsDue(state)).toEqual([1]);
  });
});

describe('seatTakesElection and mayProposeSteward', () => {
  it('opens seat 2 at 6 voting members, not 5', () => {
    expect(seatTakesElection(group(SIX.slice(0, 4)).state(), 2)).toBe(false);
    expect(seatTakesElection(group(SIX).state(), 2)).toBe(true);
  });

  it('lets someone who may propose name a nominee who can stand, and nobody else', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    const state = log.state();
    expect(mayProposeSteward(state, BEN, { seat: 1, member: CAL })).toBe(true);
    expect(mayProposeSteward(state, CAL, { seat: 1, member: BEN })).toBe(false);
    expect(mayProposeSteward(state, BEN, { seat: 3, member: CAL })).toBe(false);
    expect(mayProposeSteward(state, BEN, { seat: 1, member: null })).toBe(true);
    expect(mayProposeSteward(state, BEN, { seat: 2, member: null })).toBe(false);
  });
});

describe('canStand', () => {
  it('lets a voting member stand, or the holder of the same seat, but not a suspended member or the other seat’s holder', () => {
    const log = group([...SIX, 'Kim']);
    log.suspend('Ana', 'Kim', 'Threats.');
    const state = log.state();
    expect(canStand(state, 1, CAL)).toBe(true);
    expect(canStand(state, 1, ANA)).toBe(true);
    expect(canStand(state, 2, ANA)).toBe(false);
    expect(canStand(state, 1, KIM)).toBe(false);
  });

  it('refuses a Member who follows', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    expect(canStand(log.state(), 1, KIM)).toBe(false);
  });
});

describe('maySuspend and activeSuspension', () => {
  it('lets the founder suspend another member, once at a time, and never themselves', () => {
    const log = group(['Ben', 'Kim']);
    const before = log.state();
    expect(maySuspend(before, ANA, KIM)).toBe(true);
    expect(maySuspend(before, ANA, ANA)).toBe(false);
    expect(maySuspend(before, BEN, KIM)).toBe(false);
    log.suspend('Ana', 'Kim', 'Threats.');
    const after = log.state();
    expect(mayUseSuspend(after, ANA)).toBe(false);
    expect(maySuspend(after, ANA, BEN)).toBe(false);
  });

  it('finds a running suspension until it ends, in relay minutes', () => {
    const log = group(['Kim']);
    log.suspend('Ana', 'Kim', 'Threats.');
    const until = START_MINUTE + 7 * DAY_MINUTES;
    expect(activeSuspension(log.state(until - 1), KIM)).toMatchObject({ by: ANA, until });
    expect(activeSuspension(log.state(until), KIM)).toBeUndefined();
    expect(activeSuspension(log.state(until - 1), ANA)).toBeUndefined();
  });
});

describe('seating on a pass', () => {
  it('seats no one when the nominee has stepped down to Member by the close', () => {
    const log = group(['Ben', 'Cal']);
    const proposal = log.steward('Ana', 1, 'Ben');
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    const passed = log.state();
    expect(passed.stewards[0]?.holder).toBe(BEN);
    const late = group(['Ben', 'Cal']);
    const again = late.steward('Ana', 1, 'Ben');
    late.vote('Ben', again, 4);
    late.level('Ben', FOLLOWING);
    late.vote('Ana', again, 4);
    late.vote('Cal', again, 4);
    const state = late.state(START_MINUTE + 7 * DAY_MINUTES);
    expect(state.proposals[0]?.outcome.kind).toBe('pass');
    expect(state.stewards[0]?.holder).toBe(ANA);
  });

  it('seats one person in one seat only: elected to both, they take the first to close', () => {
    const log = group(SIX);
    const second = log.steward('Ben', 2, 'Cal');
    const first = log.steward('Ben', 1, 'Cal');
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, second, 4);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, first, 4);
    const state = log.state(START_MINUTE + 7 * DAY_MINUTES);
    expect(state.proposals.map((p) => p.outcome.kind)).toEqual(['pass', 'pass']);
    expect(state.stewards.map((s) => s.holder)).toEqual([ANA, CAL]);
  });
});

describe('vacate', () => {
  it('empties only the seats the person holds, and keeps whether an election filled them', () => {
    const seats: Seat[] = [
      { seat: 1, holder: 'ana', termEnd: 9, elected: true },
      { seat: 2, holder: 'ben', termEnd: 5, elected: true },
    ];
    expect(vacate(seats, 'ana')).toEqual([
      { seat: 1, holder: null, termEnd: null, elected: true },
      { seat: 2, holder: 'ben', termEnd: 5, elected: true },
    ]);
    expect(vacate(seats, 'kim')).toEqual(seats);
  });
});

const WEBHOOK = { webhook: 'https://discord.com/api/webhooks/1/abc' };

/** Ana, Ben and Cal's group, which has turned its chat bot on by an entrenched pass. */
function botOn() {
  const log = group(['Ben', 'Cal']);
  const on = log.rules('Ana', 'chatBot', WEBHOOK);
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
  return log;
}

describe('narrowing an opt-in (ADR-0040, ADR-0075 §3)', () => {
  it('waits 30 days after an off-Proposal is turned down', () => {
    expect(NARROW_GAP_DAYS).toBe(30);
  });

  it('offers Turn off now to the steward while the bot is on, and to nobody else', () => {
    const state = botOn().state();
    expect(state.rules.optIns.chatBot).toEqual(WEBHOOK);
    expect(mayTurnOffNow(state, ANA, 'chatBot')).toBe(true);
    expect(mayTurnOffNow(state, BEN, 'chatBot')).toBe(false);
    expect(mayTurnOffNow(state, ANA, 'frontDoor')).toBe(false);
  });

  it('offers it to no steward who can’t propose the off-Proposal it needs', () => {
    const log = botOn();
    log.level('Ana', VOTING);
    expect(mayTurnOffNow(log.state(), ANA, 'chatBot')).toBe(false);
  });

  it('offers it to no steward while any rules Proposal for the opt-in is open, or a recall of them is', () => {
    const open = botOn();
    open.rules('Ben', 'chatBot', null);
    expect(mayTurnOffNow(open.state(), ANA, 'chatBot')).toBe(false);
    const recalled = botOn();
    recalled.steward('Ben', 1, null);
    expect(mayTurnOffNow(recalled.state(), ANA, 'chatBot')).toBe(false);
  });

  it('holds a narrow only beside the same steward’s own open off-Proposal for that opt-in', () => {
    const log = botOn();
    const off = log.rules('Ana', 'chatBot', null);
    const state = log.state();
    expect(mayNarrow(state, ANA, { optIn: 'chatBot', proposal: off })).toBe(true);
    expect(mayNarrow(state, ANA, { optIn: 'frontDoor', proposal: off })).toBe(false);
    expect(mayNarrow(state, ANA, { optIn: 'signalBot', proposal: off })).toBe(false);
    expect(mayNarrow(state, ANA, { optIn: 'chatBot', proposal: 'missing' })).toBe(false);
    expect(mayNarrow(state, BEN, { optIn: 'chatBot', proposal: off })).toBe(false);
    const theirs = botOn();
    const bens = theirs.rules('Ben', 'chatBot', null);
    expect(mayNarrow(theirs.state(), ANA, { optIn: 'chatBot', proposal: bens })).toBe(false);
  });

  it('refuses a narrow beside an on-Proposal, or once the off-Proposal has closed', () => {
    const log = group(['Ben', 'Cal']);
    const on = log.rules('Ana', 'frontDoor', DOOR);
    expect(mayNarrow(log.state(), ANA, { optIn: 'frontDoor', proposal: on })).toBe(false);
    const closed = botOn();
    const off = closed.rules('Ana', 'chatBot', null);
    for (const name of ['Ana', 'Ben', 'Cal']) closed.vote(name, off, 0, 'Keep it.');
    expect(mayNarrow(closed.state(), ANA, { optIn: 'chatBot', proposal: off })).toBe(false);
  });

  it('waits 30 days, to the minute, after the group turns an off-Proposal down', () => {
    const log = botOn();
    const off = log.rules('Ben', 'chatBot', null);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, off, 0, 'Keep it.');
    const closedAt = log.minute;
    expect(log.state().proposals.at(-1)?.outcome.kind).toBe('fail');
    expect(mayTurnOffNow(log.state(), ANA, 'chatBot')).toBe(false);
    const gap = NARROW_GAP_DAYS * DAY_MINUTES;
    expect(mayTurnOffNow(log.state(closedAt + gap), ANA, 'chatBot')).toBe(false);
    expect(mayTurnOffNow(log.state(closedAt + gap + 1), ANA, 'chatBot')).toBe(true);
  });

  it('doesn’t wait after an on-Proposal turned down, or after an off-Proposal that passed', () => {
    const log = group(['Ben', 'Cal']);
    const failed = log.rules('Ana', 'chatBot', WEBHOOK, { title: 'A bot' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, failed, 0, 'Not yet.');
    const on = log.rules('Ana', 'chatBot', WEBHOOK, { title: 'A bot, now' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
    expect(mayTurnOffNow(log.state(), ANA, 'chatBot')).toBe(true);
    const off = log.rules('Ben', 'chatBot', null);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, off, 4);
    const again = log.rules('Ana', 'chatBot', WEBHOOK, { title: 'The bot again' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, again, 4);
    expect(log.state().proposals.map((p) => p.outcome.kind)).toEqual([
      'fail',
      'pass',
      'pass',
      'pass',
    ]);
    expect(mayTurnOffNow(log.state(), ANA, 'chatBot')).toBe(true);
  });
});
