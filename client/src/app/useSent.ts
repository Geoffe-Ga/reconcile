/** The front-door applications this device sent (#121), as Start and the front door read them. */
import { useEffect, useState } from 'react';

import { SENT_CHANGED, type SentApplication, type SentStore } from '../store/applications';
import type { Store } from '../store/db';

/**
 * Every application this device sent and still keeps, oldest first, kept
 * current as they change, or null until the store answers.
 */
export function useSentApplications(
  store: Pick<SentStore, 'listSent'> & Pick<Store, 'subscribe'>,
): readonly SentApplication[] | null {
  const [sent, setSent] = useState<readonly SentApplication[] | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.listSent().then(
        (list) => {
          // Only the newest read counts: an older one may answer last.
          if (live && ticket === latest) setSent(list);
        },
        // A failed read keeps the last list shown; the next change reads again.
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe((changed) => {
      if (changed === SENT_CHANGED) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store]);
  return sent;
}
