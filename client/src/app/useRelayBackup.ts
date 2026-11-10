/** The relay backup's status, as Settings shows it (#97). */
import { useEffect, useState } from 'react';

import type { Store } from '../store/db';
import { relayBackupStatus, type RelayBackupStatus } from '../store/relayBackup';

/**
 * Where the relay backup stands, kept current as the store changes, or null
 * until the store answers.
 */
export function useRelayBackupStatus(
  store: Pick<Store, 'getRelayBackup' | 'subscribe'>,
): RelayBackupStatus | null {
  const [status, setStatus] = useState<RelayBackupStatus | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.getRelayBackup().then(
        (state) => {
          // Only the newest read counts: an older one may answer last.
          if (live && ticket === latest) setStatus(relayBackupStatus(state));
        },
        // A failed read keeps the last status shown; the next change reads again.
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
  return status;
}
