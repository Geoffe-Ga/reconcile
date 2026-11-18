/**
 * Discover on the app's services (#423, #429, #484): its feed, kept current
 * as the store changes (`useDiscoverFeed`, which reads the store and never
 * the relay), and the public shelf, read once as the screen opens through
 * the shelf feed, which asks the relay at most once an hour (`shelfFeed.ts`).
 * A card or link opens from the link bar (#444), on every screen.
 */
import { useEffect, useState } from 'react';

import { Discover } from '../screens/Discover';
import type { ShelfState } from '../shelf/fold';
import type { ShelfFeed } from './shelfFeed';
import { type FeedStore, useDiscoverFeed } from './useDiscoverFeed';

/** Props for {@link DiscoverScreen}. */
export interface DiscoverScreenProps {
  readonly store: FeedStore;
  /** The public shelf; without one, none shows (#484). */
  readonly shelf?: ShelfFeed | undefined;
}

/**
 * The shelf as folded once `shelf` answers; null before then, without a
 * shelf, while the relay has none, and when it can't be read, so a shelf
 * that isn't there never shows an error on Discover.
 */
function usePublicShelf(shelf: ShelfFeed | undefined): ShelfState | null {
  const [state, setState] = useState<ShelfState | null>(null);
  useEffect(() => {
    if (shelf === undefined) return;
    let live = true;
    shelf.current().then(
      (folded) => {
        if (live) setState(folded);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [shelf]);
  return state;
}

/** Discover, once the store has answered, so the empty state never flashes before the feed. */
export function DiscoverScreen({ store, shelf }: DiscoverScreenProps) {
  const feed = useDiscoverFeed(store);
  const shelved = usePublicShelf(shelf);
  return feed === null ? null : <Discover feed={feed} shelf={shelved} />;
}
