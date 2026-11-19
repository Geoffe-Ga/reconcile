import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import {
  COVENANT_HASH,
  DOOR,
  doorOf,
  lapsedNarrowing,
  LISTED,
  RELISTED,
  RENEWED,
  ROTATED,
  secretOf,
} from '../test/door';
import { authorOf } from '../test/keys';
import { vector } from '../test/vectors';
import { groupLog, type LogBuilder } from '../test/votes';
import { LEVELS } from './capabilities';
import { parseRecord } from './event';
import { EXPIRES_WITH_BALLOTS, expiringProposal, resultFor } from './expiry';
import { fold } from './fold';
import {
  cardClosedFor,
  inviteFor,
  isApplicationId,
  listingHistory,
  listingInEffect,
  type ListingState,
  mayCloseCard,
  mayRecordInvite,
} from './frontDoor';
import { type FrontDoor, listedUnder } from './optIns';

/** The follower level, which reads but doesn't invite, by place, so no level id is spelled out here. */
const [FOLLOWING, VOTING] = LEVELS;

/** An application id: a SHA-256 in unpadded base64url, from repeated `byte`s. */
const application = (byte: number) => base64url(new Uint8Array(32).fill(byte));

const A1 = application(0xa1);
const A2 = application(0xa2);

/** Ana, Ben and Cal, then everyone votes to open the front door with `door`. */
function opened(door: unknown = DOOR, start: Parameters<typeof groupLog>[0] = {}): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'], ...start });
  const proposal = log.rules('Ana', 'frontDoor', door, { title: 'Open a front door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
  return log;
}

describe('isApplicationId: a SHA-256 in canonical unpadded base64url', () => {
  it('takes 43 base64url characters that spell 32 bytes one way', () => {
    expect(isApplicationId(A1)).toBe(true);
    expect(isApplicationId(application(0))).toBe(true);
  });

  it.each([
    ['42 characters', A1.slice(0, 42)],
    ['44 characters', `${A1}A`],
    ['a character base64url lacks', `${A1.slice(0, 42)}=`],
    ['a last character with a spare bit set', `${A1.slice(0, 42)}B`],
    ['a number', 7],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(isApplicationId(value)).toBe(false);
  });
});

describe('listingInEffect: a listing ends with its door (#485; listed-doors.md §3.3)', () => {
  it('gives the covenant a door open in effect is listed under', () => {
    expect(listingInEffect(opened(LISTED).state())).toBe(COVENANT_HASH);
  });

  it('gives null for a closed door, and for an open one that isn’t listed', () => {
    expect(listingInEffect(groupLog({ members: ['Ben', 'Cal'] }).state())).toBeNull();
    expect(listingInEffect(opened(DOOR).state())).toBeNull();
    expect(listingInEffect(opened({ ...DOOR, listed: false }).state())).toBeNull();
  });

  it('ends when a membership ends and the fold closes the door (#288)', () => {
    const log = opened(LISTED);
    log.leave('Cal');
    log.minute += 1;
    const state = log.state();
    expect(state.optIns.frontDoor).toBe(false);
    expect(listingInEffect(state)).toBeNull();
  });

  it('ends while a steward’s narrowing holds the door shut', () => {
    const log = opened(LISTED);
    const off = log.rules('Ana', 'frontDoor', false, { title: 'Close the front door' });
    log.narrow('Ana', 'frontDoor', off);
    log.minute += 1;
    expect(listingInEffect(log.state())).toBeNull();
  });
});

/** Adds a front door change to `value` by Ben that everyone passes, returning its id. */
function passed(log: LogBuilder, value: unknown): string {
  // Its own title, so no two changes are the same event.
  const proposal = log.rules('Ben', 'frontDoor', value, { title: `Change ${String(log.minute)}` });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
  return proposal;
}

describe('listingInEffect: a steward’s narrowing ends a listing for good (#501; listed-doors.md §3.3)', () => {
  it('stays ended once the narrowing lapses and the door reopens, listed as it stood', () => {
    const state = lapsedNarrowing(opened(LISTED)).state();
    expect(state.proposals.map((p) => p.outcome.kind)).toEqual(['pass', 'fail']);
    // The door stands open and listed again in effect: only the listing has ended.
    expect(state.optIns.frontDoor).toEqual(LISTED);
    expect(listingInEffect(state)).toBeNull();
    expect(listingHistory(state)).toEqual({
      address: LISTED.sign,
      ended: true,
      final: new Set([LISTED.sign]),
    });
  });

  it('stays ended through changes at its final address: the count, another covenant', () => {
    const log = lapsedNarrowing(opened(LISTED));
    passed(log, { ...LISTED, showCount: true });
    passed(log, { ...RENEWED, showCount: true });
    expect(log.state().rules.optIns.frontDoor).toEqual({ ...RENEWED, showCount: true });
    expect(listingInEffect(log.state())).toBeNull();
    expect(listingHistory(log.state())).toEqual({
      address: LISTED.sign,
      ended: true,
      final: new Set([LISTED.sign]),
    });
  });

  it('lists again by one entrenched Proposal at new keys, though the standing value reads listed', () => {
    const log = lapsedNarrowing(opened(LISTED));
    const relist = passed(log, RELISTED);
    const state = log.state();
    expect(state.proposals.find((p) => p.id === relist)?.class).toBe('entrenched');
    expect(listingInEffect(state)).toBe(COVENANT_HASH);
    expect(listingHistory(state)).toEqual({
      address: ROTATED.sign,
      ended: false,
      final: new Set([LISTED.sign]),
    });
  });

  it('holds a relisting to the entrenched bar: 2.67 that an ordinary change would pass fails it', () => {
    const log = lapsedNarrowing(opened(LISTED));
    const relist = log.rules('Ben', 'frontDoor', RELISTED);
    log.vote('Ana', relist, 3);
    log.vote('Ben', relist, 2);
    log.vote('Cal', relist, 3);
    log.minute += 20_160;
    const state = log.state();
    expect(state.proposals.find((p) => p.id === relist)?.outcome.kind).toBe('fail');
    expect(state.rules.optIns.frontDoor).toEqual(LISTED);
    expect(listingInEffect(state)).toBeNull();
  });

  it('begins again only from an unlisted door, at an address no listing has used', () => {
    const log = lapsedNarrowing(opened(LISTED));
    passed(log, DOOR);
    expect(listingHistory(log.state())).toEqual({
      address: null,
      ended: false,
      final: new Set([LISTED.sign]),
    });
    // Listing the same address again shows nothing: the shelf's copy there is final.
    const same = passed(log, LISTED);
    expect(listingInEffect(log.state())).toBeNull();
    expect(listingHistory(log.state()).ended).toBe(true);
    expect(log.state().proposals.find((p) => p.id === same)?.class).toBe('entrenched');
    passed(log, DOOR);
    passed(log, RELISTED);
    expect(listingInEffect(log.state())).toBe(COVENANT_HASH);
  });

  it('orders by relay order, not relay minute: a narrowing, its turn-down and a relisting in one minute', () => {
    const log = opened(LISTED);
    const off = log.rules('Ana', 'frontDoor', false, { title: 'Close the front door' });
    log.narrow('Ana', 'frontDoor', off);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, off, 0, 'Keep it open.');
    const minute = log.minute;
    for (const value of [DOOR, RELISTED]) {
      const change = log.rules('Ben', 'frontDoor', value, {
        title: `To ${listedUnder(value) ?? 'unlisted'}`,
      });
      for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, change, 4);
    }
    const state = log.state();
    expect(log.minute).toBe(minute);
    expect(state.proposals.map((p) => p.outcome.kind)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(listingInEffect(state)).toBe(COVENANT_HASH);
  });

  it('reads the history a Proposal found when it opened, leaving out what came at or after it', () => {
    const log = lapsedNarrowing(opened(LISTED));
    const unlist = log.rules('Ben', 'frontDoor', DOOR);
    const state = log.state();
    const proposal = state.proposals.find((p) => p.id === unlist);
    if (proposal === undefined) throw new Error('expected the unlisting Proposal');
    expect(listingHistory(state, proposal).ended).toBe(true);
    const off = state.proposals.find((p) => p.target.kind === 'rules' && p.target.value === false);
    if (off === undefined) throw new Error('expected the off-Proposal');
    // The off-Proposal opened before its narrowing, onto a listing in effect.
    expect(listingHistory(state, off)).toEqual({
      address: LISTED.sign,
      ended: false,
      final: new Set(),
    });
  });

  it('ends with the door when a membership ends, leaving its address final (#288)', () => {
    const log = lapsedNarrowing(opened(LISTED));
    log.leave('Cal');
    log.minute += 1;
    expect(listingHistory(log.state())).toEqual({
      address: null,
      ended: false,
      final: new Set([LISTED.sign]),
    });
  });

  it('ends nothing when the narrowed door wasn’t listed, and counts no exposed pass', () => {
    const state = lapsedNarrowing(opened(DOOR)).state();
    expect(listingHistory(state)).toEqual({ address: null, ended: false, final: new Set() });
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const listing = log.rules('Ana', 'frontDoor', LISTED);
    log.vote('Ana', listing, 4);
    log.leave('Cal');
    log.vote('Ben', listing, 4);
    log.minute += 20_160;
    const exposed = log.state();
    expect(exposed.exposedDoors).toEqual([listing]);
    expect(listingHistory(exposed).address).toBeNull();
  });

  it('keeps a listing that moves to new keys while it shows, and finalizes the address it left', () => {
    const log = opened(LISTED);
    passed(log, { ...doorOf(0x55, 0x66), listed: true, covenant: COVENANT_HASH });
    expect(listingInEffect(log.state())).toBe(COVENANT_HASH);
    expect(listingHistory(log.state()).final).toEqual(new Set([LISTED.sign]));
  });
});

