/**
 * Reconcile cards at a front door (#426; ADR-0077 §5, ADR-0074, ADR-0040).
 *
 * A group with an open front door also receives reconcile cards there. A
 * person in another group makes a card as Reconcile with another group does
 * (`app/reconcile.ts`): their group's reconcile Proposal is queued and the
 * card's envelope posted to its own mailbox for a day. Then
 * {@link leaveCard} puts the card's seed, and nothing else, in the door's
 * inbox, `{card}` as UTF-8 JSON sealed to the page's `box` key under a label
 * of its own (`DOOR_CARD_INFO`) and padded to a blob size, kept a day too.
 * So the door's members, and nobody else, can open the card; the relay
 * learns of one more padded blob in the inbox.
 *
 * An application reader opens only boxes under the application label, so an
 * older app never opens a card, and a card reader never opens an
 * application ({@link cardsIn}). A card names no person beyond the name the
 * sender chose for the coalition and their group's name in it.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import {
  applicationIdOf,
  DOOR_CARD_INFO,
  doorChannelsOf,
  openPadded,
  sealPadded,
} from '../crypto/door';
import { CARD_TTL_DAYS } from '../coalition/card';
import type { Relay, RelayPage } from '../net/relay';
import type { ReceivedCard } from '../store/applications';
import { keyIn, type OpenPage } from './page';

/** How long the relay keeps a card at a door: as long as the card itself, a day. */
export const DOOR_CARD_TTL_DAYS = CARD_TTL_DAYS;

/** Minutes in a UTC day, the unit of the relay's retention. */
const DAY_MINUTES = 1440;

/** What leaving a card reaches. */
export interface LeaveCardServices {
  readonly relay: Pick<Relay, 'putBlob'>;
}

/** A card's seed as the inbox entry carries it: `{card}`, the seed in unpadded base64url. */
export function encodeDoorCard(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify({ card: base64url(seed) })));
}

/** The 32-byte seed `bytes` spell, or null for anything but exactly `{card}` with one. */
export function parseDoorCard(bytes: Uint8Array): Uint8Array | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const json = value as Record<string, unknown>;
    if (Object.keys(json).join() !== 'card' || typeof json.card !== 'string') return null;
    return keyIn(json.card);
  } catch {
    return null;
  }
}

/**
 * Puts the card `seed` names in the inbox of the door at `address`: sealed to
 * `page`'s box key, padded, for {@link DOOR_CARD_TTL_DAYS} day.
 *
 * @throws {Error} when the relay can't be reached.
 */
export async function leaveCard(
  services: LeaveCardServices,
  address: Uint8Array,
  page: OpenPage,
  seed: Uint8Array,
): Promise<void> {
  const { inbox } = doorChannelsOf(address);
  const blob = sealPadded(fromBase64url(page.box), encodeDoorCard(seed), DOOR_CARD_INFO, inbox);
  await services.relay.putBlob(inbox, blob, DOOR_CARD_TTL_DAYS);
}

/** The cards among `page`'s records that open under the door's box secret and parse. */
export function cardsIn(page: RelayPage, inbox: string, boxSecret: Uint8Array): ReceivedCard[] {
  return page.records.flatMap(({ seq, received, data }) => {
    const plaintext = openPadded(boxSecret, data, DOOR_CARD_INFO, inbox);
    const seed = plaintext === null ? null : parseDoorCard(plaintext);
    return seed === null
      ? []
      : [{ id: applicationIdOf(data), seq, received, seed: base64url(seed) }];
  });
}

/**
 * The relay minute by which a card whose entry arrived at `received` is
 * surely gone: the start of the second UTC day after it, since the relay
 * keeps a day's blob until then, and the card went up no later than its
 * entry. It may go a day sooner, which only opening it can tell.
 */
export function cardGoneAt(received: number): number {
  return (Math.floor(received / DAY_MINUTES) + 2) * DAY_MINUTES;
}
