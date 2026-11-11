/**
 * A shared Document's copies (#105): UTF-8 JSON, either the latest version
 * `{v: 1, n, title, text}` or a tombstone `{v: 1, n, stopped: true}`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_RECORD_BYTES, RECORD_HEADER_BYTES } from '../crypto/record';
import { encodeCopy, fitsShare, parseCopy, type ShareCopy } from './copy';

const utf8 = (text: string) => new TextEncoder().encode(text);
const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('encodeCopy', () => {
  it('spells a version and a tombstone as compact JSON, in a fixed key order', () => {
    expect(decoded(encodeCopy({ v: 1, n: 3, title: 'Me', text: 'Real.\n' }))).toBe(
      '{"v":1,"n":3,"title":"Me","text":"Real.\\n"}',
    );
    expect(decoded(encodeCopy({ v: 1, n: 4, stopped: true }))).toBe('{"v":1,"n":4,"stopped":true}');
  });

  it('reads back as what it spelled, for any title and text', () => {
    const titles = fc
      .string({ minLength: 1, maxLength: 40, unit: 'grapheme' })
      .map((title) => title.trim())
      .filter((title) => title !== '');
    fc.assert(
      fc.property(titles, fc.string({ unit: 'grapheme' }), fc.nat(), (title, text, n) => {
        const copy: ShareCopy = { v: 1, n: n + 1, title, text };
        expect(parseCopy(encodeCopy(copy))).toEqual(copy);
      }),
      { numRuns: 100 },
    );
  });
});

describe('parseCopy', () => {
  it('reads a version and a tombstone', () => {
    expect(parseCopy(utf8('{"v":1,"n":1,"title":"Me","text":""}'))).toEqual({
      v: 1,
      n: 1,
      title: 'Me',
      text: '',
    });
    expect(parseCopy(utf8('{"v":1,"n":9,"stopped":true}'))).toEqual({ v: 1, n: 9, stopped: true });
  });

  it.each([
    ['bytes that aren’t UTF-8', Uint8Array.of(0xff, 0x7b)],
    ['text that isn’t JSON', utf8('{"v":1,')],
    ['a list', utf8('[1]')],
    ['another version', utf8('{"v":2,"n":1,"title":"Me","text":""}')],
    ['no version', utf8('{"n":1,"title":"Me","text":""}')],
    ['an n of 0', utf8('{"v":1,"n":0,"title":"Me","text":""}')],
    ['a fractional n', utf8('{"v":1,"n":1.5,"title":"Me","text":""}')],
    ['an n past 2^53', utf8('{"v":1,"n":9007199254740992,"title":"Me","text":""}')],
    ['an n that’s text', utf8('{"v":1,"n":"1","title":"Me","text":""}')],
    ['a blank title', utf8('{"v":1,"n":1,"title":"","text":""}')],
    ['a title with a space around it', utf8('{"v":1,"n":1,"title":" Me","text":""}')],
    ['a title of 121 code points', utf8(`{"v":1,"n":1,"title":"${'x'.repeat(121)}","text":""}`)],
    ['a text that isn’t text', utf8('{"v":1,"n":1,"title":"Me","text":7}')],
    ['no text', utf8('{"v":1,"n":1,"title":"Me"}')],
    ['a field beside the four', utf8('{"v":1,"n":1,"title":"Me","text":"","by":"Ana"}')],
    ['a tombstone that isn’t true', utf8('{"v":1,"n":1,"stopped":false}')],
    ['a tombstone with a title', utf8('{"v":1,"n":1,"stopped":true,"title":"Me"}')],
    ['a tombstone with no n', utf8('{"v":1,"stopped":true}')],
  ])('refuses %s', (_name, bytes) => {
    expect(parseCopy(bytes)).toBe(null);
  });
});

describe('fitsShare', () => {
  /** The longest text whose record, at the largest `n`, still fits 64,000 bytes. */
  const room =
    MAX_RECORD_BYTES -
    RECORD_HEADER_BYTES -
    encodeCopy({
      v: 1,
      n: Number.MAX_SAFE_INTEGER,
      title: 'Me',
      text: '',
    }).length;

  it('takes a Document whose record fits 64,000 bytes at any n, counting bytes, not characters', () => {
    expect(fitsShare({ title: 'Me', text: 'x'.repeat(room) })).toBe(true);
    expect(fitsShare({ title: 'Me', text: 'x'.repeat(room + 1) })).toBe(false);
    // é is two bytes in UTF-8: half as many fit.
    expect(fitsShare({ title: 'Me', text: 'é'.repeat(Math.floor(room / 2)) })).toBe(true);
    expect(fitsShare({ title: 'Me', text: 'é'.repeat(Math.floor(room / 2) + 1) })).toBe(false);
  });

  it('counts JSON’s escapes, as the record spells them', () => {
    // A line break is two bytes in JSON: \n.
    expect(fitsShare({ title: 'Me', text: '\n'.repeat(Math.floor(room / 2)) })).toBe(true);
    expect(fitsShare({ title: 'Me', text: '\n'.repeat(Math.floor(room / 2) + 1) })).toBe(false);
  });
});
