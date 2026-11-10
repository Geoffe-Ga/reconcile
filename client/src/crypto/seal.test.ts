import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BLOB_SIZES,
  MAX_PLAINTEXT_BYTES,
  NONCE_BYTES,
  PayloadTooLarge,
  TAG_BYTES,
  bucketFor,
  frameBody,
  isBlobSize,
  open,
  seal,
  unframeBody,
  xchachaSeal,
} from './seal';
import { utf8 } from '../test/bytes';
import { TEST_MAILBOX } from '../test/fakeRelay';
import { stubSeal } from '../test/stubSeal';

/** Two groups' mailbox ids: 43 base64url characters each. */
const MAILBOX = TEST_MAILBOX;
const OTHER_MAILBOX = 'other-mailbox-'.padEnd(43, '1');
/** A seal key, and another group's. */
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

/** A payload of `length` bytes, varied by `seed` so no two look alike. */
function payload(length: number, seed = 0): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 31) % 256);
}

/** `blob` with byte `at` XORed with `mask`. */
function flipped(blob: Uint8Array, at: number, mask = 0x01): Uint8Array<ArrayBuffer> {
  const copy = Uint8Array.from(blob);
  copy[at] = (copy[at] ?? 0) ^ mask;
  return copy;
}

/** A blob sealed by hand around `body`, so a test can frame it wrongly under the right key. */
function sealedBody(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(NONCE_BYTES).fill(5);
  const sealed = xchacha20poly1305(KEY, nonce, utf8(MAILBOX)).encrypt(body);
  return Uint8Array.from(concatBytes(nonce, sealed));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the blob layout', () => {
  it('uses the four padded sizes of 1, 4, 16 and 64 KiB', () => {
    expect(BLOB_SIZES).toEqual([1024, 4096, 16384, 65536]);
  });

  it('leaves 65,492 bytes for the plaintext in the largest blob', () => {
    expect(NONCE_BYTES).toBe(24);
    expect(TAG_BYTES).toBe(16);
    expect(MAX_PLAINTEXT_BYTES).toBe(65536 - 24 - 4 - 16);
  });

  it('recognizes exactly the four blob sizes', () => {
    expect([0, 1023, 1024, 1025, 4096, 16384, 65535, 65536, 65537].map(isBlobSize)).toEqual([
      false,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});

describe('bucketFor', () => {
  it.each([
    [0, 1024],
    [980, 1024],
    [981, 4096],
    [4052, 4096],
    [4053, 16384],
    [16340, 16384],
    [16341, 65536],
    [65492, 65536],
  ])('fits a %i-byte plaintext in the smallest blob, %i bytes', (length, size) => {
    expect(bucketFor(length)).toBe(size);
  });

  it('refuses a plaintext over 65,492 bytes with a typed error', () => {
    const error = catchError(() => bucketFor(65493));

    expect(error).toBeInstanceOf(PayloadTooLarge);
    expect(error).toMatchObject({ name: 'PayloadTooLarge', size: 65493, limit: 65492 });
    expect(error).toHaveProperty('message', 'A blob carries at most 65492 bytes, not 65493.');
  });
});

describe('frameBody', () => {
  it('writes a 4-byte big-endian length, the plaintext, then zeros', () => {
    const plaintext = new Uint8Array(258).fill(7);

    const body = frameBody(plaintext);

    expect(body.length).toBe(1024 - NONCE_BYTES - TAG_BYTES);
    expect([...body.subarray(0, 4)]).toEqual([0, 0, 1, 2]);
    expect(body.subarray(4, 262)).toEqual(plaintext);
    expect(body.subarray(262).every((byte) => byte === 0)).toBe(true);
  });

  it('sizes the body for the bucket the plaintext needs', () => {
    expect(frameBody(new Uint8Array(981)).length).toBe(4096 - NONCE_BYTES - TAG_BYTES);
  });
});

describe('unframeBody', () => {
  it('returns the plaintext that frameBody framed', () => {
    const plaintext = utf8('quiet hours after ten');

    expect(unframeBody(frameBody(plaintext))).toEqual(plaintext);
  });

  it('refuses a body too short to hold the length', () => {
    expect(unframeBody(new Uint8Array(3))).toBeNull();
  });

  it('reads an empty plaintext from a body that is only its length', () => {
    expect(unframeBody(new Uint8Array(4))).toEqual(new Uint8Array(0));
  });

  it('refuses a length that runs past the body', () => {
    const body = frameBody(new Uint8Array(10));
    new DataView(body.buffer).setUint32(0, body.length - 4 + 1);

    expect(unframeBody(body)).toBeNull();
  });

  it('accepts a length that exactly fills the body', () => {
    const body = new Uint8Array(4 + 5).fill(1);
    body.set([0, 0, 0, 5]);

    expect(unframeBody(body)).toEqual(new Uint8Array(5).fill(1));
  });

  it('refuses padding that is not all zeros', () => {
    const body = frameBody(new Uint8Array(10));
    body[body.length - 1] = 1;

    expect(unframeBody(body)).toBeNull();
  });
});

describe('seal', () => {
  it('pads to the smallest bucket that fits', () => {
    expect(seal(MAILBOX, KEY, payload(1024 - 44)).length).toBe(1024);
    expect(seal(MAILBOX, KEY, payload(1024 - 43)).length).toBe(4096);
    expect(seal(MAILBOX, KEY, payload(4096 - 44)).length).toBe(4096);
    expect(seal(MAILBOX, KEY, payload(4096 - 43)).length).toBe(16384);
    expect(seal(MAILBOX, KEY, payload(16384 - 44)).length).toBe(16384);
    expect(seal(MAILBOX, KEY, payload(16384 - 43)).length).toBe(65536);
    expect(seal(MAILBOX, KEY, payload(65_492)).length).toBe(65536);
    expect(() => seal(MAILBOX, KEY, payload(65_493))).toThrow(PayloadTooLarge);
  });

  it('gives the stub’s blob size for any payload up to 65,492 bytes, and opens it again', () => {
    const lengths = fc.oneof(
      fc.constantFrom(0, 980, 981, 4052, 4053, 16340, 16341, MAX_PLAINTEXT_BYTES),
      fc.integer({ min: 0, max: MAX_PLAINTEXT_BYTES }),
    );
    fc.assert(
      fc.property(lengths, fc.nat(255), (length, seed) => {
        const bytes = payload(length, seed);

        const blob = seal(MAILBOX, KEY, bytes);

        expect(blob.length).toBe(stubSeal.seal(MAILBOX, KEY, bytes).length);
        expect(BLOB_SIZES).toContain(blob.length);
        expect(open(MAILBOX, KEY, blob)).toEqual(bytes);
      }),
    );
  });

  it('is a random nonce, then the framed payload under XChaCha20-Poly1305 with the mailbox as AD', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const bytes = utf8('{"type":"join","body":{"name":"Ben"}}');

    const blob = seal(MAILBOX, KEY, bytes);

    const nonce = blob.subarray(0, NONCE_BYTES);
    expect(random).toHaveBeenCalledTimes(1);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(nonce));
    const body = xchacha20poly1305(KEY, nonce, utf8(MAILBOX)).decrypt(blob.subarray(NONCE_BYTES));
    expect(bytesToHex(body)).toBe(bytesToHex(frameBody(bytes)));
  });

  it('never shows the payload, and uses a new nonce for every blob', () => {
    const bytes = utf8('Riverside Tenants: quiet hours start at ten.');

    const blobs = Array.from({ length: 50 }, () => seal(MAILBOX, KEY, bytes));

    const hex = blobs.map(bytesToHex);
    expect(hex.some((blob) => blob.includes(bytesToHex(bytes)))).toBe(false);
    expect(new Set(hex).size).toBe(50);
    expect(new Set(blobs.map((blob) => bytesToHex(blob.subarray(0, NONCE_BYTES)))).size).toBe(50);
  });

  it('refuses a key that isn’t 32 bytes', () => {
    expect(() => seal(MAILBOX, KEY.subarray(0, 31), payload(1))).toThrow();
  });
});

describe('open', () => {
  const blob = seal(MAILBOX, KEY, utf8('Quiet hours start at ten.'));

  it('opens what was sealed for this mailbox under this key', () => {
    expect(open(MAILBOX, KEY, blob)).toEqual(utf8('Quiet hours start at ten.'));
  });

  it('refuses another group’s key', () => {
    expect(open(MAILBOX, OTHER_KEY, blob)).toBeNull();
  });

  it('refuses a blob copied into another mailbox', () => {
    expect(open(OTHER_MAILBOX, KEY, blob)).toBeNull();
  });

  it.each([
    ['the nonce', 0],
    ['the nonce’s last byte', NONCE_BYTES - 1],
    ['the ciphertext’s length prefix', NONCE_BYTES],
    ['the ciphertext', 500],
    ['the tag', 1024 - TAG_BYTES],
    ['the tag’s last byte', 1024 - 1],
  ])('refuses one flipped bit in %s', (_where, at) => {
    expect(open(MAILBOX, KEY, flipped(blob, at))).toBeNull();
  });

  it('refuses any blob with any one byte changed', () => {
    fc.assert(
      fc.property(fc.nat(blob.length - 1), fc.integer({ min: 1, max: 255 }), (at, mask) => {
        expect(open(MAILBOX, KEY, flipped(blob, at, mask))).toBeNull();
      }),
    );
  });

  it.each([
    ['cut short by a byte', blob.subarray(0, blob.length - 1)],
    ['one byte longer', concatBytes(blob, Uint8Array.of(0))],
    ['cut to the smaller size', seal(MAILBOX, KEY, payload(2000)).subarray(0, 1024)],
    ['padded out to the next size', concatBytes(blob, new Uint8Array(4096 - 1024))],
    ['empty', new Uint8Array(0)],
    ['the nonce alone', blob.subarray(0, NONCE_BYTES)],
  ])('refuses a blob %s', (_how, changed) => {
    expect(open(MAILBOX, KEY, changed)).toBeNull();
  });

  it('refuses an authentic blob whose length runs past its frame', () => {
    const body = frameBody(payload(10));
    new DataView(body.buffer).setUint32(0, body.length - 4 + 1);

    expect(open(MAILBOX, KEY, sealedBody(body))).toBeNull();
  });

  it('opens an authentic blob whose length exactly fills its frame', () => {
    const body = frameBody(payload(10));
    new DataView(body.buffer).setUint32(0, body.length - 4);

    expect(open(MAILBOX, KEY, sealedBody(body))).toEqual(body.subarray(4));
  });

  it('refuses an authentic blob that isn’t one of the four sizes', () => {
    const body = new Uint8Array(100);
    new DataView(body.buffer).setUint32(0, 10);

    expect(sealedBody(body)).toHaveLength(24 + 100 + 16);
    expect(open(MAILBOX, KEY, sealedBody(body))).toBeNull();
  });

  it('refuses an authentic blob whose padding isn’t zeros', () => {
    const body = frameBody(payload(10));
    body[body.length - 1] = 1;

    expect(open(MAILBOX, KEY, sealedBody(body))).toBeNull();
  });

  it('answers null, never an error, for any bytes and any key', () => {
    const sized = fc
      .constantFrom(...BLOB_SIZES)
      .chain((size) => fc.uint8Array({ minLength: size, maxLength: size }));
    const keys = fc.uint8Array({ minLength: 0, maxLength: 40 });
    fc.assert(
      fc.property(fc.oneof(sized, fc.uint8Array({ maxLength: 5000 })), keys, (bytes, key) => {
        expect(open(MAILBOX, key, bytes)).toBeNull();
      }),
    );
  });
});

describe('xchachaSeal', () => {
  it('is the real seal behind the Seal interface', () => {
    expect(xchachaSeal).toEqual({ seal, open });
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}
