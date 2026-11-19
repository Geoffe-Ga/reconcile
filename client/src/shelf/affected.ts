/**
 * Telling affected devices (#491; ADR-0081; docs/spec/listed-doors.md §6.5).
 *
 * After each shelf read, the device matches the fold's tombstones (#489:
 * a suspended listing's, or an upheld entry's) against what it already
 * holds: the front-door applications it sent (`store/applications.ts`, #121)
 * and the reconcile cards it left at a door (`app/doorCards.ts`, #426), by
 * the door's address. A match shows one line on Start and on Discover, with
 * Dismiss.
 *
 * The match is local and pure: it reaches no network, and nothing is sent,
 * so the platform never learns which devices matched. The tombstone is
 * public, the same for every device. The device keeps no record of which
 * entries its reader looked at; it matches only what it sent.
 *
 * What it keeps, in one record of its own store, in no group and in no
 * backup file or link ({@link KeptRemovals}): the doors it left a card at,
 * for {@link SENT_DAYS} days as an application is kept, and the lines its
 * reader dismissed, each by its tombstone ({@link removalKey}), so a
 * dismissed line stays dismissed across reloads and never shows twice for
 * one tombstone. A dismissal is forgotten only once nothing the device still
 * keeps was sent to its door and it is {@link DISMISSED_KEEP_DAYS} days old,
 * past the longest a tombstone stands (30 relay days).
 */
import { SENT_DAYS } from '../store/applications';
import type { ShelfTombstone } from './fold';
import type { Clause } from './record';

/** What this device sent to a door: an application, or a reconcile card. */
export type SentKind = 'application' | 'card';

/** One thing this device sent to a front door, by the door's address. */
export interface SentToDoor {
  /** The door's address, in unpadded base64url. */
  readonly door: string;
  /** When it was sent, in device milliseconds. */
  readonly sentAt: number;
  readonly kind: SentKind;
}

/** A thing this device sent to a door a tombstone names. */
export interface Affected extends SentToDoor {
  /** The covenant clause the tombstone names. */
  readonly clause: Clause;
  /** The entry it removed, or null for the door's whole listing. */
  readonly entry: string | null;
  /** The tombstone's key ({@link removalKey}): what Dismiss keeps. */
  readonly key: string;
}

/** A reconcile card this device left at a door (#426). */
export interface SentCard {
  readonly door: string;
  /** When it was left, in device milliseconds. */
  readonly sentAt: number;
}

/** A line the reader dismissed: its tombstone's key, the door, and when, in device milliseconds. */
export interface DismissedRemoval {
  readonly key: string;
  readonly door: string;
  readonly at: number;
}

/** What the device keeps for these lines: one record of its own store. */
export interface KeptRemovals {
  readonly cards: readonly SentCard[];
  readonly dismissed: readonly DismissedRemoval[];
}

/** Days a dismissal is kept at least: past a tombstone's 30 relay days, with room for a slow clock. */
export const DISMISSED_KEEP_DAYS = 60;

const DAY_MS = 86_400_000;

/** A tombstone's key: its listing's address, or that and its entry's id. */
export const removalKey = ({ address, id }: Pick<ShelfTombstone, 'address' | 'id'>): string =>
  id === null ? address : `${address} ${id}`;

/**
 * Each of `sent` whose door a tombstone names, with that tombstone's clause,
 * entry and key: tombstones in the order given, and for each, `sent` in its
 * order.
 */
export function affectedBy(
  tombstones: readonly ShelfTombstone[],
  sent: readonly SentToDoor[],
): Affected[] {
  return tombstones.flatMap((tombstone) =>
    sent
      .filter(({ door }) => door === tombstone.address)
      .map((one) => ({
        ...one,
        clause: tombstone.clause,
        entry: tombstone.id,
        key: removalKey(tombstone),
      })),
  );
}

/**
 * The lines to show: one a tombstone, for the earliest thing sent to its
 * door, leaving out each one `dismissed` names.
 */
export function removalLines(
  affected: readonly Affected[],
  dismissed: ReadonlySet<string>,
): Affected[] {
  const lines = new Map<string, Affected>();
  for (const one of affected) {
    if (dismissed.has(one.key)) continue;
    const held = lines.get(one.key);
    if (held === undefined || one.sentAt < held.sentAt) lines.set(one.key, one);
  }
  return [...lines.values()];
}

/** Whether something sent at `sentAt` is {@link SENT_DAYS} days old at `now`. */
const sentLapsed = (sentAt: number, now: number): boolean => now - sentAt >= SENT_DAYS * DAY_MS;

/** `kept` with `card` added, forgetting each card {@link SENT_DAYS} days older than it. */
export function withSentCard(kept: KeptRemovals, card: SentCard): KeptRemovals {
  const cards = kept.cards.filter(({ sentAt }) => !sentLapsed(sentAt, card.sentAt));
  return { ...kept, cards: [...cards, card] };
}

/** `kept` with `dismissal` added, unless one with its key is there already. */
export function withDismissed(kept: KeptRemovals, dismissal: DismissedRemoval): KeptRemovals {
  if (kept.dismissed.some(({ key }) => key === dismissal.key)) return kept;
  return { ...kept, dismissed: [...kept.dismissed, dismissal] };
}

/**
 * `kept` as of device time `now`: cards {@link SENT_DAYS} days old are
 * forgotten, and a dismissal once no card left and none of `applications`
 * names its door and it is {@link DISMISSED_KEEP_DAYS} days old.
 */
export function prunedRemovals(
  kept: KeptRemovals,
  applications: readonly SentToDoor[],
  now: number,
): KeptRemovals {
  const cards = kept.cards.filter(({ sentAt }) => !sentLapsed(sentAt, now));
  const doors = new Set([...cards, ...applications].map(({ door }) => door));
  const dismissed = kept.dismissed.filter(
    ({ door, at }) => doors.has(door) || now - at < DISMISSED_KEEP_DAYS * DAY_MS,
  );
  return { cards, dismissed };
}

/** What the device holds for these lines, as of a device time. */
export interface Removals {
  /** Every application and card it still keeps, by door, oldest first. */
  readonly sent: readonly SentToDoor[];
  /** The keys of the lines its reader dismissed. */
  readonly dismissed: readonly string[];
}

/** Where the device keeps them: its own store (`store/db.ts`). */
export interface RemovalKeep {
  /** What it holds at device time `now`, forgetting what {@link prunedRemovals} lets go first. */
  removalsAt(now: number): Promise<Removals>;
  /** Keeps a reconcile card left at a door (#426). */
  noteSentCard(card: SentCard): Promise<void>;
  /** Keeps a line dismissed, once by its key. */
  dismissRemoval(dismissal: DismissedRemoval): Promise<void>;
}
