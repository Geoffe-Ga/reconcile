import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { cardChannelOf, newCardSeed } from '../crypto/card';
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf } from '../crypto/invite';
import { BLOB_SIZES, MAX_PLAINTEXT_BYTES, xchachaSeal } from '../crypto/seal';
import type { LogRecord } from '../engine/fold';
import { stubSeal } from '../test/stubSeal';
import {
  type Card,
  CARD_TTL_DAYS,
  CardTooLarge,
  cardLink,
  openCard,
  parseCardLink,
  parseCardPayload,
  sealCard,
} from './card';

const SEAT_KEY = base64url(new Uint8Array(32).fill(9));

/** A card for a coalition still to form, under fresh secrets. */
function card(overrides: Partial<Card> = {}): Card {
  return {
    secret: newGroupSecret(),
    inner: newGroupSecret(),
    seat: { name: 'Riverside Tenants', key: SEAT_KEY },
    name: 'Eastside Housing',
    title: 'Mission statement',
    atoms: ['Everyone has a home.', 'We meet monthly.'],
    entries: [],
    ...overrides,
  };
}

/** A card's header JSON with `change` applied, sealed as its one blob. */
function headerBlob(seed: Uint8Array, change: (json: Record<string, unknown>) => unknown) {
  const channel = cardChannelOf(seed);
  const [header] = sealCard(stubSeal, channel, card());
  const opened = stubSeal.open(channel.mailbox, channel.key, header ?? new Uint8Array());
  const json = JSON.parse(new TextDecoder().decode(opened ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
  const text = JSON.stringify(change(json));
  return stubSeal.seal(channel.mailbox, channel.key, new TextEncoder().encode(text));
}

function entry(seq: number, size: number): LogRecord {
  return { seq, received: 29_000_000 + seq, bytes: new Uint8Array(size).fill(seq % 256) };
}

describe('a card’s envelope', () => {
  it('opens to what was sealed, with no log for a coalition still to form', () => {
    const seed = newCardSeed();
    const made = card();
    const blobs = sealCard(xchachaSeal, cardChannelOf(seed), made);

    expect(blobs).toHaveLength(1);
    expect(BLOB_SIZES).toContain(blobs[0]?.length);
    expect(openCard(xchachaSeal, cardChannelOf(seed), blobs)).toEqual(made);
    expect(CARD_TTL_DAYS).toBe(1);
  });

  it('carries a formed coalition’s log in chunks after the header', () => {
    const seed = newCardSeed();
    const entries = [entry(1, 40_000), entry(5, 40_000), entry(9, 20)];
    const made = card({ entries });
    const blobs = sealCard(xchachaSeal, cardChannelOf(seed), made);

    expect(blobs).toHaveLength(3);
    expect(openCard(xchachaSeal, cardChannelOf(seed), blobs)).toEqual(made);
  });

  it('round-trips any name, statement and secrets it can carry', () => {
    const text = fc.string({ minLength: 1, maxLength: 120, unit: 'grapheme-composite' });
    fc.assert(
      fc.property(text, text, fc.array(fc.string()), (name, seatName, atoms) => {
        const seed = newCardSeed();
        const made = card({ name, atoms, seat: { name: seatName, key: SEAT_KEY } });
        const blobs = sealCard(stubSeal, cardChannelOf(seed), made);
        expect(openCard(stubSeal, cardChannelOf(seed), blobs)).toEqual(made);
      }),
    );
  });

  it('never holds a seat secret: only the seat’s name and public key', () => {
    const seed = newCardSeed();
    const channel = cardChannelOf(seed);
    const [blob] = sealCard(stubSeal, channel, card());
    const text = new TextDecoder().decode(
      stubSeal.open(channel.mailbox, channel.key, blob ?? new Uint8Array()) ?? new Uint8Array(),
    );
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'atoms',
      'chunkCount',
      'inner',
      'name',
      'seat',
      'secret',
      'title',
    ]);
    expect(Object.keys((JSON.parse(text) as { seat: object }).seat)).toEqual(['name', 'key']);
  });

  it('refuses a statement too large for one blob', () => {
    const atoms = ['x'.repeat(MAX_PLAINTEXT_BYTES)];
    expect(() => sealCard(stubSeal, cardChannelOf(newCardSeed()), card({ atoms }))).toThrow(
      CardTooLarge,
    );
  });

  it('reads as damaged with no blob, a blob that won’t open, or the wrong chunks', () => {
    const seed = newCardSeed();
    const channel = cardChannelOf(seed);
    const blobs = sealCard(xchachaSeal, channel, card({ entries: [entry(1, 30)] }));
    const [header, chunk] = blobs;

    expect(openCard(xchachaSeal, channel, [])).toBeNull();
    expect(openCard(xchachaSeal, channel, [header ?? new Uint8Array()])).toBeNull();
    expect(openCard(xchachaSeal, channel, [...blobs, chunk ?? new Uint8Array()])).toBeNull();
    expect(openCard(xchachaSeal, cardChannelOf(newCardSeed()), blobs)).toBeNull();
    expect(openCard(xchachaSeal, inviteChannelOf(seed), blobs)).toBeNull();
    const garbled = stubSeal.seal(channel.mailbox, channel.key, Uint8Array.of(1, 2, 3));
    expect(openCard(stubSeal, channel, [garbled])).toBeNull();
    const broken = stubSeal.seal(channel.mailbox, channel.key, Uint8Array.of(0xff, 0xfe));
    expect(openCard(stubSeal, channel, [broken])).toBeNull();
    const badChunk = stubSeal.seal(channel.mailbox, channel.key, Uint8Array.of(9));
    const [plainHeader] = sealCard(stubSeal, channel, card({ entries: [entry(1, 30)] }));
    expect(openCard(stubSeal, channel, [plainHeader ?? new Uint8Array(), badChunk])).toBeNull();
  });

  it.each([
    ['no secret', (json: Record<string, unknown>) => ({ ...json, secret: undefined })],
    ['a short inner', (json: Record<string, unknown>) => ({ ...json, inner: 'abc' })],
    [
      'a secret that isn’t canonical',
      (json: Record<string, unknown>) => ({
        ...json,
        secret: `${String(json.secret).slice(0, 42)}B`,
      }),
    ],
    ['an empty name', (json: Record<string, unknown>) => ({ ...json, name: '' })],
    [
      'a name of 121 code points',
      (json: Record<string, unknown>) => ({ ...json, name: 'n'.repeat(121) }),
    ],
    ['a numeric title', (json: Record<string, unknown>) => ({ ...json, title: 1 })],
    [
      'a title of 121 code points',
      (json: Record<string, unknown>) => ({ ...json, title: 't'.repeat(121) }),
    ],
    ['atoms that aren’t strings', (json: Record<string, unknown>) => ({ ...json, atoms: [1] })],
    ['atoms that aren’t a list', (json: Record<string, unknown>) => ({ ...json, atoms: 'one' })],
    ['no seat', (json: Record<string, unknown>) => ({ ...json, seat: undefined })],
    [
      'a seat with no name',
      (json: Record<string, unknown>) => ({ ...json, seat: { key: SEAT_KEY } }),
    ],
    [
      'a seat with a short key',
      (json: Record<string, unknown>) => ({ ...json, seat: { name: 'R', key: 'x' } }),
    ],
    ['a negative chunk count', (json: Record<string, unknown>) => ({ ...json, chunkCount: -1 })],
    ['a fractional chunk count', (json: Record<string, unknown>) => ({ ...json, chunkCount: 0.5 })],
    ['a chunk count as text', (json: Record<string, unknown>) => ({ ...json, chunkCount: '0' })],
    ['a list for a header', () => []],
  ])('reads as damaged with %s', (_label, change) => {
    const seed = newCardSeed();
    expect(openCard(stubSeal, cardChannelOf(seed), [headerBlob(seed, change)])).toBeNull();
  });
});

