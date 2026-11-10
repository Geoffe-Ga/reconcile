import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { utf8 } from './bytes';
import { TEST_MAILBOX } from './fakeRelay';
import {
  BLOB_SIZES,
  MAX_PLAINTEXT_BYTES,
  NONCE_BYTES,
  PayloadTooLarge,
  TAG_BYTES,
} from '../crypto/seal';
import { stubSeal } from './stubSeal';

const mailbox = TEST_MAILBOX;
const secret = new Uint8Array(32).fill(9);

/** Plaintext of `length` bytes, varied by `seed` so no two runs look alike. */
function bytesOf(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (seed + i * 31) % 256;
  }
  return bytes;
}

describe('stubSeal', () => {
  it('seals a short event into a 1,024-byte blob and opens it again', () => {
    const eventJson = '{"v":1,"type":"join","group":"g","author":"a","ts":0,"body":{"name":"Ana"}}';

    const blob = stubSeal.seal(mailbox, secret, utf8(eventJson));

    expect(blob.length).toBe(1024);
    expect(stubSeal.open(mailbox, secret, blob)).toEqual(utf8(eventJson));
  });

  it('pads every plaintext from 0 to 65,492 bytes to one of the four sizes, and opens it', () => {
    const lengths = fc.oneof(
      fc.constantFrom(0, 980, 981, 4052, 4053, 16340, 16341, MAX_PLAINTEXT_BYTES),
      fc.integer({ min: 0, max: MAX_PLAINTEXT_BYTES }),
    );
    fc.assert(
      fc.property(lengths, fc.nat(255), (length, seed) => {
        const plaintext = bytesOf(length, seed);

        const blob = stubSeal.seal(mailbox, secret, plaintext);

        expect(BLOB_SIZES).toContain(blob.length);
        expect(stubSeal.open(mailbox, secret, blob)).toEqual(plaintext);
      }),
    );
  });

  it('opens arbitrary short plaintexts byte for byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (plaintext) => {
        expect(stubSeal.open(mailbox, secret, stubSeal.seal(mailbox, secret, plaintext))).toEqual(
          plaintext,
        );
      }),
    );
  });

  it('zero-fills the nonce and tag slots, and encrypts nothing', () => {
    const blob = stubSeal.seal(mailbox, secret, utf8('throwaway text'));

    expect(blob.subarray(0, NONCE_BYTES).every((byte) => byte === 0)).toBe(true);
    expect(blob.subarray(blob.length - TAG_BYTES).every((byte) => byte === 0)).toBe(true);
    expect(blob.subarray(NONCE_BYTES + 4, NONCE_BYTES + 4 + 14)).toEqual(utf8('throwaway text'));
  });

  it('refuses a plaintext over 65,492 bytes with PayloadTooLarge', () => {
    expect(() => stubSeal.seal(mailbox, secret, new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).toThrow(
      PayloadTooLarge,
    );
  });

  it.each([0, 1023, 1025, 2048, 65537])('refuses to open a %i-byte blob', (size) => {
    expect(stubSeal.open(mailbox, secret, new Uint8Array(size))).toBeNull();
  });

  it('refuses a blob whose nonce slot is not zero', () => {
    const blob = stubSeal.seal(mailbox, secret, utf8('x'));
    blob[0] = 1;

    expect(stubSeal.open(mailbox, secret, blob)).toBeNull();
  });

  it('refuses a blob whose tag slot is not zero', () => {
    const blob = stubSeal.seal(mailbox, secret, utf8('x'));
    blob[blob.length - 1] = 1;

    expect(stubSeal.open(mailbox, secret, blob)).toBeNull();
  });

  it('refuses a blob whose length runs past its body', () => {
    const blob = stubSeal.seal(mailbox, secret, utf8('x'));
    new DataView(blob.buffer).setUint32(NONCE_BYTES, 1024);

    expect(stubSeal.open(mailbox, secret, blob)).toBeNull();
  });
});