/** A step of a made-up history: a front door change that passed, or a steward's narrowing that lapsed. */
type Step =
  { readonly kind: 'narrow' } | { readonly kind: 'pass'; readonly value: FrontDoor | false };

/** The listing state `steps` leave, each ten minutes after the last, with every pass closed at once. */
function historyOf(steps: readonly Step[]): ListingState {
  let standing: FrontDoor | false = false;
  const proposals: ListingState['proposals'][number][] = [];
  const narrowings: ListingState['narrowings'][number][] = [];
  for (const [index, step] of steps.entries()) {
    const at = (index + 1) * 10;
    const id = `@${String(index + 1)}`;
    if (step.kind === 'narrow') {
      // Its off-Proposal is nowhere among the passes: the narrowing has lapsed.
      narrowings.push({
        id,
        seq: index + 1,
        received: at,
        by: 'ana',
        optIn: 'frontDoor',
        proposal: 'off',
      });
      continue;
    }
    const target = {
      kind: 'rules',
      optIn: 'frontDoor',
      value: step.value,
      from: standing,
    } as const;
    proposals.push({
      id,
      author: 'ana',
      seq: index + 1,
      received: at,
      deadline: at + 5,
      closedAt: at + 1,
      final: true,
      outcome: { kind: 'pass' },
      target,
    });
    standing = step.value;
  }
  const optIns = { chatBot: null, frontDoor: standing };
  return {
    rules: { optIns },
    proposals,
    narrowings,
    exposedDoors: [],
    at: steps.length * 10 + 100,
  };
}

