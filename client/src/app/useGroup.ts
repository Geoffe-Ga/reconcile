/**
 * `useGroup`: one group as the UI sees it (spec §7, "Folded state uses relay
 * records only").
 *
 * The state is `fold` over the relay records in the store's log, so it is the
 * same on every device that has synced the same records. Events still in the
 * outbox are listed as pending and never folded: the relay hasn't ordered or
 * timed them yet.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { parseEvent } from '../engine/event';
import type { ParsedEvent } from '../engine/event';
import { fold } from '../engine/fold';
import type { GroupState } from '../engine/fold';
import type { Group, Store } from '../store/db';

/** What `useGroup` reads: the device's store and the sync loop's reachability. */
export interface GroupServices {
  /** The store (`openStore`), or anything that reads and announces groups like it. */
  readonly store: {
    readonly getGroup: Store['getGroup'];
    readonly subscribe: Store['subscribe'];
  };
  /** The sync loop (`createSync`), or anything that reports reachability like it. */
  readonly sync: {
    readonly isReachable: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
  };
}

/** Provides the store and sync loop to `useGroup`; the app sets it once, at its root. */
export const GroupServicesContext = createContext<GroupServices | null>(null);

/** One group, for the screens. */
export interface GroupView {
  /** The group folded from relay records, or `null` while loading or when the device isn't in it. */
  state: GroupState | null;
  /** This device's events the relay hasn't accepted yet, oldest first. They are never in `state`. */
  pending: ParsedEvent[];
  /** When the last sync succeeded, in device milliseconds, or `null` before one. */
  lastSyncAt: number | null;
  /** Whether the last sync pass reached the relay. */
  reachable: boolean;
}

/** The group `groupId`, kept current as sync and the user change it. */
export function useGroup(groupId: string): GroupView {
  const { store, sync } = useServices();
  const group = useStoredGroup(store, groupId);
  const reachable = useSyncExternalStore(sync.subscribe, sync.isReachable);
  const state = useMemo(
    () => (group === undefined ? null : fold(group.log, group.relayNow)),
    [group],
  );
  const pending = useMemo(() => (group === undefined ? [] : parsePending(group.outbox)), [group]);
  return { state, pending, lastSyncAt: group?.lastSyncAt ?? null, reachable };
}

function useServices(): GroupServices {
  const services = useContext(GroupServicesContext);
  if (services === null) {
    throw new Error('useGroup needs a GroupServicesContext provider.');
  }
  return services;
}

/** A group read, labelled with the id it was read for. */
interface Loaded {
  readonly groupId: string;
  readonly group: Group | undefined;
}

/** The stored group, read again whenever the store says it changed. */
function useStoredGroup(store: GroupServices['store'], groupId: string): Group | undefined {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.getGroup(groupId).then(
        (group) => {
          if (live && ticket === latest) {
            setLoaded({ groupId, group });
          }
        },
        // A failed read keeps the last state shown; the next change reads again.
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe((changed) => {
      if (changed === groupId) {
        load();
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store, groupId]);
  return loaded?.groupId === groupId ? loaded.group : undefined;
}

/** The outbox's events, skipping any bytes that aren't one. */
function parsePending(outbox: readonly Uint8Array[]): ParsedEvent[] {
  return outbox.flatMap((bytes) => {
    const parsed = parseEvent(bytes);
    return parsed === null ? [] : [parsed];
  });
}
