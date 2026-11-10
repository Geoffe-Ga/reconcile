import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EVENT_CONTEXT,
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
  SIGNATURE_BYTES,
  newSigningKeys,
  publicKeyOf,
  sign,
  verify,
} from './sign';
import { utf8 } from '../test/bytes';

/** A fixed seed for the tests that need one. */
const SEED = new Uint8Array(32).fill(0x2a);

/** The ed25519 group order L. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** The message a signature under `ctx` covers: the tag's UTF-8, one 0x00 byte, then `msg`. */
function tagged(ctx: string, msg: Uint8Array): Uint8Array {
  return concatBytes(utf8(ctx), Uint8Array.of(0), msg);
}

/** A copy of `bytes` with byte `at` changed. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

/** A 32-byte little-endian encoding of `n`. */
function littleEndian(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let rest = n;
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/** A little-endian byte string as a number. */
function fromLittleEndian(bytes: Uint8Array): bigint {
  return [...bytes].reverse().reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
}

/** The identity point, encoded canonically (y = 1): a small-order public key. */
const IDENTITY = littleEndian(1n);

/** The identity point encoded with y = p + 1, which isn't reduced below p: non-canonical. */
const IDENTITY_NONCANONICAL = littleEndian(2n ** 255n - 19n + 1n);

/** The same seed as a WebCrypto private key: a second, independent Ed25519 implementation. */
async function platformKey(seed: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = concatBytes(hexToBytes('302e020100300506032b657004220420'), seed);
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(pkcs8), 'Ed25519', true, ['sign']);
}

/** The public key WebCrypto derives from `seed`, as hex. */
async function platformPublicKey(seed: Uint8Array): Promise<string> {
  const { x = '' } = await crypto.subtle.exportKey('jwk', await platformKey(seed));
  const binary = atob(x.replace(/-/g, '+').replace(/_/g, '/'));
  return bytesToHex(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** WebCrypto's signature by `seed` over `msg`, as hex. */
async function platformSignature(seed: Uint8Array, msg: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', await platformKey(seed), Uint8Array.from(msg));
  return bytesToHex(new Uint8Array(sig));
}

describe('signing keys', () => {
  it('are 32-byte keys and a 64-byte signature', () => {
    expect([PUBLIC_KEY_BYTES, SECRET_KEY_BYTES, SIGNATURE_BYTES]).toEqual([32, 32, 64]);
  });

  it('derive the public key a second implementation (WebCrypto) derives from the same seed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (seed) => {
        expect(bytesToHex(publicKeyOf(seed))).toBe(await platformPublicKey(seed));
      }),
      { numRuns: 25 },
    );
  });

  it('come fresh each time, with the public key that belongs to the secret one', () => {
    const one = newSigningKeys();
    const two = newSigningKeys();
    expect(one.secretKey).toHaveLength(32);
    expect(one.publicKey).toHaveLength(32);
    expect(bytesToHex(publicKeyOf(one.secretKey))).toBe(bytesToHex(one.publicKey));
    expect(bytesToHex(one.secretKey)).not.toBe(bytesToHex(two.secretKey));
    expect(bytesToHex(one.publicKey)).not.toBe(bytesToHex(two.publicKey));
  });
});