const byte = fc.integer({ min: 0, max: 3 });
/** A door at one of four addresses, listed or not. */
const doorStep = fc
  .record({ sign: byte, listed: fc.boolean() })
  .map(({ sign, listed }): FrontDoor => {
    const door = doorOf(sign, 0x22);
    return listed ? { ...door, listed: true, covenant: COVENANT_HASH } : door;
  });
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: 'narrow' }),
  fc.oneof(fc.constant<false>(false), doorStep).map((value): Step => ({ kind: 'pass', value })),
);
/** A change that keeps {@link LISTED}'s address listed: the count, another covenant. */
const keepsAddress = fc
  .record({ count: fc.boolean(), covenant: fc.constantFrom(COVENANT_HASH, secretOf(0x5b)) })
  .map(({ count, covenant }): Step => ({
    kind: 'pass',
    value: { ...LISTED, showCount: count, covenant },
  }));
const LISTS: Step = { kind: 'pass', value: LISTED };

describe('listingInEffect: the golden vectors (#501; listed-door-narrowed.json)', () => {
  const ADDRESS = base64url(new Uint8Array(32).fill(17));
  const MOVED = base64url(new Uint8Array(32).fill(51));
  /** The vector named `name`, folded at its relay `now`. */
  const folded = (name: string) => {
    const { records, relayNow } = vector(name);
    return fold(records, relayNow);
  };

  it('reads the listing a lapsed narrowing met as ended, while the door stands listed', () => {
    const state = folded('listed-door-narrowed');
    expect(listingInEffect(state)).toBeNull();
    expect(listingHistory(state)).toEqual({
      address: ADDRESS,
      ended: true,
      final: new Set([ADDRESS]),
    });
  });

  it('lists the door again at its new address by one entrenched Proposal', () => {
    const state = folded('listed-door-relist');
    expect(state.proposals.at(-1)?.class).toBe('entrenched');
    expect(listingInEffect(state)).toBe(base64url(new Uint8Array(32).fill(90)));
    expect(listingHistory(state)).toEqual({
      address: MOVED,
      ended: false,
      final: new Set([ADDRESS]),
    });
  });

  it('holds that relisting to the entrenched bar, where older builds held it to the ordinary one', () => {
    const state = folded('listed-door-relist-bar');
    expect(state.proposals.at(-1)?.class).toBe('entrenched');
    expect(state.proposals.at(-1)?.outcome.kind).toBe('fail');
    expect(listingInEffect(state)).toBeNull();
    expect(listingHistory(state)).toEqual({
      address: ADDRESS,
      ended: true,
      final: new Set([ADDRESS]),
    });
  });
});

