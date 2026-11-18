/**
 * The public shelf as a screen reads it (#484, #487): Discover's section,
 * and the listing composer's warning, each through the shelf feed, which asks
 * the relay at most once an hour (`shelfFeed.ts`).
 */
import { useEffect, useState } from 'react';

import type { ShelfState } from '../shelf/fold';
import type { ShelfFeed } from './shelfFeed';

/**
 * The shelf as folded once `shelf` answers; null before then, without a
 * shelf, while the relay has none, and when it can't be read, so a shelf
 * that isn't there never shows an error on Discover.
 */
export function usePublicShelf(shelf: ShelfFeed | undefined): ShelfState | null {
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
