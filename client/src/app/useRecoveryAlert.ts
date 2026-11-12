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
import { type Group, RECOVERY_CHANGED, RELAY_BACKUP_CHANGED, type Store } from '../store/db';
import { relayMinuteNow } from './time';
import { useNow } from './useNow';

/** What a screen shows: the summary, and Cancel this recovery for every alert still to cancel. */
export interface RecoveryAlertView {
  readonly summary: AlertSummary;
  readonly cancel: () => Promise<void>;
}

/** The services the alert reads and cancels with. */
export type RecoveryAlertServices = CancelServices & {
  readonly store: Pick<Store, 'listGroups' | 'getGroup' | 'subscribe'>;
};

/** What the hook has read: each group on the device by id, and the alerts they hold. */
interface Opened {
  readonly alerts: readonly SeenAlert[];
  readonly groups: ReadonlyMap<string, Group>;
}

/** What a screen shows of `alerts`, as one string: each one's place, end and whether it's cancelled. */
function signature(alerts: readonly SeenAlert[]): string {
  return alerts
    .map((a) => `${a.groupId} ${a.id} ${String(a.completes)} ${String(a.cancelled)}`)
    .join('|');
}

/** `groups` with their alerts, which `openedAlerts` reads again only for a group that changed. */
function openedIn(groups: ReadonlyMap<string, Group>): Opened {
  return { alerts: openedAlerts([...groups.values()]), groups };
}

/**
 * Every alert this device opens and each group's sync clock; null until read.
 * It reads every group once, then after each change only the group that
 * changed, so a sync pass costs one read, not one per group.
 */
function useOpened(store: RecoveryAlertServices['store']) {
  const [opened, setOpened] = useState<Opened | null>(null);
  useEffect(() => {
    let live = true;
    let held: Map<string, Group> | null = null;
    let shown: string | null = null;
    // Changes heard before the first read are folded into it: they read the whole store.
    const pending = new Set<string>();
    // Each sync pass changes the store, most with no alert in it, so the screen renders
    // again only when the alerts do. The sync clocks it keeps may be older: the relay's
    // minute is estimated from a sync's own `relayNow` plus the device time since it.
    const keep = (groups: Map<string, Group>): void => {
      held = groups;
      const next = openedIn(groups);
      const seen = signature(next.alerts);
      if (!live || seen === shown) return;
      shown = seen;
      setOpened(next);
    };
    // The newest read of each group, so an older one that answers last is dropped.
    const tickets = new Map<string, number>();
    const reread = (groupId: string): void => {
      const ticket = (tickets.get(groupId) ?? 0) + 1;
      tickets.set(groupId, ticket);
      store.getGroup(groupId).then(
        (group) => {
          if (held === null || tickets.get(groupId) !== ticket) return;
          const next = new Map(held);
          if (group === undefined) next.delete(groupId);
          else next.set(groupId, group);
          keep(next);
        },
        // A failed read keeps the last alert shown; the next change reads again.
        () => undefined,
      );
    };
    store.listGroups().then(
      (groups) => {
        keep(new Map(groups.map((group) => [group.groupId, group])));
        for (const groupId of pending) reread(groupId);
      },
      () => undefined,
    );
    const unsubscribe = store.subscribe((changed) => {
      // The relay backup's and the recovery plan's changes name no group.
      if (changed === RELAY_BACKUP_CHANGED || changed === RECOVERY_CHANGED) return;
      if (held === null) pending.add(changed);
      else reread(changed);
    });
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