describe('listingHistory: properties (#501; listed-doors.md §3.3)', () => {
  it('never reads a listing in effect at an address a listing left', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
        const state = historyOf(steps);
        const door = state.rules.optIns.frontDoor;
        if (listingInEffect(state) === null || door === false) return;
        expect(listingHistory(state).final.has(door.sign)).toBe(false);
      }),
    );
  });

  it('reads a listing a narrowing met as ended for good, through every change that keeps its address', () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 8 }),
        fc.array(keepsAddress, { maxLength: 6 }),
        (before, after) => {
          const narrowed = [...before, LISTS, { kind: 'narrow' } as const];
          expect(listingInEffect(historyOf([...narrowed, ...after]))).toBeNull();
        },
      ),
    );
  });

  it('lists again at an address no listing has used, straight from the ended listing or from unlisted', () => {
    const off = fc.constantFrom<Step[]>(
      [],
      [{ kind: 'pass', value: false }],
      [{ kind: 'pass', value: DOOR }],
    );
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 8 }),
        off,
        fc.array(keepsAddress, { maxLength: 3 }),
        (before, unlists, kept) => {
          const fresh: Step = {
            kind: 'pass',
            value: { ...doorOf(0x99, 0x98), listed: true, covenant: COVENANT_HASH },
          };
          const steps = [...before, LISTS, { kind: 'narrow' } as const, ...kept, ...unlists, fresh];
          expect(listingInEffect(historyOf(steps))).toBe(COVENANT_HASH);
        },
      ),
    );
  });
});

