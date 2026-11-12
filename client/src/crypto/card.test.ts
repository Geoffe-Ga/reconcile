import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import {
  CARD_KEY_INFO,
  CARD_MAILBOX_INFO,
  CARD_SEED_BYTES,
  COALITION_ENTRY_INFO,
  cardChannelOf,
  deriveCoalitionEntryId,
  newCardSeed,
} from './card';
import { deriveSealKey, deriveWeekMailboxId } from './groupKeys';
import { deriveInviteKey, deriveInviteMailboxId } from './invite';

/** `vectors/card.json`: fixed seeds' derivations, computed outside @noble. */
interface CardFile {
  readonly kind: 'card';
  readonly infos: {
    readonly cardMailboxId: string;
    readonly cardKey: string;
    readonly coalitionEntryId: string;
  };
  readonly derivations: readonly {
    readonly name: string;
    readonly seed: readonly number[];
    readonly cardMailboxId: readonly number[];
    readonly cardKey: readonly number[];
    readonly coalitionEntryId: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<CardFile>('./vectors/card.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/card.json is missing.');

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe('card.json', () => {
  it('names the labels the derivations use', () => {
    expect(file.kind).toBe('card');
    expect(file.infos).toEqual({
      cardMailboxId: CARD_MAILBOX_INFO,
      cardKey: CARD_KEY_INFO,
      coalitionEntryId: COALITION_ENTRY_INFO,
    });
    expect([CARD_MAILBOX_INFO, CARD_KEY_INFO, COALITION_ENTRY_INFO]).toEqual([
      'reconcile/v1/card-mailbox',
      'reconcile/v1/card-key',
      'reconcile/v1/coalition-entry',
    ]);
  });

  it.each(file.derivations.map((vector) => [vector.name, vector] as const))(
    'pins the card mailbox id, card key and entry id of %s',
    (_name, vector) => {
      const seed = Uint8Array.from(vector.seed);
      const channel = cardChannelOf(seed);

      expect(channel.mailbox).toBe(base64url(Uint8Array.from(vector.cardMailboxId)));
      expect(Array.from(channel.key)).toEqual(vector.cardKey);
      expect(deriveCoalitionEntryId(seed)).toBe(
        base64url(Uint8Array.from(vector.coalitionEntryId)),
      );
    },
  );
});

describe('a card seed', () => {
  it('is 32 fresh bytes each time', () => {
    const first = newCardSeed();
    const second = newCardSeed();
    expect(first).toHaveLength(CARD_SEED_BYTES);
    expect(CARD_SEED_BYTES).toBe(32);
    expect(base64url(first)).not.toBe(base64url(second));
  });

  it('names no invite, group mailbox or seal key, and its id and key differ', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const { mailbox, key } = cardChannelOf(seed);
        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(mailbox).not.toBe(deriveInviteMailboxId(seed));
        expect(mailbox).not.toBe(deriveWeekMailboxId(seed, 0));
        expect(base64url(key)).not.toBe(base64url(deriveInviteKey(seed)));
        expect(base64url(key)).not.toBe(base64url(deriveSealKey(seed)));
        expect(base64url(key)).not.toBe(mailbox);
      }),
    );
  });

  it.each([0, 31, 33])('refuses a seed of %i bytes', (length) => {
    expect(() => cardChannelOf(new Uint8Array(length))).toThrow(RangeError);
  });
});

describe('a coalition entry id', () => {
  it('is 43 base64url characters, the same for one secret, and no mailbox id', () => {
    fc.assert(
      fc.property(seeds, (secret) => {
        const id = deriveCoalitionEntryId(secret);
        expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(deriveCoalitionEntryId(Uint8Array.from(secret))).toBe(id);
        expect(id).not.toBe(deriveWeekMailboxId(secret, 0));
      }),
    );
  });

  it('refuses a secret that isn’t 32 bytes', () => {
    expect(() => deriveCoalitionEntryId(new Uint8Array(16))).toThrow(RangeError);
  });
});
