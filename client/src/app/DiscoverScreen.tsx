/**
 * Discover on the app's services (#423, #429, #484, #431): its feed, kept
 * current as the store changes (`useDiscoverFeed`, which reads the store and
 * never the relay), and the public shelf, read through the shelf's reader,
 * which asks the relay at most once an hour (`shelf/read.ts`). The entries of
 * the doors this device's groups list show at once (`useOwnListings`). A
 * card or link opens from the link bar (#444), on every screen.
 *
 * A shelf entry's own page (`#/discover/{address}/{id}`, #431) reads the
 * same shelf, the same way, so its link opens on any device past the pilot
 * notice, one in no group included. Its Ask to join and Propose reconciling
 * open the listing's front door (#432).
 */
import { Discover } from '../screens/Discover';
import { ShelfEntry } from '../screens/ShelfEntry';
import type { ShelfReader } from '../shelf/read';
import { routeHref } from './router';
import type { SharePort } from './share';
import { type FeedStore, useDiscoverFeed } from './useDiscoverFeed';
import { useOwnListings } from './useOwnListings';
import { usePublicShelf, useShelfState } from './usePublicShelf';

/** Props for {@link DiscoverScreen}. */
export interface DiscoverScreenProps {
  readonly store: FeedStore;
  /** The public shelf; without one, none shows (#484). */
  readonly shelf?: ShelfReader | undefined;
}

/** Discover, once the store has answered, so the empty state never flashes before the feed. */
export function DiscoverScreen({ store, shelf }: DiscoverScreenProps) {
  const feed = useDiscoverFeed(store);
  const shelved = usePublicShelf(shelf, useOwnListings(store));
  return feed === null ? null : <Discover feed={feed} shelf={shelved} />;
}

/** Props for {@link ShelfEntryScreen}. */
export interface ShelfEntryScreenProps extends DiscoverScreenProps {
  readonly address: string;
  readonly id: string;
  /** The app's origin, for the entry's link. */
  readonly origin: string;
  readonly copyText: (text: string) => Promise<void>;
  readonly sharing?: SharePort | undefined;
  /** Whether this device has a group that may propose reconciling with the entry's group (#426, #432). */
  readonly mayReconcile: boolean;
}

/** One entry's page, once the shelf has answered, so "not on the shelf" never flashes first. */
export function ShelfEntryScreen(props: ShelfEntryScreenProps) {
  const { store, shelf, address, id, origin, copyText, sharing, mayReconcile } = props;
  const state = useShelfState(shelf, useOwnListings(store));
  if (state === undefined) return null;
  // While the steward's pause stands, no entry shows, here as on Discover (#489).
  const shown = state === null || state.paused ? [] : state.entries;
  const entry = shown.find((e) => e.address === address && e.id === id) ?? null;
  const link = `${origin}/${routeHref({ name: 'shelfEntry', address, id })}`;
  return (
    <ShelfEntry
      entry={entry}
      link={link}
      copyText={copyText}
      sharing={sharing}
      mayReconcile={mayReconcile}
    />
  );
}
