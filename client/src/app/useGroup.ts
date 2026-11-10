/**
 * `useGroup`: one group as the UI sees it (spec §7, "Folded state uses relay
 * records only").
 *
 * The state is `fold` over the relay records in the store's log, so it is the
 * same on every device that has synced the same records. Events still in the
 * outbox are listed as pending and never folded: the relay hasn't ordered or
 * timed them yet. A dissolved group whose ballots this device has cleared
 * shows the state it kept instead (#108).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { parseRecord } from '../engine/event';
import type { ParsedEvent } from '../engine/event';
import type { GroupState, LogRecord } from '../engine/fold';
import { shownState } from '../store/archive';
import type { ClearedArchive, Group, Me, Store } from '../store/db';

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
  /** The relay records `state` was folded from, in relay order, or none likewise. */
  log: readonly LogRecord[];
  /** This device's events the relay hasn't accepted yet, oldest first. They are never in `state`. */
  pending: ParsedEvent[];
  /** When the last sync succeeded, in device milliseconds, or `null` before one. */
  lastSyncAt: number | null;
  /** The relay's minute at that sync (its `now`), or `null` before one. */
  relayNow: number | null;
  /** Whether the last sync pass reached the relay. */
  reachable: boolean;
  /** Who this device is in the group, or `null` while loading or when the device isn't in it. */
  me: Me | null;
  /**
   * Whether a sync came more than 28 days after the one before, so some
   * history may be missing, until an invite's merge clears it (#73).
   */
  missingHistory: boolean;
  /**
   * Whether this device has queued its leave (#77): the group waits, read
   * only, until the relay has the leave and the sync loop deletes it.
   */
  leaving: boolean;
  /**
   * Whether group home suggests a backup (#78): the group is on the device,
   * no backup file it saved or restored from holds it, nobody answered Not
   * now, and it isn't a read-only archive, which no backup carries (#108).
   */
  suggestBackup: boolean;
  /** Whether the store has answered for this group; with `me` still null, the device isn't in it. */
  loaded: boolean;
  /** Once this device has cleared a dissolved group's ballots (#108): when, and the tallies it kept. */
  cleared: Pick<ClearedArchive, 'at' | 'tallies'> | null;
}

/** The log of a group that isn't loaded: one shared empty list, so it never looks changed. */
const NO_RECORDS: readonly LogRecord[] = [];

/** The group `groupId`, kept current as sync and the user change it. */
export function useGroup(groupId: string): GroupView {
  const { store, sync } = useServices();
  const { group, loaded } = useStoredGroup(store, groupId);
  const reachable = useSyncExternalStore(sync.subscribe, sync.isReachable);
  const state = useMemo(() => (group === undefined ? null : shownState(group)), [group]);
  const pending = useMemo(() => (group === undefined ? [] : parsePending(group.outbox)), [group]);
  return {
    state,
    log: group?.log ?? NO_RECORDS,
    pending,
    ...syncStatusOf(group),
    reachable,
    me: group?.me ?? null,
    loaded,
    cleared: clearedOf(group),
  };
}

/** A dissolved group's cleared archive (#108), or null for any other group, or none yet. */
function clearedOf(group: Group | undefined): GroupView['cleared'] {
  return group?.archived?.cleared ?? null;
}

/** What a stored group says of its syncs, its leave and its backup, or nothing yet before it loads. */
function syncStatusOf(
  group: Group | undefined,
): Pick<GroupView, 'lastSyncAt' | 'relayNow' | 'missingHistory' | 'leaving' | 'suggestBackup'> {
  return {
    lastSyncAt: group?.lastSyncAt ?? null,
    relayNow: group?.relayNow ?? null,
    missingHistory: group?.missingHistory === true,
    leaving: group?.leaving !== undefined,
    suggestBackup:
      group !== undefined && group.backup === undefined && group.archived === undefined,
  };
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

/** The stored group, read again whenever the store says it changed, and whether it has been read. */
function useStoredGroup(
  store: GroupServices['store'],
  groupId: string,
): { group: Group | undefined; loaded: boolean } {
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
  return loaded?.groupId === groupId
    ? { group: loaded.group, loaded: true }
    : { group: undefined, loaded: false };
}

/** The events the outbox's signed records carry, skipping any record that doesn't verify. */
function parsePending(outbox: readonly Uint8Array[]): ParsedEvent[] {
  return outbox.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}
