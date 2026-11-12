/** Recovery contacts as Settings and the picker show them (#109), kept current as the store changes. */
import { useEffect, useState } from 'react';

import type { Store } from '../store/db';
import {
  contactGroups,
  type ContactGroup,
  type HeldShare,
  heldShares,
  recoveryStatus,
  type RecoveryStatus,
} from '../store/recovery';

/** Where the person's contacts stand, the shares this device holds, and whom the picker offers. */
export interface RecoveryView {
  readonly status: RecoveryStatus | null;
  readonly held: readonly HeldShare[];
  readonly groups: readonly ContactGroup[];
}

/**
 * The device's recovery contacts, held shares and the picker's groups, read
 * again after every store change, or null until the store answers.
 */
export function useRecovery(
  store: Pick<Store, 'listGroups' | 'getRecoveryPlan' | 'subscribe'>,
): RecoveryView | null {
  const [view, setView] = useState<RecoveryView | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      Promise.all([store.listGroups(), store.getRecoveryPlan()]).then(
        ([groups, plan]) => {
          // Only the newest read counts: an older one may answer last.
          if (!live || ticket !== latest) return;
          setView({
            status: recoveryStatus(plan, groups),
            held: heldShares(groups),
            groups: contactGroups(groups),
          });
        },
        // A failed read keeps the last view shown; the next change reads again.
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
  return view;
}
