/**
 * A shelf record's body (#484; docs/spec/listed-doors.md §4.1): compact
 * UTF-8 JSON in a fixed key order, read back only when it is exactly one of
 * the kinds this slice writes. A steward's notice (#488, #489, §6.1) reads
 * back only when it names exactly what its act names: a release an address;
 * a hold an address, a clause and maybe an entry; an uphold an address, an
 * entry and a clause; a suspend an address and a clause; and a pause `on`.
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
const ADDRESS = base64url(new Uint8Array(32).fill(3));
const RELEASE: ShelfBody = { v: 1, kind: 'notice', act: 'release', address: ADDRESS };
const NOTICE = { v: 1, kind: 'notice' } as const;

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
    expect(text(encodeShelfBody(RELEASE))).toBe(
      `{"v":1,"kind":"notice","act":"release","address":"${ADDRESS}"}`,
    );
  });

  it('writes a notice’s fields in the spec’s order, leaving out those it lacks', () => {
    const uphold = { clause: 'C2', id: ID, address: ADDRESS, act: 'uphold', kind: 'notice', v: 1 };
    expect(text(encodeShelfBody(uphold as ShelfBody))).toBe(
      `{"v":1,"kind":"notice","act":"uphold","address":"${ADDRESS}","id":"${ID}","clause":"C2"}`,
    );
    const hold = { clause: 'C3', address: ADDRESS, act: 'hold', kind: 'notice', v: 1 };
    expect(text(encodeShelfBody(hold as ShelfBody))).toBe(
      `{"v":1,"kind":"notice","act":"hold","address":"${ADDRESS}","clause":"C3"}`,
    );
    expect(text(encodeShelfBody({ on: false, act: 'pause', kind: 'notice', v: 1 }))).toBe(
      '{"v":1,"kind":"notice","act":"pause","on":false}',
    );
  });

  it('writes the same bytes whatever order the object was built in', () => {
    const shuffled = { text: '', title: 'Rent strike vote', id: ID, kind: 'entry', v: 1 } as const;
    expect(encodeShelfBody(shuffled)).toEqual(encodeShelfBody(ENTRY));
  });
});

describe('parseShelfBody', () => {
  it.each([LISTING, FINAL, ENTRY, WITHDRAW, RELEASE].map((body) => [body.kind, body] as const))(
    'reads back a %s it wrote',
    (_kind, body) => {
      expect(parseShelfBody(encodeShelfBody(body))).toEqual(body);
    },
  );

  it.each([
    ['a hold of an entry', { ...NOTICE, act: 'hold', address: ADDRESS, id: ID, clause: 'C2' }],
    ['a hold of an address', { ...NOTICE, act: 'hold', address: ADDRESS, clause: 'C3' }],
    ['an uphold', { ...NOTICE, act: 'uphold', address: ADDRESS, id: ID, clause: 'C1' }],
    ['a suspend', { ...NOTICE, act: 'suspend', address: ADDRESS, clause: 'C3' }],
    ['a pause', { ...NOTICE, act: 'pause', on: true }],
    ['the end of a pause', { ...NOTICE, act: 'pause', on: false }],
  ] as const)('reads back %s (#489)', (_name, body) => {
    expect(parseShelfBody(json(body))).toEqual(body);
    expect(parseShelfBody(encodeShelfBody(body))).toEqual(body);
  });

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
    ['a notice with an act it doesn’t know', json({ ...RELEASE, act: 'ban' })],
    ['a release naming no address', json({ v: 1, kind: 'notice', act: 'release' })],
    ['a release naming no key', json({ ...RELEASE, address: 'oak' })],
    ['a release with a key too many', json({ ...RELEASE, id: ID })],
    ['a hold with no clause', json({ ...RELEASE, act: 'hold' })],
    ['a hold naming no key', json({ ...NOTICE, act: 'hold', address: 7, clause: 'C1' })],
    ['a hold with a bad id', json({ ...RELEASE, act: 'hold', id: 'd1', clause: 'C1' })],
    ['a hold with a key too many', json({ ...RELEASE, act: 'hold', clause: 'C1', on: true })],
    ['an uphold with a bad clause', json({ ...RELEASE, act: 'uphold', id: ID, clause: 'C4' })],
    ['an uphold naming no entry', json({ ...RELEASE, act: 'uphold', clause: 'C1' })],
    ['a suspend naming an entry', json({ ...RELEASE, act: 'suspend', id: ID, clause: 'C1' })],
    ['a suspend naming no address', json({ ...NOTICE, act: 'suspend', clause: 'C1' })],
    ['a pause with no on', json({ ...NOTICE, act: 'pause' })],
    ['a pause whose on isn’t true or false', json({ ...NOTICE, act: 'pause', on: 1 })],
    ['a pause naming an address', json({ ...RELEASE, act: 'pause', on: true })],
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
