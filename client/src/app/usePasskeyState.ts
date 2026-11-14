/**
 * Settings' passkey section as the store stands (#95, #389): whether this
 * device's keys are locked with a passkey, or one can be set up, and the
 * groups' way back if it ever stops unlocking them, read again after every
 * store change, so a backup file saved or contacts chosen on the same screen
 * opens setup at once.
 */
import { useEffect, useState } from 'react';

import type { SettingsPasskey } from '../screens/Settings';
import type { Store } from '../store/db';
import type { Passkey } from './passkey';
import type { RecoveryPath } from './recoveryPath';

/** The section's state and way back, or null until both are read. */
export type PasskeyState = Pick<SettingsPasskey, 'state' | 'path'>;

/** Whether the keys are locked, and the way back, read now and after each store change. */
export function usePasskeyState(
  passkey: Passkey,
  store: Pick<Store, 'subscribe'>,
): PasskeyState | null {
  const [read, setRead] = useState<{ locked: boolean; path: RecoveryPath } | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      Promise.all([passkey.isProtected(), passkey.recoveryPath()]).then(
        ([locked, path]) => {
          // Only the newest read counts: an older one may answer last.
          if (live && ticket === latest) setRead({ locked, path });
        },
        // A failed read keeps the last state shown; the next change reads again.
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [passkey, store]);
  if (read === null) return null;
  const { locked, path } = read;
  if (locked) return { state: 'locked', path };
  return { state: passkey.available ? 'offered' : 'unavailable', path };
}
