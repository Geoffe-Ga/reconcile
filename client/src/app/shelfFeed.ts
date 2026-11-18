/**
 * The public shelf as Discover reads it (#484; docs/spec/listed-doors.md
 * §5.2): the whole shelf from the relay, folded (`shelf/fold.ts`).
 *
 * A read takes every record, so every device asks for exactly the same thing
 * (ADR-0077 §4), and a fresh one is made at most once an hour (proposed in
 * §5.2): opening Discover again inside the hour shows the last read without
 * asking the relay, so how often a person looks isn't told to it. A read
 * that fails is kept for no one, and the next look asks again. While the
 * relay has no shelf (no steward key), the feed is null.
 */
import type { Shelf } from '../net/shelf';
import { foldShelf, type ShelfState } from '../shelf/fold';

/** How long one read of the shelf serves: an hour, in device milliseconds. */
export const SHELF_READ_MS = 60 * 60 * 1000;

/** The shelf Discover shows. */
export interface ShelfFeed {
  /** The shelf as folded, or null while the relay has none; rejects when it can't be read. */
  current(): Promise<ShelfState | null>;
}

/** What the feed needs: the shelf client and the device clock in milliseconds. */
export interface ShelfFeedOptions {
  readonly shelf: Pick<Shelf, 'read'>;
  readonly now: () => number;
}

/** A feed that reads `shelf` at most once each {@link SHELF_READ_MS}. */
export function createShelfFeed({ shelf, now }: ShelfFeedOptions): ShelfFeed {
  let last: { readonly at: number; readonly state: Promise<ShelfState | null> } | null = null;

  function current(): Promise<ShelfState | null> {
    const at = now();
    if (last !== null && at - last.at < SHELF_READ_MS) return last.state;
    const state = shelf.read().then((page) => page && foldShelf(page.records, page.now));
    const kept = { at, state };
    last = kept;
    state.catch(() => {
      if (last === kept) last = null;
    });
    return state;
  }

  return { current };
}