describe('mayRecordInvite: who may record an invite sent from the front door (#121)', () => {
  it('lets a member who may invite record one while the door is open', () => {
    const state = opened().state();
    expect(state.optIns.frontDoor).toEqual(DOOR);
    expect(mayRecordInvite(state, authorOf('ben'), A1)).toBe(true);
  });

  it('refuses while the door has never opened', () => {
    const state = groupLog({ members: ['Ben', 'Cal'] }).state();
    expect(mayRecordInvite(state, authorOf('ben'), A1)).toBe(false);
  });

  it('refuses while a steward’s narrowing holds the door shut', () => {
    const log = opened();
    const off = log.rules('Ana', 'frontDoor', false, { title: 'Close the front door' });
    log.narrow('Ana', 'frontDoor', off);
    log.minute += 1;
    expect(mayRecordInvite(log.state(), authorOf('ben'), A1)).toBe(false);
  });

  it('refuses someone who can’t invite: a follower, a newcomer, or no member', () => {
    const log = opened(DOOR, { levels: { Cal: FOLLOWING }, newcomers: ['Dee'] });
    const state = log.state();
    expect(mayRecordInvite(state, authorOf('cal'), A1)).toBe(false);
    expect(mayRecordInvite(state, authorOf('dee'), A1)).toBe(false);
    expect(mayRecordInvite(state, authorOf('zed'), A1)).toBe(false);
  });

  it('refuses an application id that isn’t a SHA-256, and one already recorded', () => {
    const log = opened();
    log.doorInvited('Ben', A1);
    const state = log.state();
    expect(mayRecordInvite(state, authorOf('cal'), 'not-an-id')).toBe(false);
    expect(mayRecordInvite(state, authorOf('cal'), A1)).toBe(false);
    expect(mayRecordInvite(state, authorOf('cal'), A2)).toBe(true);
  });
});

describe('door-invited in the fold (#121)', () => {
  it('keeps the first per application, in relay order, with who sent it', () => {
    const log = opened(DOOR, { levels: { Cal: VOTING } });
    const first = log.doorInvited('Cal', A1);
    log.minute += 1;
    const second = log.doorInvited('Ben', A1);
    const other = log.doorInvited('Ben', A2);
    const state = log.state();
    expect(state.doorInvites).toEqual([
      {
        id: first,
        seq: expect.any(Number) as number,
        received: state.at - 1,
        by: authorOf('cal'),
        application: A1,
      },
      {
        id: other,
        seq: expect.any(Number) as number,
        received: state.at,
        by: authorOf('ben'),
        application: A2,
      },
    ]);
    expect(state.ignored.map((record) => record.id)).toEqual([second]);
    expect(inviteFor(state, A1)?.by).toBe(authorOf('cal'));
    expect(inviteFor(state, application(0xff))).toBeUndefined();
  });

  it('keeps each invite through a rotation of the door’s keys, and takes new ones after it', () => {
    const log = opened();
    log.doorInvited('Ben', A1);
    const rotate = log.rules('Ana', 'frontDoor', ROTATED, { title: 'A new address' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, rotate, 4);
    log.minute += 1;
    log.doorInvited('Cal', A2);
    const state = log.state();
    expect(state.optIns.frontDoor).toEqual(ROTATED);
    expect(state.doorInvites.map((invite) => invite.application)).toEqual([A1, A2]);
  });

  it('ignores one while the door is closed, and holds none in a new group', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const early = log.doorInvited('Ben', A1);
    const state = log.state();
    expect(state.doorInvites).toEqual([]);
    expect(state.ignored.map((record) => record.id)).toEqual([early]);
  });
});

describe('door-invited beside a removal (#115)', () => {
  it('refuses the person a passed removal names, and keeps the invite they recorded before it', () => {
    const log = opened(DOOR, { levels: { Cal: VOTING } });
    const before = log.doorInvited('Cal', A1);
    const removal = log.proposeRemoval('Ana', 'Cal');
    for (const name of ['Ana', 'Ben']) log.vote(name, removal, 4);
    log.minute += 1;
    expect(mayRecordInvite(log.state(), authorOf('cal'), A2)).toBe(false);
    const after = log.doorInvited('Cal', A2);
    const state = log.state();
    expect(state.doorInvites.map((invite) => invite.id)).toEqual([before]);
    expect(state.ignored.map((record) => record.id)).toContain(after);
    expect(mayRecordInvite(state, authorOf('ben'), A2)).toBe(true);
  });
});

