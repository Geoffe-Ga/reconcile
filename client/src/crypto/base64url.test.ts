/**
 * Unpadded base64url: the same text for any bytes, however long, so a
 * megabytes-long backup (#97) spells its bytes as a short id does.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, canonicalBytes, fromBase64url } from './base64url';

/** The `count` characters from `first` on. */
function run(first: string, count: number): string {
  return String.fromCharCode(...Array.from({ length: count }, (_, i) => first.charCodeAt(0) + i));
}

/** RFC 4648 §5's alphabet: A–Z, a–z, 0–9, then - and _. */
const ALPHABET = `${run('A', 26)}${run('a', 26)}${run('0', 10)}-_`;

/** RFC 4648 §5 by hand, a byte at a time: the reference the app's version must match. */
function reference(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = bytes.subarray(at, at + 3);
    const word = (a << 16) | (b << 8) | c;
    const chars = Math.min(4, Math.ceil(((bytes.length - at) * 8) / 6));
    for (let i = 0; i < chars; i += 1) text += ALPHABET.charAt((word >> (18 - 6 * i)) & 63);
  }
  return text;
}

describe('base64url', () => {
  it('uses the 64 characters RFC 4648 §5 names', () => {
    expect(ALPHABET).toHaveLength(64);
    expect(new Set(ALPHABET).size).toBe(64);
    expect([ALPHABET.slice(0, 2), ALPHABET.slice(26, 28), ALPHABET.slice(52)]).toEqual([
      'AB',
      'ab',
      '0123456789-_',
    ]);
  });

  it('spells any bytes as RFC 4648 §5 does, unpadded, and reads them back', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(base64url(bytes)).toBe(reference(bytes));
        expect(Array.from(fromBase64url(base64url(bytes)))).toEqual(Array.from(bytes));
      }),
    );
  });

  it.each([32767, 32768, 32769, 65536, 98305, 300_001])(
    'spells %i bytes whole, across every chunk it builds them in',
    (length) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;

      expect(base64url(bytes)).toBe(reference(bytes));
    },
  );
});

describe('canonicalBytes', () => {
  it('reads back exactly what base64url spells', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        expect(Array.from(canonicalBytes(base64url(bytes)) ?? [])).toEqual(Array.from(bytes));
      }),
    );
  });

  it('refuses any other spelling: padding, spare bits, other alphabets, spaces or a lone character', () => {
    // "AQ" is one byte; "AR" sets spare bits; "+/" and padding are base64, not base64url.
    expect(Array.from(canonicalBytes('AQ') ?? [])).toEqual([1]);
    for (const text of ['AQ==', 'AR', 'A', '+/8', 'A Q', 'AQ\n', '!!']) {
      expect(canonicalBytes(text), text).toBeNull();
    }
  });

  it('refuses anything that isn’t a string', () => {
    for (const value of [undefined, null, 7, ['AQ'], { text: 'AQ' }]) {
      expect(canonicalBytes(value)).toBeNull();
    }
  });
});
