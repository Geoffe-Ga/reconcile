/**
 * The addresses of the listed doors of this device's groups (#431;
 * listed-doors.md §4.3 rule 6): their entries show on this device at once,
 * marked "Shows publicly tomorrow", while every other device waits a relay
 * day. Read from the store alone, as Discover's feed is: nothing about which
 * groups share this device reaches the relay.
 */
import { listedAddress } from '../shelf/keeper';
import type { Group } from '../store/db';
import { foldGroup } from '../store/expiry';
import { useGroups } from './useGroupList';
import type { FeedStore } from './useDiscoverFeed';

/** The address `group` lists its door under now, or null: none for a read-only copy (#108, #115, #231). */
export function ownListingOf(group: Group): string | null {
  return group.archived === undefined ? listedAddress(foldGroup(group)) : null;
}

/** Every address this device's groups list their doors under, kept current; none until the store answers. */
export function useOwnListings(store: Pick<FeedStore, 'listGroups' | 'subscribe'>): string[] {
  const addresses = useGroups(store, ownListingOf);
  return (addresses ?? []).filter((address) => address !== null);
}
