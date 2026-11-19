/**
 * The steward's key and console as screens read them (#488;
 * docs/spec/listed-doors.md §6.2, §6.4).
 */
import { useEffect, useState } from 'react';

import type { Shelf } from '../net/shelf';
import type { ShelfFlags, StewardQueue } from '../screens/Steward';
import type { InboxItem } from '../shelf/inbox';
import { STEWARD_PINS } from '../shelf/steward';
import { STEWARD_CHANGED, type Store } from '../store/db';
import { useShelfRead } from './usePublicShelf';
import type { ShelfReader } from '../shelf/read';
import { readFlags, readQueue } from './steward';

/**
 * Whether this device holds the steward's key, kept current as it comes and
 * goes, or null until the store answers. A store that can't answer reads as
 * holding none.
 */
export function useHoldsStewardKey(
  store: Pick<Store, 'holdsStewardKey' | 'subscribe'>,
): boolean | null {
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      store.holdsStewardKey().then(
        (answer) => {
          if (live) setHeld(answer);
        },
        () => {
          if (live) setHeld(false);
        },
      );
    };
    load();
    const unsubscribe = store.subscribe((changed) => {
      if (changed === STEWARD_CHANGED) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store]);
  return held;
}

/**
 * Whether Settings shows its quiet steward key section: on a device that
 * holds the key, so it can reach the console; else only while the app pins
 * a steward key and the relay has a shelf, so with neither nothing shows.
 * Undefined until both answer.
 */
export function useOffersStewardKey(
  held: boolean | null,
  shelf: ShelfReader | undefined,
): boolean | undefined {
  const read = useShelfRead(STEWARD_PINS === null ? undefined : shelf);
  if (held === null) return undefined;
  if (held) return true;
  if (STEWARD_PINS === null || read === null) return false;
  return read === undefined ? undefined : true;
}

/**
 * The console's queue once read, with the reports and appeals `inbox` reads
 * (#490), null until then; `reload` reads it again. `inbox` should keep its
 * identity across renders, or the queue is read again each time.
 */
export function useStewardQueue(
  shelf: Pick<Shelf, 'read' | 'readHeld'> | undefined,
  inbox?: () => Promise<readonly InboxItem[]>,
): {
  readonly queue: StewardQueue | null;
  readonly reload: () => void;
} {
  const [queue, setQueue] = useState<StewardQueue | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    const reading =
      shelf === undefined ? Promise.resolve('unavailable' as const) : readQueue(shelf, inbox);
    void reading.then((answer) => {
      if (live) setQueue(answer);
    });
    return () => {
      live = false;
    };
  }, [shelf, inbox, round]);
  return {
    queue,
    reload: () => {
      setRound((n) => n + 1);
    },
  };
}

/**
 * What the shelf classifier flags in `queue` once it is read (#493): `off`
 * until then, and for good while the classifier is switched off. The queue
 * shows first; flags follow once the model has read every entry, and change
 * nothing in it.
 */
export function useShelfFlags(
  queue: StewardQueue | null,
  read: (queue: StewardQueue) => Promise<ShelfFlags> = readFlags,
): ShelfFlags {
  const [flags, setFlags] = useState<ShelfFlags>('off');
  useEffect(() => {
    if (queue === null) return;
    let live = true;
    void read(queue).then((answer) => {
      if (live) setFlags(answer);
    });
    return () => {
      live = false;
    };
  }, [queue, read]);
  return flags;
}
