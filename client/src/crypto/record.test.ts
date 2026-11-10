import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECORD_HEADER_BYTES, signRecord, verifyRecord } from './record';
import { EVENT_CONTEXT, newSigningKeys, sign } from './sign';
import { utf8 } from '../test/bytes';

// Count the real Ed25519 verifications, to see the verdict cache at work.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const real = await importOriginal<{ ed25519: typeof ed25519 }>();
  return { ...real, ed25519: { ...real.ed25519, verify: vi.fn(real.ed25519.verify) } };
});

const keys = newSigningKeys();
const eventBytes = utf8('{"v":1,"type":"join","group":"g","author":"a","ts":0,"body":{}}');

/** A copy of `bytes` with byte `at` changed. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

/** Hex of a verified record's parts, or null. */
function opened(record: Uint8Array): { publicKey: string; eventBytes: string } | null {
  const verified = verifyRecord(record);
  return verified === null
    ? null
    : { publicKey: bytesToHex(verified.publicKey), eventBytes: bytesToHex(verified.eventBytes) };
}

beforeEach(() => {
  vi.mocked(ed25519.verify).mockClear();
});

describe('signRecord', () => {
  it('lays a record out as the public key, then the signature, then the event bytes', () => {
    const record = signRecord(keys, eventBytes);
    expect(RECORD_HEADER_BYTES).toBe(96);
    expect(record).toHaveLength(96 + eventBytes.length);
    expect(bytesToHex(record)).toBe(
      bytesToHex(
        concatBytes(keys.publicKey, sign(EVENT_CONTEXT, keys.secretKey, eventBytes), eventBytes),
      ),
    );
  });
});

describe('verifyRecord', () => {
  const record = signRecord(keys, eventBytes);

  it('opens a record its key signed into that key and the exact event bytes', () => {
    expect(opened(record)).toEqual({
      publicKey: bytesToHex(keys.publicKey),
      eventBytes: bytesToHex(eventBytes),
    });
  });

  it('refuses any one byte changed: in the key, the signature or the event bytes', () => {
    fc.assert(
      fc.property(fc.nat({ max: record.length - 1 }), (at) => {
        expect(opened(flipped(record, at))).toBeNull();
      }),
    );
  });

  it('makes a record that never verifies from a public key that isn’t the secret key’s', () => {
    const mismatched = { publicKey: newSigningKeys().publicKey, secretKey: keys.secretKey };
    expect(opened(signRecord(mismatched, eventBytes))).toBeNull();
  });

  it('refuses a real signature under a swapped-in key', () => {
    const other = newSigningKeys().publicKey;
    expect(opened(concatBytes(other, record.subarray(32)))).toBeNull();
  });

  it('refuses a signature over different bytes', () => {
    const elsewhere = sign(EVENT_CONTEXT, keys.secretKey, utf8('{"v":1}'));
    expect(opened(concatBytes(keys.publicKey, elsewhere, eventBytes))).toBeNull();
  });

  it('refuses bytes too short to hold a key and a signature, such as a bare event', () => {
    expect(opened(new Uint8Array(0))).toBeNull();
    expect(opened(record.subarray(0, 95))).toBeNull();
    expect(opened(eventBytes)).toBeNull();
    expect(ed25519.verify).not.toHaveBeenCalled();
  });

  it('opens a signed record with no event bytes at all, leaving the parse to refuse it', () => {
    expect(opened(signRecord(keys, new Uint8Array(0)))).toEqual({
      publicKey: bytesToHex(keys.publicKey),
      eventBytes: '',
    });
  });

  it('verifies the same bytes once, however many times they are folded', () => {
    const fresh = signRecord(keys, utf8('{"cached":1}'));
    expect(opened(fresh)).not.toBeNull();
    expect(opened(Uint8Array.from(fresh))).not.toBeNull();
    expect(ed25519.verify).toHaveBeenCalledTimes(1);
  });

  it('keeps no verdict for a record that failed, nor lets it pass for a cached one', () => {
    const fresh = signRecord(keys, utf8('{"cached":2}'));
    const forged = flipped(fresh, 40);
    expect(opened(forged)).toBeNull();
    expect(opened(forged)).toBeNull();
    expect(opened(fresh)).not.toBeNull();
    expect(opened(forged)).toBeNull();
    expect(ed25519.verify).toHaveBeenCalledTimes(4);
  });
});
