import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { utf8 } from '../test/bytes';
import { seatKeyOf, seatProofMessage, signSeatProof, verifySeatProof } from './seat';
import {
  EVENT_CONTEXT,
  INVITE_TOKEN_CONTEXT,
  newSigningKeys,
  publicKeyOf,
  SEAT_CONTEXT,
  sign,
} from './sign';

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });
const COALITION = 'the-coalition-id-a-seat-proof-is-signed-over';

/** The same seed as a WebCrypto private key: a second, independent Ed25519 implementation. */
async function platformKey(seed: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = concatBytes(hexToBytes('302e020100300506032b657004220420'), seed);
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(pkcs8), 'Ed25519', true, ['sign']);
}

/** WebCrypto's plain Ed25519 signature by `seed` over `msg`, as hex. */
async function platformSignature(seed: Uint8Array, msg: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', await platformKey(seed), Uint8Array.from(msg));
  return bytesToHex(new Uint8Array(sig));
}

describe('a seat proof', () => {
  it('names its context exactly', () => {
    expect(SEAT_CONTEXT).toBe('reconcile/v1/seat');
  });

  it('covers the coalition id’s UTF-8, one 0x00 byte, then the joiner’s 32-byte key', () => {
    const joiner = new Uint8Array(32).fill(7);
    expect(bytesToHex(seatProofMessage('abc', joiner))).toBe(
      bytesToHex(concatBytes(utf8('abc'), Uint8Array.of(0), joiner)),
    );
  });

  it('is the seat secret’s key, as an event key is the member’s', () => {
    const seat = newSigningKeys();
    expect(bytesToHex(seatKeyOf(seat.secretKey))).toBe(bytesToHex(seat.publicKey));
  });

  it('matches a second implementation (WebCrypto) signing the seat tag, 0x00 and the message', async () => {
    await fc.assert(
      fc.asyncProperty(seeds, seeds, async (seat, joiner) => {
        const tagged = concatBytes(
          utf8('reconcile/v1/seat'),
          Uint8Array.of(0),
          utf8(COALITION),
          Uint8Array.of(0),
          joiner,
        );
        expect(bytesToHex(signSeatProof(seat, COALITION, joiner))).toBe(
          await platformSignature(seat, tagged),
        );
      }),
      { numRuns: 20 },
    );
  });

  it('verifies for its seat key, coalition and joiner, and for nothing else', () => {
    const seat = newSigningKeys();
    const joiner = newSigningKeys().publicKey;
    const proof = signSeatProof(seat.secretKey, COALITION, joiner);
    expect(verifySeatProof(seat.publicKey, proof, COALITION, joiner)).toBe(true);
    expect(verifySeatProof(newSigningKeys().publicKey, proof, COALITION, joiner)).toBe(false);
    expect(verifySeatProof(seat.publicKey, proof, `${COALITION}x`, joiner)).toBe(false);
    expect(verifySeatProof(seat.publicKey, proof, COALITION, newSigningKeys().publicKey)).toBe(
      false,
    );
  });

  it('never passes for a signature under another context, over the same bytes', () => {
    const seat = newSigningKeys();
    const joiner = newSigningKeys().publicKey;
    const message = seatProofMessage(COALITION, joiner);
    for (const ctx of [EVENT_CONTEXT, INVITE_TOKEN_CONTEXT] as const) {
      expect(
        verifySeatProof(seat.publicKey, sign(ctx, seat.secretKey, message), COALITION, joiner),
      ).toBe(false);
    }
  });

  it('refuses a joiner key that isn’t 32 bytes, rather than signing over it', () => {
    const seat = newSigningKeys();
    const joiner = newSigningKeys().publicKey;
    const proof = signSeatProof(seat.secretKey, COALITION, joiner);
    expect(verifySeatProof(seat.publicKey, proof, COALITION, joiner.subarray(0, 31))).toBe(false);
    expect(() => signSeatProof(seat.secretKey, COALITION, joiner.subarray(0, 31))).toThrow(
      'A joiner key is 32 bytes.',
    );
    expect(publicKeyOf(seat.secretKey)).toHaveLength(32);
  });
});
