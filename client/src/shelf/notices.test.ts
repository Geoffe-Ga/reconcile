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
import { releaseRecord, stampAt, STEWARD_ADDRESS, TEST_PINS, TEST_STEWARD } from '../test/steward';
import {
  foldNotices,
  HOLD_MINUTES,
  holdStands,
  isFresh,
  isHeld,
  noticeStamp,
  signNotice,
} from './notices';
import { encodeShelfBody, type NoticeDraft, parseShelfBody, signShelfBody } from './record';
import { STEWARD_PINS } from './steward';

const OAK = base64url(newSigningKeys().publicKey);
const BIRCH = base64url(newSigningKeys().publicKey);

const ID = base64url(new Uint8Array(32).fill(4));
const NONCE_A = base64url(new Uint8Array(16).fill(0xa));
const NONCE_B = base64url(new Uint8Array(16).fill(0xb));
const NONCE_C = base64url(new Uint8Array(16).fill(0xc));
const OTHER_ID = base64url(new Uint8Array(32).fill(5));

/** `body` signed by the tests' steward on the day it arrives, served under its address at `seq`. */
function notice(body: NoticeDraft, seq = 1, received = 1000): ShelfRecord {
  const data = signNotice(TEST_STEWARD.signing, body, stampAt(received));
  return { seq, received, address: STEWARD_ADDRESS, data };
}

/** Relay minutes in a day. */
const DAY = 1440;

describe('signNotice', () => {
  it('signs a notice, stamped as given, as a shelf record the steward’s address verifies', () => {
    const body: NoticeDraft = { v: 1, kind: 'notice', act: 'release', address: OAK };
    const stamp = { day: 20_776, n: base64url(new Uint8Array(16).fill(2)) };
    const record = signNotice(TEST_STEWARD.signing, body, stamp);
    const message = verifyShelfRecord(record, STEWARD_ADDRESS);

    expect(message && parseShelfBody(message)).toEqual({ ...body, ...stamp });
    expect(message && Array.from(message)).toEqual(
      Array.from(encodeShelfBody({ ...body, ...stamp })),
    );
  });

  it('stamps with today’s UTC day on this device and a fresh 16-byte nonce unless given one', () => {
    const body: NoticeDraft = { v: 1, kind: 'notice', act: 'pause', on: true };
    const before = Math.floor(Date.now() / 86_400_000);
    const [first, second] = [1, 2].map(() => {
      const message = verifyShelfRecord(signNotice(TEST_STEWARD.signing, body), STEWARD_ADDRESS);
      const read = message === null ? null : parseShelfBody(message);
      if (read?.kind !== 'notice') throw new Error('a notice');
      return read;
    });
    const after = Math.floor(Date.now() / 86_400_000);

    expect(first?.day).toBeGreaterThanOrEqual(before);
    expect(first?.day).toBeLessThanOrEqual(after);
    expect(first?.n).toHaveLength(22);
    expect(first?.n).not.toBe(second?.n);
  });

  it('counts the UTC day from device milliseconds', () => {
    expect(noticeStamp(0).day).toBe(0);
    expect(noticeStamp(86_400_000 - 1).day).toBe(0);
    expect(noticeStamp(86_400_000).day).toBe(1);
  });
});

