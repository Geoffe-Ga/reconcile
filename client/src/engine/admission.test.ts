import { describe, expect, it } from 'vitest';

import {
  type AdmissionState,
  admissionOf,
  bootstrapOpen,
  earnedAt,
  mayVouch,
  rightsAt,
  type Vouch,
  vouchesFor,
  vouchWanted,
  waitEnd,
} from './admission';
import { LEVELS } from './capabilities';
import { DEFAULT_RULES, type Rules } from './rules';

const [FOLLOWING, VOTING, CREATING] = LEVELS;

/** Kim joins at this relay minute, as in vouch-wait-boundary.json. */
const JOINED = 1_000_000;

/** Fourteen days of relay minutes after {@link JOINED}. */
const WAIT_END = 1_020_160;

/** A valid vouch from `by` for `to`, received at `received`. */
function vouch(by: string, to: string, received: number): Vouch {
  return { id: `${by}-${to}-${String(received)}`, seq: received, received, by, member: to };
}

/**
 * Ana (founder), Ben and Cal hold rights; Ben follows as a Member. Kim joined
 * at {@link JOINED} and Ana has vouched for her once. Dee is a newcomer too.
 * Gus held rights and has left. The group goes on: it hasn't dissolved.
 * Relay time stands a day after Kim's join.
 */
function group(overrides: Partial<AdmissionState> = {}): AdmissionState {
  return {
    rules: DEFAULT_RULES,
    members: [
      { author: 'ana', level: CREATING, received: 1, rightsAt: 1 },
      { author: 'ben', level: FOLLOWING, received: 2, rightsAt: 2 },
      { author: 'cal', level: VOTING, received: 3, rightsAt: 3 },
      { author: 'kim', level: VOTING, received: JOINED, rightsAt: null },
      { author: 'dee', level: CREATING, received: JOINED + 1, rightsAt: null },
    ],
    former: [{ author: 'gus', received: 4, rightsAt: 4 }],
    vouches: [vouch('ana', 'kim', JOINED + 10)],
    dissolved: null,
    stewards: [],
    suspensions: [],
    removals: [],
    at: JOINED + 1_440,
    ...overrides,
  };
}

describe('waitEnd', () => {
  it('ends the wait waitDays × 1,440 relay minutes after the join', () => {
    expect(waitEnd(DEFAULT_RULES, JOINED)).toBe(WAIT_END);
    expect(waitEnd({ ...DEFAULT_RULES, waitDays: 1 }, JOINED)).toBe(JOINED + 1_440);
  });
});

describe('earnedAt', () => {
  it('gives no rights with fewer vouches than the rules ask for', () => {
    expect(earnedAt(DEFAULT_RULES, JOINED, [])).toBeNull();
    expect(earnedAt(DEFAULT_RULES, JOINED, [vouch('ana', 'kim', JOINED + 1)])).toBeNull();
  });

  it('gives rights when the wait ends, once two vouches came before it', () => {
    const two = [vouch('ana', 'kim', JOINED + 1), vouch('cal', 'kim', JOINED + 2)];
    expect(earnedAt(DEFAULT_RULES, JOINED, two)).toBe(WAIT_END);
  });

  it('gives rights at the second vouch when it comes after the wait', () => {
    const two = [vouch('ana', 'kim', JOINED + 1), vouch('cal', 'kim', WAIT_END + 7)];
    expect(earnedAt(DEFAULT_RULES, JOINED, two)).toBe(WAIT_END + 7);
  });

  it('reads the second vouch, not a later third one', () => {
    const three = [
      vouch('ana', 'kim', JOINED + 1),
      vouch('cal', 'kim', JOINED + 2),
      vouch('eve', 'kim', WAIT_END + 50),
    ];
    expect(earnedAt(DEFAULT_RULES, JOINED, three)).toBe(WAIT_END);
  });

  it('asks for as many vouches as the rules name', () => {
    const rules: Rules = { ...DEFAULT_RULES, vouches: 3 };
    const two = [vouch('ana', 'kim', JOINED + 1), vouch('cal', 'kim', JOINED + 2)];
    expect(earnedAt(rules, JOINED, two)).toBeNull();
    expect(earnedAt(rules, JOINED, [...two, vouch('eve', 'kim', JOINED + 3)])).toBe(WAIT_END);
  });
});

describe('rightsAt', () => {
  it('reads a member’s rights, and a former member’s', () => {
    expect(rightsAt(group(), 'ana')).toBe(1);
    expect(rightsAt(group(), 'kim')).toBeNull();
    expect(rightsAt(group(), 'gus')).toBe(4);
  });

  it('is null for someone who never joined', () => {
    expect(rightsAt(group(), 'zed')).toBeNull();
  });
});

describe('vouchesFor', () => {
  it('lists the vouches for one member, in relay order', () => {
    const vouches = [
      vouch('ana', 'kim', JOINED + 10),
      vouch('ana', 'dee', JOINED + 11),
      vouch('cal', 'kim', JOINED + 12),
    ];
    expect(vouchesFor({ vouches }, 'kim').map((v) => v.by)).toEqual(['ana', 'cal']);
    expect(vouchesFor({ vouches }, 'ben')).toEqual([]);
  });
});

