/**
 * A reconcile card's seed, what derives from it, and a coalition's local
 * entry id (spec §4 Coalitions; #114).
 *
 * Reconcile with another group makes 32 random bytes, the card's seed, which
 * travels only after `#` in the card link. The card mailbox id and the key
 * its envelope is sealed under derive from the seed through the same HKDF as
 * a group secret's (`hkdf.ts`), under labels of their own, so a seed names no
 * group, invite or coalition mailbox and opens no blob of theirs. The relay
 * sees the card mailbox id and nothing else.
 *
 * A device keeps each coalition it holds a secret of as one entry in its
 * store, beside its groups, under an id derived from the coalition secret
 * under a label of its own: every device and tab finds the same entry for one
 * coalition before its genesis exists, and the id names no mailbox. It never
 * leaves the device but in a backup file. `vectors/card.json` pins every
 * derivation here, computed outside @noble.
 */
import { randomBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { hkdf32 } from './hkdf';
import type { InviteChannel } from './invite';

/** A card seed's length in bytes. */
export const CARD_SEED_BYTES = 32;

/** The HKDF label of a card's mailbox id. */
export const CARD_MAILBOX_INFO = 'reconcile/v1/card-mailbox';

/** The HKDF label of the key a card's envelope is sealed under. */
export const CARD_KEY_INFO = 'reconcile/v1/card-key';

/** The HKDF label of a coalition's entry id on a device. */
export const COALITION_ENTRY_INFO = 'reconcile/v1/coalition-entry';

/** A new card seed: 32 bytes from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newCardSeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(CARD_SEED_BYTES));
}

/**
 * The card mailbox id and the key its envelope is sealed under, both derived
 * from `seed`.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function cardChannelOf(seed: Uint8Array): InviteChannel {
  if (seed.length !== CARD_SEED_BYTES) throw new RangeError('A card seed is 32 bytes.');
  return {
    mailbox: base64url(hkdf32(seed, CARD_MAILBOX_INFO)),
    key: hkdf32(seed, CARD_KEY_INFO),
  };
}

/**
 * The id a device keeps the coalition whose secret is `secret` under: 43
 * unpadded base64url characters.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes.
 */
export function deriveCoalitionEntryId(secret: Uint8Array): string {
  if (secret.length !== GROUP_SECRET_BYTES) throw new RangeError('A group secret is 32 bytes.');
  return base64url(hkdf32(secret, COALITION_ENTRY_INFO));
}
