import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { DOOR, ROTATED } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { LEVELS } from './capabilities';
import { parseRecord } from './event';
import { EXPIRES_WITH_BALLOTS, expiringProposal, resultFor } from './expiry';
import { fold } from './fold';
import {
  cardClosedFor,
  inviteFor,
  isApplicationId,
  mayCloseCard,
  mayRecordInvite,
} from './frontDoor';

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
