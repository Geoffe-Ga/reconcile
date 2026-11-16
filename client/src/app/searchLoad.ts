/**
 * Loading what search reads (#445): this device's groups, coalitions and
 * personal Documents, read from its store and folded in memory each time
 * the link bar takes focus. It reads; it writes nothing and asks the relay
 * for nothing, and the records live only as long as the bar holds them.
 */
import { isArchive, type Store } from '../store/db';
import { shownState } from '../store/archive';
import type { PersonalStore } from '../store/personal';
import type { SearchRecord } from './search';
import { recordsOf } from './searchRecords';

/** The store reads search needs. */
export type SearchStore = Pick<Store, 'listGroups' | 'listCoalitions'> &
  Pick<PersonalStore, 'listPersonalEntries'>;

/** Every record search reads on this device, built afresh. */
export async function loadSearchRecords(store: SearchStore): Promise<SearchRecord[]> {
  const [groups, coalitions, personal] = await Promise.all([
    store.listGroups(),
    store.listCoalitions(),
    store.listPersonalEntries(),
  ]);
  return recordsOf({
    groups: groups.map((group) => ({
      groupId: group.groupId,
      state: shownState(group),
      archived: isArchive(group.archived),
    })),
    coalitions: coalitions.flatMap((entry) => {
      const state = shownState(entry);
      return state.group === null ? [] : [{ coalitionId: state.group, state }];
    }),
    personal,
  });
}
