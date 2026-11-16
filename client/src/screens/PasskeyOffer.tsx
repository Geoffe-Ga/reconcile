/**
 * The passkey offer (#95): shown once after the pilot notice, on a device
 * where a passkey can lock the keys, and always in Settings after that.
 *
 * It says what a passkey protects against, that the phone asks twice the
 * first time, and what the password manager learns. Not now, quiet beside
 * the primary button, closes it, and so does Continue once setup has ended;
 * either way this device doesn't ask again (`platform/passkeyOffer.ts`).
 *
 * It locks nothing until the groups have a way back if the passkey ever
 * stops unlocking this device (#389, `app/recoveryPath.ts`). Without one, it
 * asks for a backup file in the same step, with Save a backup's own form, or
 * recovery contacts instead, which closes the offer without an answer, so it
 * comes back at a later launch. Once the file is saved, the passkey's setup
 * takes the form's place. On a device with no group yet, there is nothing to
 * back up: the offer says so, and Continue opens the app without an answer,
 * so it comes back at a later launch once there is a group. Its heading and
 * lede show at once, while the way back is read.
 */
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import type { BackupToSave } from '../app/backup';
import { messages } from '../app/messages';
import type { Passkey } from '../app/passkey';
import { PasskeySetup } from '../app/PasskeySetup';
import { hasRecoveryPath, type RecoveryPath } from '../app/recoveryPath';
import { routeHref } from '../app/router';
import { SaveBackup, type SaveBackupProps } from '../app/SaveBackup';
import type { SaveOutcome } from '../app/share';
import { PageHeader } from '../app/ui';

/** Props for {@link PasskeyOffer}. */
export interface PasskeyOfferProps {
  /** Passkey setup on this device. */
  readonly passkey: Passkey;
  /** Save a backup's making and saving, for the way back in the same step (#389). */
  readonly backup: Pick<SaveBackupProps, 'onMake' | 'onSave'>;
  /** Records the offer as answered and opens the app. */
  readonly onDone: () => void;
  /** Opens the app without recording an answer, so the offer comes back at a later launch (#389). */
  readonly onSkip: () => void;
}

/** The groups' way back, read once and again after each saved file; null until read. */
function useRecoveryPath(passkey: Passkey) {
  const [path, setPath] = useState<RecoveryPath | null>(null);
  const read = useCallback(
    () =>
      passkey.recoveryPath().then(
        (now) => {
          setPath(now);
        },
        // A store that can't be read leaves no way back to count on.
        () => {
          setPath('none');
        },
      ),
    [passkey],
  );
  useEffect(() => {
    void read();
  }, [read]);
  return { path, read };
}

/**
 * "First, a way back to your groups" (#389): why, Save a backup's form, and
 * recovery contacts instead.
 */
function WayBack({
  backup,
  onSaved,
  onContacts,
}: {
  readonly backup: PasskeyOfferProps['backup'];
  readonly onSaved: () => Promise<void>;
  readonly onContacts: () => void;
}) {
  const words = messages.passkey;
  const heading = useId();
  const onSave = async (file: BackupToSave): Promise<SaveOutcome> => {
    const outcome = await backup.onSave(file);
    if (outcome !== 'cancelled') await onSaved();
    return outcome;
  };
  return (
    <section className="stack passkey-gate" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {words.gateHeading}
      </h2>
      <p className="lede">{words.gate}</p>
      <SaveBackup hasGroups onMake={backup.onMake} onSave={onSave} />
      <p>
        <Link className="forward-link" href={routeHref({ name: 'recovery' })} onPress={onContacts}>
          {words.gateContacts}
          <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      </p>
    </section>
  );
}

/** The offer on a device with no group yet (#389): why it waits, Continue, and Not now. */
function NothingYet({
  notNow,
  onSkip,
}: {
  readonly notNow: ReactNode;
  readonly onSkip: () => void;
}) {
  const words = messages.passkey;
  return (
    <>
      <div className="stack">
        <p className="lede">{words.lede}</p>
        <p className="lede">{words.gateEmpty}</p>
      </div>
      <div className="row passkey-actions">
        <Button className="button button-primary" onPress={onSkip}>
          {words.continue}
        </Button>
        {notNow}
      </div>
    </>
  );
}

/** Lock your keys with a passkey, or Not now; first a way back, where there's none (#389). */
export function PasskeyOffer({ passkey, backup, onDone, onSkip }: PasskeyOfferProps) {
  const [ended, setEnded] = useState(false);
  const [saved, setSaved] = useState(false);
  const { path, read } = useRecoveryPath(passkey);
  const words = messages.passkey;
  const notNow = (
    <Button className="button button-quiet" onPress={onDone}>
      {words.notNow}
    </Button>
  );
  return (
    <main className="shell">
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      {path === null ? <p className="lede">{words.lede}</p> : null}
      {path === 'empty' ? <NothingYet notNow={notNow} onSkip={onSkip} /> : null}
      {path === 'none' ? (
        <>
          <p className="lede">{words.lede}</p>
          <WayBack
            backup={backup}
            onSaved={async () => {
              setSaved(true);
              await read();
            }}
            onContacts={onSkip}
          />
          <div>{notNow}</div>
        </>
      ) : null}
      {path !== null && hasRecoveryPath(path) ? (
        <>
          <div className="stack">
            {saved ? <p className="lede passkey-way-back">{words.wayBack}</p> : null}
            <p className="lede">{words.lede}</p>
            <p className="lede">{words.twice}</p>
            <p className="lede">{words.privacy}</p>
          </div>
          <PasskeySetup
            onCreate={() => passkey.create()}
            onProtect={(id) => passkey.protect(id)}
            onEnd={() => {
              setEnded(true);
            }}
            linkBackup
            onBackup={onDone}
            aside={notNow}
          />
        </>
      ) : null}
      {ended ? (
        <div>
          <Button className="button button-primary" onPress={onDone}>
            {words.continue}
          </Button>
        </div>
      ) : null}
    </main>
  );
}