describe('sign', () => {
  it('names the event context exactly', () => {
    expect(EVENT_CONTEXT).toBe('reconcile/v1/event');
  });

  it('signs the context tag, a 0x00 byte and the message, as plain Ed25519', () => {
    const msg = utf8('{"v":1}');
    const sig = sign(EVENT_CONTEXT, SEED, msg);
    expect(sig).toHaveLength(64);
    expect(bytesToHex(sig)).toBe(bytesToHex(ed25519.sign(tagged('reconcile/v1/event', msg), SEED)));
  });

  it('matches a second implementation (WebCrypto) signing the tag, 0x00 and the message', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ maxLength: 200 }),
        async (seed, msg) => {
          expect(bytesToHex(sign(EVENT_CONTEXT, seed, msg))).toBe(
            await platformSignature(seed, tagged('reconcile/v1/event', msg)),
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('verify', () => {
  const keys = newSigningKeys();
  const msg = utf8('{"v":1,"type":"join"}');
  const sig = sign(EVENT_CONTEXT, keys.secretKey, msg);

  it('accepts a signature over the message by the key', () => {
    expect(verify(EVENT_CONTEXT, keys.publicKey, sig, msg)).toBe(true);
  });

  it('refuses any one byte changed in the message, the signature or the key', () => {
    fc.assert(
      fc.property(fc.nat(), (n) => {
        expect(verify(EVENT_CONTEXT, keys.publicKey, sig, flipped(msg, n % msg.length))).toBe(
          false,
        );
        expect(verify(EVENT_CONTEXT, keys.publicKey, flipped(sig, n % 64), msg)).toBe(false);
        expect(verify(EVENT_CONTEXT, flipped(keys.publicKey, n % 32), sig, msg)).toBe(false);
      }),
    );
  });

  it('refuses another member’s key', () => {
    expect(verify(EVENT_CONTEXT, newSigningKeys().publicKey, sig, msg)).toBe(false);
  });

  it('refuses a plain Ed25519 signature made without the context tag', () => {
    const untagged = ed25519.sign(msg, keys.secretKey);
    expect(verify(EVENT_CONTEXT, keys.publicKey, untagged, msg)).toBe(false);
  });

  it('refuses a key or signature of the wrong length rather than throwing', () => {
    expect(verify(EVENT_CONTEXT, keys.publicKey.subarray(0, 31), sig, msg)).toBe(false);
    expect(verify(EVENT_CONTEXT, concatBytes(keys.publicKey, Uint8Array.of(0)), sig, msg)).toBe(
      false,
    );
    expect(verify(EVENT_CONTEXT, keys.publicKey, sig.subarray(0, 63), msg)).toBe(false);
    expect(verify(EVENT_CONTEXT, keys.publicKey, concatBytes(sig, Uint8Array.of(0)), msg)).toBe(
      false,
    );
  });

  it('refuses a second encoding of the same signature, with S + L in place of S', () => {
    const s = fromLittleEndian(sig.subarray(32));
    const malleated = concatBytes(sig.subarray(0, 32), littleEndian(s + L));
    expect(verify(EVENT_CONTEXT, keys.publicKey, malleated, msg)).toBe(false);
  });

  it('refuses a small-order key whose "signature" holds for every message (the default accepts it)', () => {
    const universal = concatBytes(IDENTITY, littleEndian(0n));
    const anything = tagged(EVENT_CONTEXT, msg);
    expect(ed25519.verify(universal, anything, IDENTITY)).toBe(true);
    expect(verify(EVENT_CONTEXT, IDENTITY, universal, msg)).toBe(false);
  });

  it('refuses a non-canonical encoding of a small-order key (the default accepts it)', () => {
    const universal = concatBytes(IDENTITY_NONCANONICAL, littleEndian(0n));
    const anything = tagged(EVENT_CONTEXT, msg);
    expect(ed25519.verify(universal, anything, IDENTITY_NONCANONICAL)).toBe(true);
    expect(verify(EVENT_CONTEXT, IDENTITY_NONCANONICAL, universal, msg)).toBe(false);
  });

  it('refuses a real key’s signature whose R is encoded non-canonically (the default accepts it)', () => {
    // R = the identity, written with y = p + 1. Then S = k·a (mod L) satisfies [8](R + kA − SB) = 0,
    // with k hashed over R's exact bytes, as ZIP-215 does.
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(keys.secretKey);
    const message = tagged(EVENT_CONTEXT, msg);
    const k = fromLittleEndian(sha512(concatBytes(IDENTITY_NONCANONICAL, pointBytes, message))) % L;
    const forged = concatBytes(IDENTITY_NONCANONICAL, littleEndian((k * scalar) % L));
    expect(ed25519.verify(forged, message, pointBytes)).toBe(true);
    expect(verify(EVENT_CONTEXT, keys.publicKey, forged, msg)).toBe(false);
  });
});