describe('a card link', () => {
  it('is the origin, then the seed after #reconcile/, and reads back from any origin', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (seed) => {
        const link = cardLink('https://reconcile.test', seed);
        expect(link).toBe(`https://reconcile.test/#reconcile/${base64url(seed)}`);
        expect(parseCardLink(link)).toEqual(seed);
        expect(parseCardLink(`  ${link.replace('reconcile.test', 'other.example')}\n`)).toEqual(
          seed,
        );
        expect(parseCardPayload(base64url(seed))).toEqual(seed);
      }),
    );
  });

  it.each([
    ['an invite link', `https://reconcile.test/#join/${base64url(new Uint8Array(32).fill(1))}`],
    ['a bare seed, which is an invite’s', base64url(new Uint8Array(32).fill(1))],
    ['a seed one character short', `https://r.test/#reconcile/${'A'.repeat(42)}`],
    ['a seed whose last character isn’t canonical', `https://r.test/#reconcile/${'A'.repeat(42)}B`],
    ['a seed with a slash after it', `https://r.test/#reconcile/${'A'.repeat(43)}/x`],
    ['an old route form', `https://r.test/#/reconcile/${'A'.repeat(43)}`],
    ['text that isn’t a link', 'reconcile with us'],
  ])('is null for %s', (_label, text) => {
    expect(parseCardLink(text)).toBeNull();
  });

  it('reads no payload that isn’t 43 base64url characters', () => {
    expect(parseCardPayload('A'.repeat(44))).toBeNull();
    expect(parseCardPayload('+'.repeat(43))).toBeNull();
  });
});
