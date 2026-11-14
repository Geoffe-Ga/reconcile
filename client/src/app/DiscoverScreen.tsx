/**
 * Discover on the app's services (#423, #429): its feed, kept current as the
 * store changes (`useDiscoverFeed`, which reads the store and never the
 * relay). A card or link opens from the link bar (#444), on every screen.
 */
import { Discover } from '../screens/Discover';
import { type FeedStore, useDiscoverFeed } from './useDiscoverFeed';

/** Props for {@link DiscoverScreen}. */
export interface DiscoverScreenProps {
  readonly store: FeedStore;
}

/** Discover, once the store has answered, so the empty state never flashes before the feed. */
export function DiscoverScreen({ store }: DiscoverScreenProps) {
  const feed = useDiscoverFeed(store);
  return feed === null ? null : <Discover feed={feed} />;
}
