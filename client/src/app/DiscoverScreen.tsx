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
 * open the listing's front door (#432), and its Report this entry goes to
 * the steward (#490).
 *
 * Above Discover's feed, a device that sent an application or a reconcile
 * card to a door the steward removed reads one line saying so, matched on
 * the device from the same read of the shelf (#491, `ShelfRemovals`).
 */
import { Discover } from '../screens/Discover';
import type { ShelfEntryProps } from '../screens/ShelfEntry';
import { ShelfEntry } from '../screens/ShelfEntry';
import type { ShelfReader } from '../shelf/read';
import { routeHref } from './router';
import type { SharePort } from './share';
import { type RemovalsStore, ShelfRemovals } from './ShelfRemovals';
import { type FeedStore, useDiscoverFeed } from './useDiscoverFeed';
import { useOwnListings } from './useOwnListings';
import { usePublicShelf, useShelfState } from './usePublicShelf';

/** What Discover and an entry's page read: the store's places, and the public shelf. */
interface ShelfScreenProps {
  readonly store: FeedStore;
  /** The public shelf; without one, none shows (#484). */
  readonly shelf?: ShelfReader | undefined;
}

/** Props for {@link DiscoverScreen}. */
export interface DiscoverScreenProps extends ShelfScreenProps {
  readonly store: FeedStore & RemovalsStore;
  /** The device clock in milliseconds, for the removal lines (#491). */
  readonly now: () => number;
}

/** Discover, once the store has answered, so the empty state never flashes before the feed. */
export function DiscoverScreen({ store, shelf, now }: DiscoverScreenProps) {
  const feed = useDiscoverFeed(store);
  const shelved = usePublicShelf(shelf, useOwnListings(store));
  const removals = <ShelfRemovals store={store} shelf={shelf} now={now} />;
  return feed === null ? null : <Discover feed={feed} shelf={shelved} removals={removals} />;
}

/** Props for {@link ShelfEntryScreen}. */
export interface ShelfEntryScreenProps extends ShelfScreenProps {
  readonly address: string;
  readonly id: string;
  /** The app's origin, for the entry's link. */
  readonly origin: string;
  readonly copyText: (text: string) => Promise<void>;
  readonly sharing?: SharePort | undefined;
  /** Whether this device has a group that may propose reconciling with the entry's group (#426, #432). */
  readonly mayReconcile: boolean;
  /** Sends a report of the entry to the steward (#490); none where the app pins no steward. */
  readonly onReport?: ShelfEntryProps['onReport'];
}

/** One entry's page, once the shelf has answered, so "not on the shelf" never flashes first. */
export function ShelfEntryScreen(props: ShelfEntryScreenProps) {
  const { store, shelf, address, id, origin, copyText, sharing, mayReconcile, onReport } = props;
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
      onReport={onReport}
    />
  );
}