describe('mayVouch', () => {
  it('lets a voting member with rights vouch for another member once', () => {
    expect(mayVouch(group(), 'cal', 'kim')).toBe(true);
    expect(mayVouch(group(), 'ana', 'dee')).toBe(true);
  });

  it('refuses a duplicate', () => {
    expect(mayVouch(group(), 'ana', 'kim')).toBe(false);
  });

  it('refuses a Member, and a newcomer at a voting level without rights', () => {
    expect(mayVouch(group(), 'ben', 'kim')).toBe(false);
    expect(mayVouch(group(), 'dee', 'kim')).toBe(false);
  });

  it('refuses a self-vouch', () => {
    expect(mayVouch(group(), 'cal', 'cal')).toBe(false);
  });

  it('refuses a vouch for a non-member or a former member', () => {
    expect(mayVouch(group(), 'cal', 'zed')).toBe(false);
    expect(mayVouch(group(), 'cal', 'gus')).toBe(false);
  });

  it('refuses a suspended member, and someone who has left', () => {
    const suspended = group({ suspensions: [{ member: 'cal', until: JOINED + 2_000 }] });
    expect(mayVouch(suspended, 'cal', 'kim')).toBe(false);
    expect(mayVouch(group(), 'gus', 'kim')).toBe(false);
  });

  it('refuses every vouch once the group has dissolved (#108), as the fold does', () => {
    const dissolved = group({ dissolved: { received: JOINED + 1_000, wipe: false } });
    expect(mayVouch(dissolved, 'cal', 'kim')).toBe(false);
    expect(mayVouch(dissolved, 'ana', 'dee')).toBe(false);
  });
});

describe('bootstrapOpen', () => {
  const founder = { author: 'ana', level: CREATING, received: 1, rightsAt: 1 };
  const joiner = (author: string, received: number) => ({
    author,
    level: FOLLOWING,
    received,
    rightsAt: received,
  });

  it('stays open while fewer than firstElectionAt people have held rights, the founder included', () => {
    expect(bootstrapOpen(group({ members: [founder], former: [] }))).toBe(true);
    expect(bootstrapOpen(group({ members: [founder, joiner('ben', 2)], former: [] }))).toBe(true);
  });

  it('closes at three, counting people who hold rights whatever their level', () => {
    const members = [founder, joiner('ben', 2), joiner('cal', 3)];
    expect(bootstrapOpen(group({ members, former: [] }))).toBe(false);
  });

  it('stays closed after one of the first three leaves', () => {
    const members = [founder, joiner('ben', 2)];
    expect(bootstrapOpen(group({ members, former: [joiner('cal', 3)] }))).toBe(false);
  });

  it('counts nobody whose rights haven’t arrived', () => {
    const waiting = { ...joiner('kim', 2), rightsAt: null };
    const later = { ...joiner('dee', 3), rightsAt: JOINED + 1_441 };
    expect(bootstrapOpen(group({ members: [founder, waiting, later], former: [] }))).toBe(true);
  });

  it('reads its threshold from the steward rules (ADR-0049)', () => {
    const rules: Rules = {
      ...DEFAULT_RULES,
      stewards: { ...DEFAULT_RULES.stewards, firstElectionAt: 4 },
    };
    const members = [founder, joiner('ben', 2), joiner('cal', 3)];
    expect(bootstrapOpen(group({ rules, members, former: [] }))).toBe(true);
  });
});

describe('admissionOf', () => {
  it('shows a newcomer’s vouchers, the vouches needed and when the wait ends', () => {
    expect(admissionOf(group(), 'kim')).toEqual({
      vouchedBy: ['ana'],
      needed: 2,
      waitEnd: WAIT_END,
      rightsAt: null,
    });
  });

  it('shows when rights arrive once a newcomer has their vouches', () => {
    const vouches = [vouch('ana', 'kim', JOINED + 10), vouch('cal', 'kim', JOINED + 11)];
    const members = group().members.map((m) =>
      m.author === 'kim' ? { ...m, rightsAt: WAIT_END } : m,
    );
    expect(admissionOf(group({ vouches, members }), 'kim')).toEqual({
      vouchedBy: ['ana', 'cal'],
      needed: 2,
      waitEnd: WAIT_END,
      rightsAt: WAIT_END,
    });
  });

  it('is null for someone who holds rights, from the minute they arrive', () => {
    expect(admissionOf(group(), 'ana')).toBeNull();
    const members = group().members.map((m) =>
      m.author === 'kim' ? { ...m, rightsAt: WAIT_END } : m,
    );
    expect(admissionOf(group({ members, at: WAIT_END }), 'kim')).toBeNull();
    expect(admissionOf(group({ members, at: WAIT_END - 1 }), 'kim')).not.toBeNull();
  });

  it('is null for someone who isn’t a member', () => {
    expect(admissionOf(group(), 'zed')).toBeNull();
    expect(admissionOf(group(), 'gus')).toBeNull();
  });
});

describe('vouchWanted', () => {
  it('offers Vouch to a member who may vouch for a newcomer still short of vouches', () => {
    expect(vouchWanted(group(), 'cal', 'kim')).toBe(true);
  });

  it('offers nothing once the newcomer has every vouch they need', () => {
    const eve = { author: 'eve', level: VOTING, received: 5, rightsAt: 5 };
    const members = [...group().members, eve];
    const vouches = [vouch('ana', 'kim', JOINED + 10), vouch('cal', 'kim', JOINED + 12)];
    expect(vouchWanted(group({ members }), 'eve', 'kim')).toBe(true);
    expect(vouchWanted(group({ members, vouches }), 'eve', 'kim')).toBe(false);
  });

  it('offers nothing in a dissolved group (#108), whose copy only reads', () => {
    const dissolved = group({ dissolved: { received: JOINED + 1_000, wipe: true } });
    expect(vouchWanted(dissolved, 'cal', 'kim')).toBe(false);
    expect(vouchWanted(dissolved, 'ana', 'dee')).toBe(false);
  });

  it('offers nothing for someone who holds rights, or to someone who may not vouch', () => {
    expect(vouchWanted(group(), 'cal', 'ben')).toBe(false);
    expect(vouchWanted(group(), 'ana', 'kim')).toBe(false);
    expect(vouchWanted(group(), 'ben', 'kim')).toBe(false);
  });
});
