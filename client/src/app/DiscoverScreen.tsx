/**
 * Discover on the app's services (#423, #429): its feed, kept current as the
 * store changes (`useDiscoverFeed`, which reads the store and never the
 * relay), and the handlers its field opens links with.
 */
import { Discover, type DiscoverProps } from '../screens/Discover';
import { type FeedStore, useDiscoverFeed } from './useDiscoverFeed';

/** Props for {@link DiscoverScreen}: the store, and what opens each kind of link. */
export interface DiscoverScreenProps extends Omit<DiscoverProps, 'feed'> {
  readonly store: FeedStore;
}

/** Discover, once the store has answered, so the empty state never flashes before the feed. */
export function DiscoverScreen({ store, ...open }: DiscoverScreenProps) {
  const feed = useDiscoverFeed(store);
  return feed === null ? null : <Discover feed={feed} {...open} />;
}
