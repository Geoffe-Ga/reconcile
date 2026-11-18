/**
 * A shelf record's body (#484; docs/spec/listed-doors.md §4.1): compact
 * UTF-8 JSON in a fixed key order, read back only when it is exactly one of
 * the kinds this slice writes.
 */
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { verifyShelfRecord } from '../crypto/shelf';
import {
  encodeShelfBody,
  ENTRY_TEXT_MAX,
  ENTRY_TITLE_MAX,
  LISTING_NAME_MAX,
  parseShelfBody,
  type ShelfBody,
  signShelfBody,
} from './record';

const ID = base64url(new Uint8Array(32).fill(7));
const COVENANT = base64url(new Uint8Array(32).fill(9));
const encoder = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

const LISTING: ShelfBody = {
  v: 1,
  kind: 'listing',
  open: true,
  name: 'Oak St Tenants',
  skeleton: 'oaksttenants',
  covenant: COVENANT,
};
const FINAL: ShelfBody = { v: 1, kind: 'listing', open: false, final: true };
const ENTRY: ShelfBody = { v: 1, kind: 'entry', id: ID, title: 'Rent strike vote', text: '' };
const WITHDRAW: ShelfBody = { v: 1, kind: 'withdraw', id: ID };

describe('encodeShelfBody', () => {
  it('writes each kind as compact JSON with its keys in the spec’s order', () => {
    expect(text(encodeShelfBody(LISTING))).toBe(
      `{"v":1,"kind":"listing","open":true,"name":"Oak St Tenants","skeleton":"oaksttenants","covenant":"${COVENANT}"}`,
    );
    expect(text(encodeShelfBody(FINAL))).toBe('{"v":1,"kind":"listing","open":false,"final":true}');
    expect(text(encodeShelfBody(ENTRY))).toBe(
      `{"v":1,"kind":"entry","id":"${ID}","title":"Rent strike vote","text":""}`,
    );
    expect(text(encodeShelfBody(WITHDRAW))).toBe(`{"v":1,"kind":"withdraw","id":"${ID}"}`);
  });

  it('writes the same bytes whatever order the object was built in', () => {
    const shuffled = { text: '', title: 'Rent strike vote', id: ID, kind: 'entry', v: 1 } as const;
    expect(encodeShelfBody(shuffled)).toEqual(encodeShelfBody(ENTRY));
  });
});

describe('parseShelfBody', () => {
  it.each([LISTING, FINAL, ENTRY, WITHDRAW].map((body) => [body.kind, body] as const))(
    'reads back a %s it wrote',
    (_kind, body) => {
      expect(parseShelfBody(encodeShelfBody(body))).toEqual(body);
    },
  );

  it('takes a name, title and text at their longest, counted in code points', () => {
    const listing = { ...LISTING, name: '𝔸'.repeat(LISTING_NAME_MAX) };
    const entry = {
      ...ENTRY,
      title: '𝔸'.repeat(ENTRY_TITLE_MAX),
      text: '𝔸'.repeat(ENTRY_TEXT_MAX),
    };
    expect(parseShelfBody(encodeShelfBody(listing))).toEqual(listing);
    expect(parseShelfBody(encodeShelfBody(entry))).toEqual(entry);
  });

  it.each([
    ['bad UTF-8', Uint8Array.of(0xff, 0xfe)],
    ['not JSON', encoder.encode('listing')],
    ['an array', json([LISTING])],
    ['another version', json({ ...LISTING, v: 2 })],
    ['a notice, which is the steward’s (#488)', json({ v: 1, kind: 'notice', act: 'pause' })],
    ['an unknown kind', json({ ...WITHDRAW, kind: 'pitch' })],
    ['a key too many', json({ ...LISTING, author: 'Ana' })],
    ['a key too few', json({ v: 1, kind: 'listing', open: true, name: 'Oak' })],
    ['an empty name', json({ ...LISTING, name: '' })],
    ['a name too long', json({ ...LISTING, name: 'x'.repeat(LISTING_NAME_MAX + 1) })],
    ['a name that isn’t text', json({ ...LISTING, name: 7 })],
    ['a skeleton that isn’t text', json({ ...LISTING, skeleton: null })],
    ['a covenant that isn’t a hash', json({ ...LISTING, covenant: 'abc' })],
    ['an open listing marked final', json({ ...LISTING, final: true })],
    ['a closed listing that isn’t final', json({ v: 1, kind: 'listing', open: false })],
    ['a final listing with false', json({ ...FINAL, final: false })],
    ['an entry with an empty title', json({ ...ENTRY, title: '' })],
    ['an entry with a title too long', json({ ...ENTRY, title: 'x'.repeat(ENTRY_TITLE_MAX + 1) })],
    ['an entry with a text too long', json({ ...ENTRY, text: 'x'.repeat(ENTRY_TEXT_MAX + 1) })],
    ['an entry whose text isn’t text', json({ ...ENTRY, text: 0 })],
    ['an entry whose id isn’t an id', json({ ...ENTRY, id: 'd1' })],
    ['a withdraw whose id isn’t an id', json({ ...WITHDRAW, id: `${ID}=` })],
  ])('refuses %s', (_name, bytes) => {
    expect(parseShelfBody(bytes)).toBeNull();
  });
});

describe('signShelfBody', () => {
  it('signs the body’s bytes as a shelf record its key’s address verifies', () => {
    const keys = newSigningKeys();
    const record = signShelfBody(keys, LISTING);
    const opened = verifyShelfRecord(record, base64url(keys.publicKey));
    expect(opened && Array.from(opened)).toEqual(Array.from(encodeShelfBody(LISTING)));
  });
});
