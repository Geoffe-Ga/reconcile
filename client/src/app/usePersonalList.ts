/** This device's personal Documents (#93), as Personal lists them, and the relay minute their shares are measured by (#347). */
import { useEffect, useState } from 'react';

import { heardRelay, type ShareServices } from '../share/shareLink';
import type { PersonalEntry, PersonalStore } from '../store/personal';

/**
 * Every personal Document on the device, oldest first, read once when
 * Personal opens, or null until the store answers. A failed read lists none,
 * so Personal still offers a new Document, at an id nothing holds. It reads
 * no key, so a device whose keys are locked lists them too (#255).
 */
export function usePersonalList(
  store: Pick<PersonalStore, 'listPersonalEntries'>,
): readonly PersonalEntry[] | null {
  const [documents, setDocuments] = useState<readonly PersonalEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    const show = (list: readonly PersonalEntry[]) => {
      if (live) setDocuments(list);
    };
    store.listPersonalEntries().then(show, () => {
      show([]);
    });
    return () => {
      live = false;
    };
  }, [store]);
  return documents;
}

/**
 * The latest relay minute the device has heard (#347, `heardRelay`), read
 * once when Personal opens, as its list is, so which shares are paused is
 * measured on the relay's clock and never the device's. Null until the
 * store answers, and when it can't, as while the device's keys are locked
 * (#255): then each share is measured by its own last read alone.
 */
export function useHeardRelay(store: ShareServices['store']): number | null {
  const [heard, setHeard] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    heardRelay({ store }).then(
      (minute) => {
        if (live) setHeard(minute);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [store]);
  return heard;
}
