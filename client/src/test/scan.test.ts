import { describe, expect, it } from 'vitest';

import { findCanaries, keyCanaries, spellings, textCanary } from './scan';

/** Bytes whose base64 needs `+` and `/`, so the two alphabets differ. */
const BYTES = Uint8Array.from([0xfb, 0xff, 0xbf, 0, 1, 2, 3, 4, 5, 0xfa]);

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

describe('spellings', () => {
  it('lists the bytes, hex in both cases, and both base64 alphabets at all three alignments', () => {
    const found = spellings(BYTES).map(({ encoding, needle }) => [encoding, latin1(needle)]);

    expect(found).toEqual([
      ['bytes', latin1(BYTES)],
      ['hex', 'fbffbf000102030405fa'],
      ['HEX', 'FBFFBF000102030405FA'],
      ['base64 at offset 0', '+/+/AAECAwQF'],
      ['base64url at offset 0', '-_-_AAECAwQF'],
      ['base64 at offset 1', 'vwABAgME'],
      ['base64url at offset 1', 'vwABAgME'],
      ['base64 at offset 2', '/78AAQIDBAX6'],
      ['base64url at offset 2', '_78AAQIDBAX6'],
    ]);
  });

  it('refuses a canary too short to scan for', () => {
    expect(() => spellings(new Uint8Array(7))).toThrow(
      new RangeError('A canary needs at least 8 bytes.'),
    );
  });
});

describe('findCanaries', () => {
  it('finds a key written as base64 mid-text, and text as UTF-8, and nothing that isn’t there', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const haystack = new TextEncoder().encode(
      `x${btoa(String.fromCharCode(0, ...key))}y Canary Street`,
    );
    const canaries = [
      ...keyCanaries('key', key),
      textCanary('name', 'Canary Street'),
      textCanary('absent', 'Not in the file'),
    ];

    // These key bytes spell no `+` or `/`, so both alphabets match.
    expect(findCanaries(haystack, canaries)).toEqual([
      'key (raw), as base64 at offset 1',
      'key (raw), as base64url at offset 1',
      'name, as bytes',
    ]);
  });
});
