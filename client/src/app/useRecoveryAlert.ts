/**
 * The recovery alert as Start and group home show it (#118): every alert
 * this device opens, read again after every store change, and filtered by
 * the clock so it goes once its hold ends, with the way to cancel them all.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AlertSummary,
  alertSummary,
  cancelRecovery,
  type CancelServices,
  openedAlerts,
  type SeenAlert,
  stillRunning,
} from '../recovery/alert';
import type { Group, Store } from '../store/db';
import { relayMinuteNow } from './time';
import { useNow } from './useNow';

/** What a screen shows: the summary, and Cancel this recovery for every alert still to cancel. */
export interface RecoveryAlertView {
  readonly summary: AlertSummary;
  readonly cancel: () => Promise<void>;
}

/** The services the alert reads and cancels with. */
export type RecoveryAlertServices = CancelServices & {
  readonly store: Pick<Store, 'listGroups' | 'subscribe'>;
};

/** Every alert this device opens and each group's sync clock, after every store change; null until read. */
function useOpened(store: RecoveryAlertServices['store']) {
  const [opened, setOpened] = useState<{
    readonly alerts: readonly SeenAlert[];
    readonly groups: ReadonlyMap<string, Group>;
  } | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.listGroups().then(
        (groups) => {
          // Only the newest read counts: an older one may answer last.
          if (!live || ticket !== latest) return;
          const byId = new Map(groups.map((group) => [group.groupId, group]));
          setOpened({ alerts: openedAlerts(groups), groups: byId });
        },
        // A failed read keeps the last alert shown; the next change reads again.
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
  return opened;
}

/** The recovery alert for this device now, and Cancel this recovery. */
export function useRecoveryAlert(services: RecoveryAlertServices): RecoveryAlertView {
  const opened = useOpened(services.store);
  const deviceNow = useNow(services.now);
  const running = useMemo(() => {
    if (opened === null) return [];
    return stillRunning(opened.alerts, (groupId) => {
      const group = opened.groups.get(groupId);
      return group === undefined ? Infinity : relayMinuteNow(group, deviceNow);
    });
  }, [opened, deviceNow]);
  const cancel = useCallback(() => cancelRecovery(services, running), [services, running]);
  return { summary: alertSummary(running), cancel };
}