describe('no replays (#490’s review)', () => {
  const stamp = (day: number, n = base64url(new Uint8Array(16).fill(day % 256))) => ({ day, n });
  const signed = (body: NoticeDraft, day: number, n?: string) =>
    signNotice(TEST_STEWARD.signing, body, stamp(day, n));
  const lift: NoticeDraft = { v: 1, kind: 'notice', act: 'unsuspend', address: OAK };
  const suspend: NoticeDraft = { v: 1, kind: 'notice', act: 'suspend', address: OAK, clause: 'C3' };
  const at = (seq: number, received: number, data: Uint8Array<ArrayBuffer>): ShelfRecord => ({
    seq,
    received,
    address: STEWARD_ADDRESS,
    data,
  });

  it('counts a notice signed on the day it arrived or the day before, and no other', () => {
    expect(isFresh({ day: 10, n: '' }, 10 * DAY)).toBe(true);
    expect(isFresh({ day: 10, n: '' }, 11 * DAY + DAY - 1)).toBe(true);
    expect(isFresh({ day: 10, n: '' }, 12 * DAY)).toBe(false);
    expect(isFresh({ day: 10, n: '' }, 10 * DAY - 1)).toBe(false);
  });

  it('ignores an old lift a relay serves again after a fresh suspend: the suspension stands', () => {
    const old = signed(lift, 10, NONCE_C);
    const records = [
      at(1, 10 * DAY, signed(suspend, 10, NONCE_A)),
      at(2, 10 * DAY + 5, old),
      at(3, 20 * DAY, signed(suspend, 20, NONCE_B)),
      at(4, 20 * DAY + 5, old),
    ];

    expect(foldNotices(records).suspended).toMatchObject([{ address: OAK, seq: 3 }]);
  });

  it('counts only the first notice with each nonce, by seq, whatever the order served', () => {
    const records = [
      at(1, 10 * DAY, signed(suspend, 10, NONCE_A)),
      at(2, 10 * DAY + 5, signed(lift, 10, NONCE_B)),
      at(3, 10 * DAY + 9, signed(suspend, 10, NONCE_A)),
    ];

    expect(foldNotices(records).suspended).toEqual([]);
    expect(foldNotices([...records].reverse()).suspended).toEqual([]);
  });

  it('ignores a notice whose day is older than the day before it arrived, or later than that day', () => {
    const pause: NoticeDraft = { v: 1, kind: 'notice', act: 'pause', on: true };

    expect(foldNotices([at(1, 12 * DAY, signed(pause, 10))]).paused).toBe(false);
    expect(foldNotices([at(1, 9 * DAY + DAY - 1, signed(pause, 10))]).paused).toBe(false);
    expect(foldNotices([at(1, 11 * DAY + DAY - 1, signed(pause, 10))]).paused).toBe(true);
  });

  it('lets a stale copy spend its nonce: a later fresh-looking copy of it counts no more', () => {
    const pause: NoticeDraft = { v: 1, kind: 'notice', act: 'pause', on: true };
    const data = signed(pause, 10);

    expect(foldNotices([at(1, 30 * DAY, data), at(2, 10 * DAY, data)]).paused).toBe(false);
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
    const body: NoticeDraft = { v: 1, kind: 'notice', act: 'release', address: OAK };
    const own = { seq: 1, received: 1, address: base64url(thief.publicKey) };
    const records = [
      { ...own, data: signNotice(thief, body, stampAt(1)) },
      { ...own, address: STEWARD_ADDRESS, data: signNotice(thief, body, stampAt(1)) },
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
    const bodies: NoticeDraft[] = [
      { v: 1, kind: 'notice', act: 'hold', address: OAK, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'uphold', address: OAK, id: ID, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'suspend', address: OAK, clause: 'C2' },
      { v: 1, kind: 'notice', act: 'pause', on: true },
    ];
    const records = bodies.map((body, at) => ({
      seq: at + 1,
      received: 1,
      address,
      data: signNotice(thief, body, stampAt(1)),
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

describe('a lifted suspension (#490)', () => {
  const suspend = (seq: number, clause: 'C1' | 'C3' = 'C3') =>
    notice({ v: 1, kind: 'notice', act: 'suspend', address: OAK, clause }, seq, seq * 10);
  const lift = (seq: number, address = OAK) =>
    notice({ v: 1, kind: 'notice', act: 'unsuspend', address }, seq, seq * 10);

  it('ends the suspension an unsuspend newer than it names, and the release before it', () => {
    const state = foldNotices([releaseRecord(OAK, 1, 5), suspend(2), lift(3)]);

    expect(state.suspended).toEqual([]);
    expect(state.released.has(OAK)).toBe(false);
  });

  it('lets a release after the lift count again', () => {
    const state = foldNotices([suspend(2), lift(3), releaseRecord(OAK, 4, 40)]);

    expect(state.released.has(OAK)).toBe(true);
  });

  it('lifts nothing before any suspend: the release and a later suspend stand', () => {
    const state = foldNotices([lift(1), releaseRecord(OAK, 2, 20), suspend(3)]);

    expect(state.released.has(OAK)).toBe(true);
    expect(state.suspended).toEqual([
      { address: OAK, id: null, clause: 'C3', seq: 3, received: 30 },
    ]);
  });

  it('lets a suspend after the lift stand again, naming its own clause', () => {
    const state = foldNotices([suspend(4, 'C1'), lift(3), suspend(2)]);

    expect(state.suspended).toEqual([
      { address: OAK, id: null, clause: 'C1', seq: 4, received: 40 },
    ]);
  });

  it('lifts only the address it names', () => {
    const birch = notice({ v: 1, kind: 'notice', act: 'suspend', address: BIRCH, clause: 'C2' }, 1);
    const state = foldNotices([birch, suspend(2), lift(3, BIRCH)]);

    expect(state.suspended.map(({ address }) => address)).toEqual([OAK]);
  });

  it('ignores an unsuspend any other key signed', () => {
    const thief = newSigningKeys();
    const body: NoticeDraft = { v: 1, kind: 'notice', act: 'unsuspend', address: OAK };
    const forged = {
      seq: 3,
      received: 30,
      address: STEWARD_ADDRESS,
      data: signNotice(thief, body, stampAt(30)),
    };

    expect(foldNotices([suspend(2), forged]).suspended).toHaveLength(1);
  });
});
