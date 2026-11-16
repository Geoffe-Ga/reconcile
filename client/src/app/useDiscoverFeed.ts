/**
 * Discover's feed on the store (#429): built on the device from the groups
 * and coalition entries the store already holds, and kept current as the
 * store changes.
 *
 * It reads the store and nothing else: no relay request is made for the
 * feed, so the relay learns nothing new about which groups and coalitions
 * share a device (ADR-0001, the threat model's compartmentalization).
 */
import { useMemo } from 'react';

import type { Store } from '../store/db';
import {
  coalitionPlace,
  discoverFeed,
  type FeedItem,
  type FeedPlace,
  groupPlace,
} from './discoverFeed';
import { useCoalitionList } from './useGroup';
import { useGroups } from './useGroupList';

/** The feed's store: its groups and coalition entries, and word when they change. */
export type FeedStore = Pick<Store, 'listGroups' | 'listCoalitions' | 'subscribe'>;

/** Keeps the places a list names, leaving out the nulls. */
function placed(places: readonly (FeedPlace | null)[]): FeedPlace[] {
  return places.filter((place) => place !== null);
}

/**
 * Every Dispatch the device holds, newest first (`discoverFeed`), read again
 * after each store change; null until the store has answered for both
 * groups and coalitions.
 */
export function useDiscoverFeed(store: FeedStore): readonly FeedItem[] | null {
  const groups = useGroups(store, groupPlace);
  const coalitions = useCoalitionList(store);
  return useMemo(() => {
    if (groups === null || coalitions === null) return null;
    return discoverFeed(placed(groups), placed(coalitions.map(coalitionPlace)));
  }, [groups, coalitions]);
}
