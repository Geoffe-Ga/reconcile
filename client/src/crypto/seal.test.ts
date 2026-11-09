import { describe, expect, it } from 'vitest';

import {
  BLOB_SIZES,
  MAX_PLAINTEXT_BYTES,
  NONCE_BYTES,
  PayloadTooLarge,
  TAG_BYTES,
  bucketFor,
  frameBody,
  isBlobSize,
  unframeBody,
} from './seal';
import { utf8 } from '../test/bytes';

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

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}