describe('a cleared “open a front door” Proposal (#111)', () => {
  /** 30 days in relay minutes: how long ballots outlive a decision. */
  const THIRTY_DAYS = 43_200;

  it('keeps the door open with its keys, its outcome and the invites recorded after it, once its ballots expire', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR, { title: 'Open a front door' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.minute += 1;
    const [opened] = log.state().proposals;
    if (opened === undefined) throw new Error('Expected the opening Proposal.');
    log.result('Cal', resultFor(opened));
    log.doorInvited('Ben', A1);
    const now = log.minute + THIRTY_DAYS;
    const held = log.state(now);
    const kept = log.records.filter((record) => parseRecord(record.bytes)?.event.type !== 'vote');

    const cleared = fold(kept, now, [], [open]);

    expect(held.optIns.frontDoor).toEqual(DOOR);
    expect(cleared.rules.optIns.frontDoor).toEqual(DOOR);
    expect(cleared.optIns.frontDoor).toEqual(DOOR);
    expect(cleared.proposals[0]).toMatchObject({
      id: open,
      cleared: true,
      final: true,
      class: 'entrenched',
      outcome: { kind: 'pass' },
      ballots: [],
    });
    expect(cleared.proposals[0]?.outcome).toEqual(held.proposals[0]?.outcome);
    expect(cleared.doorInvites).toEqual(held.doorInvites);
    expect(mayRecordInvite(cleared, authorOf('cal'), A2)).toBe(true);
  });

  it('expires nothing of the door’s own: no door-invited goes with a Proposal’s ballots', () => {
    const log = opened();
    const invite = log.doorInvited('Ben', A1);
    const [record] = log.records.filter((r) => parseRecord(r.bytes)?.id === invite);
    const event = record === undefined ? null : parseRecord(record.bytes)?.event;
    expect(event?.type).toBe('door-invited');
    expect(event === null || event === undefined ? 'missing' : expiringProposal(event)).toBeNull();
    expect(EXPIRES_WITH_BALLOTS).not.toContain('door-invited');
  });
});

describe('door-card-closed: a card from the front door brought to a vote or dismissed (#426)', () => {
  const C1 = application(0xc1);
  const C2 = application(0xc2);

  it('lets anyone who may propose close one, the door open or not, once per card', () => {
    const log = opened(DOOR, { levels: { Cal: VOTING } });
    expect(mayCloseCard(log.state(), authorOf('ben'), C1)).toBe(true);
    // A Collaborator may invite but not propose, and closing a card speaks for the group.
    expect(mayCloseCard(log.state(), authorOf('cal'), C1)).toBe(false);
    const first = log.doorCardClosed('Ben', C1);
    log.minute += 1;
    const second = log.doorCardClosed('Ana', C1);
    const other = log.doorCardClosed('Ana', C2);
    const state = log.state();
    expect(state.doorCardsClosed).toEqual([
      {
        id: first,
        seq: expect.any(Number) as number,
        received: state.at - 1,
        by: authorOf('ben'),
        card: C1,
      },
      {
        id: other,
        seq: expect.any(Number) as number,
        received: state.at,
        by: authorOf('ana'),
        card: C2,
      },
    ]);
    expect(state.ignored.map((record) => record.id)).toEqual([second]);
    expect(cardClosedFor(state, C1)?.by).toBe(authorOf('ben'));
    expect(cardClosedFor(state, application(0xff))).toBeUndefined();
    expect(mayCloseCard(state, authorOf('ana'), C1)).toBe(false);
  });

  it('ignores one from a Collaborator, a follower, a newcomer or no member, or naming no SHA-256', () => {
    const log = groupLog({
      members: ['Ben', 'Cal', 'Dan'],
      levels: { Cal: VOTING, Dan: FOLLOWING },
      newcomers: ['Dee'],
    });
    const ignored = [
      log.doorCardClosed('Cal', C1),
      log.doorCardClosed('Dan', C1),
      log.doorCardClosed('Dee', C1),
      log.doorCardClosed('Zed', C1),
      log.doorCardClosed('Ben', 'not-a-card'),
    ];
    const state = log.state();
    expect(state.doorCardsClosed).toEqual([]);
    expect(state.ignored.map((record) => record.id)).toEqual(ignored);
    // With no front door ever opened, a proposer still closes one: nothing else hangs on it.
    log.doorCardClosed('Ben', C1);
    expect(log.state().doorCardsClosed.map((closed) => closed.card)).toEqual([C1]);
  });

  it('expires nothing with ballots: a closed card stays closed', () => {
    expect(EXPIRES_WITH_BALLOTS).not.toContain('door-card-closed');
  });
});
