/**
 * Every signature check keeps its verdict for the page's life (#362): a
 * record's, an invite token's, a seat proof's, a share copy's and a door
 * page's alike, so a re-fold costs no Ed25519 verification. Only a pass is
 * kept, under the SHA-256 of the key, the signature and the tagged message,
 * so only those exact bytes, under that context, ever share a verdict.
 * Nothing is persisted.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { utf8 } from '../test/bytes';
import { signInviteToken, verifyInviteToken } from './invite';
import { signRecord, verifyRecord } from './record';
import { signSeatProof, verifySeatProof } from './seat';
import {
  EVENT_CONTEXT,
  INVITE_TOKEN_CONTEXT,
  newSigningKeys,
  publicKeyOf,
  sign,
  verify,
} from './sign';

// Count the real Ed25519 verifications, to see the verdict cache at work.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const real = await importOriginal<{ ed25519: typeof ed25519 }>();
  return { ...real, ed25519: { ...real.ed25519, verify: vi.fn(real.ed25519.verify) } };
});

beforeEach(() => {
  vi.mocked(ed25519.verify).mockClear();
});

/** A copy of `bytes` with byte `at` changed. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

const inviter = newSigningKeys();
const other = newSigningKeys();

describe('an invite token’s verdict (#362)', () => {
  it('is kept once it passes, so checking the same token again verifies nothing', () => {
    const token = signInviteToken(inviter.secretKey, 'group-memo-1');

    expect(verifyInviteToken(inviter.publicKey, token, 'group-memo-1')).toBe(true);
    expect(
      verifyInviteToken(Uint8Array.from(inviter.publicKey), Uint8Array.from(token), 'group-memo-1'),
    ).toBe(true);

    expect(ed25519.verify).toHaveBeenCalledTimes(1);
  });

  it('never passes a tampered token, another group’s, another key’s, or the same bytes under another tag', () => {
    const token = signInviteToken(inviter.secretKey, 'group-memo-2');
    expect(verifyInviteToken(inviter.publicKey, token, 'group-memo-2')).toBe(true);

    expect(verifyInviteToken(inviter.publicKey, flipped(token, 10), 'group-memo-2')).toBe(false);
    expect(verifyInviteToken(inviter.publicKey, token, 'group-memo-3')).toBe(false);
    expect(verifyInviteToken(other.publicKey, token, 'group-memo-2')).toBe(false);
    expect(verify(EVENT_CONTEXT, inviter.publicKey, token, utf8('group-memo-2'))).toBe(false);
    expect(verify(INVITE_TOKEN_CONTEXT, inviter.publicKey, token, utf8('group-memo-2'))).toBe(true);
  });

  it('keeps no verdict for a check that failed: each one runs again', () => {
    const forged = flipped(signInviteToken(inviter.secretKey, 'group-memo-4'), 3);

    expect(verifyInviteToken(inviter.publicKey, forged, 'group-memo-4')).toBe(false);
    expect(verifyInviteToken(inviter.publicKey, forged, 'group-memo-4')).toBe(false);

    expect(ed25519.verify).toHaveBeenCalledTimes(2);
  });
});

describe('a seat proof’s verdict (#362)', () => {
  const seatSecret = new Uint8Array(32).fill(0x31);
  const seatKey = publicKeyOf(seatSecret);
  const joiner = newSigningKeys().publicKey;

  it('is kept once it passes, and never passes another joiner or coalition', () => {
    const proof = signSeatProof(seatSecret, 'coalition-memo', joiner);

    expect(verifySeatProof(seatKey, proof, 'coalition-memo', joiner)).toBe(true);
    expect(verifySeatProof(seatKey, proof, 'coalition-memo', joiner)).toBe(true);
    expect(ed25519.verify).toHaveBeenCalledTimes(1);

    expect(verifySeatProof(seatKey, proof, 'coalition-other', joiner)).toBe(false);
    expect(verifySeatProof(seatKey, proof, 'coalition-memo', other.publicKey)).toBe(false);
    expect(verifySeatProof(seatKey, flipped(proof, 63), 'coalition-memo', joiner)).toBe(false);
  });
});

describe('a record’s verdict, in the same cache (#362)', () => {
  it('is kept once it passes, and a copy with any byte changed still fails', () => {
    const record = signRecord(inviter, utf8('{"memo":1}'));
    expect(verifyRecord(record)).not.toBeNull();
    expect(verifyRecord(Uint8Array.from(record))).not.toBeNull();
    expect(ed25519.verify).toHaveBeenCalledTimes(1);

    for (const at of [0, 40, 100, record.length - 1]) {
      expect(verifyRecord(flipped(record, at))).toBeNull();
    }
  });

  it('never lends a record’s verdict to the same key and signature over its bytes under another tag', () => {
    const message = utf8('{"memo":2}');
    const record = signRecord(inviter, message);
    expect(verifyRecord(record)).not.toBeNull();
    const signature = record.subarray(32, 96);

    expect(verify(INVITE_TOKEN_CONTEXT, inviter.publicKey, signature, message)).toBe(false);
    expect(
      verify(
        EVENT_CONTEXT,
        inviter.publicKey,
        sign(EVENT_CONTEXT, inviter.secretKey, message),
        message,
      ),
    ).toBe(true);
  });
});
