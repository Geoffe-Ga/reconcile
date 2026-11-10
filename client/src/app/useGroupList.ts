/** The groups on this device, as Start lists them. */
import { useEffect, useState } from 'react';

import { fold } from '../engine/fold';
import type { Group, Store } from '../store/db';
import type { StartGroup } from '../screens/Start';

/**
 * A group's name and Document title, folded from relay records (null until
 * its genesis is back), and whether its leave waits for the relay.
 */
function summarize(group: Group): StartGroup {
  const state = fold(group.log, group.relayNow);
  const leaving = group.leaving !== undefined;
  return state.group === null
    ? { groupId: group.groupId, name: null, title: null, leaving }
    : { groupId: group.groupId, name: state.name, title: state.title, leaving };
}

/** Every group on the device, kept current as the store changes, or null until it answers. */
export function useGroupList(
  store: Pick<Store, 'listGroups' | 'subscribe'>,
): readonly StartGroup[] | null {
  const [groups, setGroups] = useState<readonly StartGroup[] | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.listGroups().then(
        (list) => {
          // Only the newest read counts: an older one may answer last.
          if (live && ticket === latest) setGroups(list.map(summarize));
        },
        // A failed read keeps the last list shown; the next change reads again.
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store]);
  return groups;
}
