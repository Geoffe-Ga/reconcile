/**
 * The steward's notices (#488; docs/spec/listed-doors.md §4.3 rules 1 and 8,
 * §6.1): signed with the steward's key, and folded only when they verify
 * against the key pinned in `steward.ts`: a release, and #489's hold,
 * uphold, suspend and pause.
 */
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { verifyShelfRecord } from '../crypto/shelf';
import { newSigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { releaseRecord, STEWARD_ADDRESS, TEST_PINS, TEST_STEWARD } from '../test/steward';
import { foldNotices, HOLD_MINUTES, holdStands, isHeld, signNotice } from './notices';
import { encodeShelfBody, type NoticeBody, parseShelfBody, signShelfBody } from './record';
import { STEWARD_PINS } from './steward';

const OAK = base64url(newSigningKeys().publicKey);
const BIRCH = base64url(newSigningKeys().publicKey);

const ID = base64url(new Uint8Array(32).fill(4));
const OTHER_ID = base64url(new Uint8Array(32).fill(5));

/** `body` signed by the tests' steward and served under its address at `seq`. */
function notice(body: NoticeBody, seq = 1, received = 1000): ShelfRecord {
  return { seq, received, address: STEWARD_ADDRESS, data: signNotice(TEST_STEWARD.signing, body) };
}

describe('signNotice', () => {
  it('signs a notice as a shelf record the steward’s address verifies', () => {
    const body: NoticeBody = { v: 1, kind: 'notice', act: 'release', address: OAK };
    const record = signNotice(TEST_STEWARD.signing, body);
    const message = verifyShelfRecord(record, STEWARD_ADDRESS);

    expect(message && parseShelfBody(message)).toEqual(body);
    expect(message && Array.from(message)).toEqual(Array.from(encodeShelfBody(body)));
  });
});

describe('foldNotices', () => {
  it('releases each address a pinned release names, whatever their order', () => {
    const records = [releaseRecord(BIRCH, 9, 5), releaseRecord(OAK, 4, 5)];

    expect(foldNotices(records).released).toEqual(new Set([OAK, BIRCH]));
    expect(foldNotices([...records].reverse()).released).toEqual(new Set([OAK, BIRCH]));
  });

  it('pins the tests’ steward key in place of the app’s', () => {
    expect(STEWARD_PINS).toEqual(TEST_PINS);
  });

  it('ignores a release any other key signed, under its own address or the steward’s', () => {
    const thief = newSigningKeys();
    const body: NoticeBody = { v: 1, kind: 'notice', act: 'release', address: OAK };
    const own = { seq: 1, received: 1, address: base64url(thief.publicKey) };
    const records = [
      { ...own, data: signNotice(thief, body) },
      { ...own, address: STEWARD_ADDRESS, data: signNotice(thief, body) },
    ];

    expect(foldNotices(records).released.size).toBe(0);
  });

  it('ignores a release when no key is pinned: none verifies', () => {
    expect(foldNotices([releaseRecord(OAK, 1, 1)], null).released.size).toBe(0);
  });

  it('ignores a record the steward signed that isn’t a notice, and a cut one', () => {
    const body = { v: 1, kind: 'withdraw', id: OAK } as const;
    const withdraw = {
      ...releaseRecord(OAK, 1, 1),
      data: signShelfBody(TEST_STEWARD.signing, body),
    };
    const cut = releaseRecord(OAK, 2, 1);

    expect(foldNotices([withdraw, { ...cut, data: cut.data.slice(0, 70) }]).released.size).toBe(0);
  });

  it('ignores every act a door signs, under its own address', () => {
    const thief = newSigningKeys();
    const address = base64url(thief.publicKey);
    const bodies: NoticeBody[] = [
      { v: 1, kind: 'notice', act: 'hold', address: OAK, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'uphold', address: OAK, id: ID, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'suspend', address: OAK, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'pause', on: true },
    ];
    const records = bodies.map((body, at) => ({
      seq: at + 1,
      received: 1,
      address,
      data: signNotice(thief, body),
    }));

    expect(foldNotices(records)).toEqual(foldNotices([]));
  });
});

describe('holds (#489)', () => {
  it('lasts 10,080 relay minutes from its receipt: held at 10,079, lapsed at 10,080', () => {
    const state = foldNotices([
      notice({ v: 1, kind: 'notice', act: 'hold', address: OAK, clause: 'C2' }, 1, 5000),
    ]);
    const [hold] = state.holds;

    expect(HOLD_MINUTES).toBe(10_080);
    expect(hold).toEqual({ address: OAK, id: null, clause: 'C2', seq: 1, until: 5000 + 10_080 });
    expect(hold && holdStands(hold, 5000 + 10_079)).toBe(true);
    expect(hold && holdStands(hold, 5000 + 10_080)).toBe(false);
  });

  it('holds an entry, or a whole listing and so every entry under it', () => {
    const state = foldNotices([
      notice({ v: 1, kind: 'notice', act: 'hold', address: OAK, id: ID, clause: 'C2' }, 1, 0),
      notice({ v: 1, kind: 'notice', act: 'hold', address: BIRCH, clause: 'C3' }, 2, 0),
    ]);

    expect(isHeld(state, OAK, ID, 10)).toBe(true);
    expect(isHeld(state, OAK, OTHER_ID, 10)).toBe(false);
    expect(isHeld(state, OAK, null, 10)).toBe(false);
    expect(isHeld(state, BIRCH, null, 10)).toBe(true);
    expect(isHeld(state, BIRCH, ID, 10)).toBe(true);
    expect(isHeld(state, BIRCH, ID, 10_080)).toBe(false);
  });

  it('keeps the latest hold on each target, whatever order they come in', () => {
    const first = notice({ v: 1, kind: 'notice', act: 'hold', address: OAK, clause: 'C1' }, 1, 0);
    const again = notice({ v: 1, kind: 'notice', act: 'hold', address: OAK, clause: 'C3' }, 2, 900);
    const expected = [{ address: OAK, id: null, clause: 'C3', seq: 2, until: 900 + 10_080 }];

    expect(foldNotices([first, again]).holds).toEqual(expected);
    expect(foldNotices([again, first]).holds).toEqual(expected);
  });
});

describe('upholds, suspends and pauses (#489)', () => {
  it('records each upheld entry and suspended address with its clause', () => {
    const state = foldNotices([
      notice({ v: 1, kind: 'notice', act: 'uphold', address: OAK, id: ID, clause: 'C2' }, 3, 70),
      notice({ v: 1, kind: 'notice', act: 'suspend', address: BIRCH, clause: 'C3' }, 4, 80),
      notice({ v: 1, kind: 'notice', act: 'suspend', address: BIRCH, clause: 'C1' }, 5, 90),
    ]);

    expect(state.upheld).toEqual([{ address: OAK, id: ID, clause: 'C2', seq: 3, received: 70 }]);
    expect(state.suspended).toEqual([
      { address: BIRCH, id: null, clause: 'C3', seq: 4, received: 80 },
    ]);
  });

  it('pauses on the newest pause that is on, and shows again after one that is off', () => {
    const on = notice({ v: 1, kind: 'notice', act: 'pause', on: true }, 1);
    const off = notice({ v: 1, kind: 'notice', act: 'pause', on: false }, 2);

    expect(foldNotices([]).paused).toBe(false);
    expect(foldNotices([on]).paused).toBe(true);
    expect(foldNotices([off, on]).paused).toBe(false);
    expect(foldNotices([{ ...on, seq: 3 }, off]).paused).toBe(true);
  });
});
