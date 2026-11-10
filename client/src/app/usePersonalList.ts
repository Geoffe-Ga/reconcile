/** This device's personal Documents (#93), as Personal lists them. */
import { useEffect, useState } from 'react';

import type { PersonalDocument, PersonalStore } from '../store/personal';

/**
 * Every personal Document on the device, oldest first, read once when
 * Personal opens, or null until the store answers. A failed read lists none,
 * so Personal still offers a new Document, at an id nothing holds.
 */
export function usePersonalList(
  store: Pick<PersonalStore, 'listPersonal'>,
): readonly PersonalDocument[] | null {
  const [documents, setDocuments] = useState<readonly PersonalDocument[] | null>(null);
  useEffect(() => {
    let live = true;
    const show = (list: readonly PersonalDocument[]) => {
      if (live) setDocuments(list);
    };
    store.listPersonal().then(show, () => {
      show([]);
    });
    return () => {
      live = false;
    };
  }, [store]);
  return documents;
}
