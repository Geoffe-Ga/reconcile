/**
 * The unlock screen (#95; ADR-0008): a device whose keys are locked with a
 * passkey opens here, before anything syncs, signs or shows a group.
 *
 * Its one button asks for the passkey; iOS allows a passkey request only
 * from a tap, so it never asks on its own. When the passkey doesn't unlock
 * the keys, it says so plainly and offers Try again, Restore a backup file
 * (which puts the file's groups in place of the locked ones) and Erase. It
 * never locks the keys again under another passkey by itself.
 */
import { useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import { EraseCard } from '../app/EraseCard';
import { messages } from '../app/messages';
import { RestoreBackup, type RestoreBackupProps } from '../app/RestoreBackup';
import { PageHeader, Section } from '../app/ui';

/** Props for {@link UnlockScreen}. */
export interface UnlockScreenProps {
  /** Asks for the passkey and unlocks the keys; resolves to whether it did. */
  readonly onUnlock: () => Promise<boolean>;
  /** Puts a backup file's groups in place of the locked ones; resolves to how many came back. */
  readonly onRestore: RestoreBackupProps['onRestore'];
  /** Erases all of Reconcile's data on this device and reloads; rejects when it couldn't. */
  readonly onErase: () => Promise<void>;
}

/** Unlock with your passkey, and what to do when it doesn't. */
export function UnlockScreen({ onUnlock, onRestore, onErase }: UnlockScreenProps) {
  const [waiting, setWaiting] = useState(false);
  // Whether the last try failed, and whether any did: Restore and Erase stay once offered.
  const [failed, setFailed] = useState(false);
  const [tried, setTried] = useState(false);
  // A ref, not state, so a second tap in the same moment sees the first.
  const busy = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const { unlock } = messages;

  const press = () => {
    if (busy.current) return;
    busy.current = true;
    setWaiting(true);
    setFailed(false);
    void onUnlock()
      .catch(() => false)
      .then((opened) => {
        busy.current = false;
        setWaiting(false);
        if (opened) return;
        setFailed(true);
        setTried(true);
        button.current?.focus();
      });
  };

  return (
    <main className="shell">
      <PageHeader title={unlock.title} pageTitle={unlock.pageTitle} />
      <div className="stack">
        <p className="lede">{unlock.lede}</p>
        <div>
          <Button
            ref={button}
            className="button button-primary"
            isDisabled={waiting}
            onPress={press}
          >
            {tried ? unlock.tryAgain : unlock.unlock}
          </Button>
        </div>
        <p role="status" className="status">
          {waiting ? unlock.unlocking : ''}
        </p>
        {failed ? (
          <p role="alert" className="form-error">
            {unlock.failed}
          </p>
        ) : null}
      </div>
      {tried ? (
        <div className="sections">
          <Section title={unlock.restoreHeading}>
            <div className="stack">
              <p className="lede">{unlock.restoreLede}</p>
              <RestoreBackup onRestore={onRestore} />
            </div>
          </Section>
          <Section title={unlock.eraseHeading}>
            <EraseCard onErase={onErase} />
          </Section>
        </div>
      ) : null}
    </main>
  );
}
