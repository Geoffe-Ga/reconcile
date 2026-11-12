/** This device's personal Documents (#93), as Personal lists them. */
import { useEffect, useState } from 'react';

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
