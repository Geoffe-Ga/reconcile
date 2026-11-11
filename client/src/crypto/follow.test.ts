import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { cardChannelOf, deriveCoalitionEntryId } from './card';
import {
  FOLLOW_KEY_INFO,
  FOLLOW_MAILBOX_INFO,
  FOLLOW_SEED_BYTES,
  followChannelOf,
  newFollowSeed,
} from './follow';
import { deriveSealKey, deriveWeekMailboxId } from './groupKeys';
import { deriveInviteKey, deriveInviteMailboxId } from './invite';

/** `vectors/follow.json`: fixed seeds' derivations, computed outside @noble. */
interface FollowFile {
  readonly kind: 'follow';
  readonly infos: { readonly followMailboxId: string; readonly followKey: string };
  readonly derivations: readonly {
    readonly name: string;
    readonly seed: readonly number[];
    readonly followMailboxId: readonly number[];
    readonly followKey: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<FollowFile>('./vectors/follow.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/follow.json is missing.');

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe('follow.json', () => {
  it('names the labels the derivations use', () => {
    expect(file.kind).toBe('follow');
    expect(file.infos).toEqual({
      followMailboxId: FOLLOW_MAILBOX_INFO,
      followKey: FOLLOW_KEY_INFO,
    });
    expect([FOLLOW_MAILBOX_INFO, FOLLOW_KEY_INFO]).toEqual([
      'reconcile/v1/follow-mailbox',
      'reconcile/v1/follow-key',
    ]);
  });

  it.each(file.derivations.map((vector) => [vector.name, vector] as const))(
    'pins the follow mailbox id and key of %s',
    (_name, vector) => {
      const channel = followChannelOf(Uint8Array.from(vector.seed));
      expect(channel.mailbox).toBe(base64url(Uint8Array.from(vector.followMailboxId)));
      expect(Array.from(channel.key)).toEqual(vector.followKey);
    },
  );
});

describe('a follow seed', () => {
  it('is 32 fresh bytes each time', () => {
    const first = newFollowSeed();
    expect(first).toHaveLength(FOLLOW_SEED_BYTES);
    expect(FOLLOW_SEED_BYTES).toBe(32);
    expect(base64url(first)).not.toBe(base64url(newFollowSeed()));
  });

  it('names no invite, card, group or entry, and its id and key differ', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const { mailbox, key } = followChannelOf(seed);
        const card = cardChannelOf(seed);
        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        for (const other of [
          deriveInviteMailboxId(seed),
          card.mailbox,
          deriveWeekMailboxId(seed, 0),
          deriveCoalitionEntryId(seed),
        ]) {
          expect(mailbox).not.toBe(other);
        }
        for (const other of [deriveInviteKey(seed), card.key, deriveSealKey(seed)]) {
          expect(base64url(key)).not.toBe(base64url(other));
        }
        expect(base64url(key)).not.toBe(mailbox);
      }),
    );
  });

  it.each([0, 31, 33])('refuses a seed of %i bytes', (length) => {
    expect(() => followChannelOf(new Uint8Array(length))).toThrow(RangeError);
  });
});
