/**
 * A reconcile card left at a front door (#426; ADR-0077 §5): the inbox's new
 * kind beside an application, sealed to the door's key and padded the same
 * way, holding the card's seed and nothing else. An application reader never
 * opens one, a card reader never opens an application, and a card is surely
 * gone from the relay at the start of the second UTC day after it arrived.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import {
  APPLICATION_INFO,
  DOOR_CARD_INFO,
  doorChannelsOf,
  openPadded,
  sealPadded,
} from '../crypto/door';
import { createRelay } from '../net/relay';
import { DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { encodeApplication, parseApplication } from './apply';
import {
  cardGoneAt,
  cardsIn,
  DOOR_CARD_TTL_DAYS,
  encodeDoorCard,
  leaveCard,
  parseDoorCard,
} from './card';
import { addressOf, type OpenPage } from './page';

const encoder = new TextEncoder();
const SEED = new Uint8Array(32).fill(0x5e);
const ADDRESS = addressOf(DOOR);
const BOX_SECRET = fromBase64url(DOOR.box);
const BOX = kxPublicKeyOf(BOX_SECRET);
const { inbox: INBOX } = doorChannelsOf(ADDRESS);
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Riverside Tenants',
  excerpt: 'We keep rents fair.',
  box: base64url(BOX),
};
const APPLICATION = {
  name: 'Kim',
  message: 'Hello.',
  reply: { seed: base64url(new Uint8Array(32).fill(3)), key: base64url(kxPublicKeyOf(SEED)) },
};
const DAY = 1440;

describe('a card at the door, as bytes', () => {
  it('is exactly {card} with the seed in unpadded base64url, and reads back', () => {
    expect(new TextDecoder().decode(encodeDoorCard(SEED))).toBe(`{"card":"${base64url(SEED)}"}`);
    expect(parseDoorCard(encodeDoorCard(SEED))).toEqual(SEED);
  });

  it('round-trips any 32-byte seed (fast-check)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (seed) => {
        expect(Array.from(parseDoorCard(encodeDoorCard(seed)) ?? [])).toEqual(Array.from(seed));
      }),
      { numRuns: 50 },
    );
  });

  it.each([
    ['a sender beside the seed', { card: base64url(SEED), from: 'Riverside' }],
    ['a seed of 31 bytes', { card: base64url(new Uint8Array(31)) }],
    ['a seed with a spare bit set', { card: `${base64url(SEED).slice(0, 42)}f` }],
    ['no seed', {}],
    ['an application', APPLICATION],
  ])('refuses %s', (_name, value) => {
    expect(parseDoorCard(encoder.encode(JSON.stringify(value)))).toBeNull();
  });

  it('is never an application, so today’s strict parser ignores one', () => {
    expect(parseApplication(encodeDoorCard(SEED))).toBeNull();
  });
});

describe('leaveCard', () => {
  it('puts the seed in the door’s inbox for a day, sealed to its box and padded to one blob', async () => {
    const fake = createFakeRelay();
    await leaveCard({ relay: createRelay({ fetch: fake.fetch }) }, ADDRESS, PAGE, SEED);
    const [request, ...more] = fake.requests;
    expect(more).toEqual([]);
    expect(DOOR_CARD_TTL_DAYS).toBe(1);
    expect([request?.method, request?.url]).toEqual(['PUT', `/v1/mailbox/${INBOX}?ttl_days=1`]);
    const blob = request?.body ?? new Uint8Array();
    expect(blob).toHaveLength(1024);
    const opened = openPadded(BOX_SECRET, blob, DOOR_CARD_INFO, INBOX);
    expect(parseDoorCard(opened ?? new Uint8Array())).toEqual(SEED);
    // An application reader, today's included, never opens it.
    expect(openPadded(BOX_SECRET, blob, APPLICATION_INFO, INBOX)).toBeNull();
    expect(new TextDecoder().decode(blob)).not.toContain(base64url(SEED));
  });
});

describe('cardsIn: the cards among an inbox page', () => {
  it('reads each card that opens, and never an application', () => {
    const card = sealPadded(BOX, encodeDoorCard(SEED), DOOR_CARD_INFO, INBOX);
    const application = sealPadded(BOX, encodeApplication(APPLICATION), APPLICATION_INFO, INBOX);
    // A card's bytes sealed as an application, and an application's as a card: neither reads.
    const crossed = sealPadded(BOX, encodeApplication(APPLICATION), DOOR_CARD_INFO, INBOX);
    const page = {
      records: [
        { seq: 3, received: 100, data: application },
        { seq: 4, received: 101, data: card },
        { seq: 5, received: 102, data: crossed },
      ],
      instance: 'i',
      now: 103,
    };
    const [found, ...rest] = cardsIn(page, INBOX, BOX_SECRET);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ seq: 4, received: 101, seed: base64url(SEED) });
    expect(found?.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(DOOR_CARD_INFO).not.toBe(APPLICATION_INFO);
  });
});

describe('cardGoneAt: when the relay has surely dropped a card', () => {
  it('is the start of the second UTC day after its entry arrived, as the relay keeps a day', () => {
    expect(cardGoneAt(10 * DAY)).toBe(12 * DAY);
    expect(cardGoneAt(10 * DAY + DAY - 1)).toBe(12 * DAY);
    expect(cardGoneAt(11 * DAY)).toBe(13 * DAY);
  });
});
