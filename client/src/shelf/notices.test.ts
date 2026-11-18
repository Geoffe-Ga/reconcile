/**
 * The steward's notices (#488; docs/spec/listed-doors.md §4.3 rules 1 and 8,
 * §6.1): signed with the steward's key, and folded only when they verify
 * against the key pinned in `steward.ts`. Only `release` folds here; every
 * later act parses and is ignored until #489.
 */
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { verifyShelfRecord } from '../crypto/shelf';
import { newSigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { releaseRecord, STEWARD_ADDRESS, TEST_PINS, TEST_STEWARD } from '../test/steward';
import { foldNotices, LATER_NOTICE_ACTS, signNotice } from './notices';
import { encodeShelfBody, type NoticeBody, parseShelfBody, signShelfBody } from './record';
import { STEWARD_PINS } from './steward';

const OAK = base64url(newSigningKeys().publicKey);
const BIRCH = base64url(newSigningKeys().publicKey);

/** `body` signed by the tests' steward and served under its address at `seq`. */
function notice(body: NoticeBody, seq = 1, address = STEWARD_ADDRESS): ShelfRecord {
  return { seq, received: 1000, address, data: signNotice(TEST_STEWARD.signing, body) };
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

  it.each(LATER_NOTICE_ACTS)('parses a %s and ignores it, as a stub until #489', (act) => {
    const records = [notice({ v: 1, kind: 'notice', act, address: OAK, clause: 'C2' })];

    const state = foldNotices(records);

    expect(state.released.size).toBe(0);
    expect(state.later.map((body) => body.act)).toEqual([act]);
    expect(LATER_NOTICE_ACTS).toEqual(['hold', 'uphold', 'suspend', 'pause']);
  });
});
