import { type ReactNode, useId, useState } from 'react';
import { Button } from 'react-aria-components';

import type { BackupToSave } from '../app/backup';
import { HoldToConfirm } from '../app/HoldToConfirm';
import { messages } from '../app/messages';
import { RestoreBackup } from '../app/RestoreBackup';
import { SaveBackup } from '../app/SaveBackup';
import type { SaveOutcome } from '../app/share';
import { BackLink, PageHeader } from '../app/ui';

/** Props for {@link Settings}. */
export interface SettingsProps {
  /** Whether the device has any group to back up. */
  readonly hasGroups: boolean;
  /** Makes the sealed backup file under a passphrase. */
  readonly onMake: (passphrase: string) => Promise<BackupToSave>;
  /** Saves the file through the share sheet or a download. */
  readonly onSave: (backup: BackupToSave) => Promise<SaveOutcome>;
  /** Restores a backup file's bytes under its passphrase; resolves to how many groups came back. */
  readonly onRestore: (bytes: Uint8Array, passphrase: string) => Promise<number>;
  /** Erases all of Reconcile's data on this device and reloads; rejects when it couldn't. */
  readonly onErase: () => Promise<void>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The Erase card (DESIGN.md): "Erase Reconcile from this device", in the same
 * calm style as any setting, which reveals what Erase does and the
 * press-and-hold confirm, with Cancel.
 */
function EraseCard({ onErase }: Pick<SettingsProps, 'onErase'>) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { erase } = messages;
  return (
    <div className="card erase-card">
      <div>
        <Button
          className="button button-secondary"
          aria-expanded={open}
          {...(open ? { 'aria-controls': panel } : {})}
          onPress={() => {
            setOpen((now) => !now);
          }}
        >
          {erase.open}
        </Button>
      </div>
      {open ? (
        <div id={panel} className="stack erase-panel">
          <p>{erase.body}</p>
          <HoldToConfirm
            label={erase.hold}
            released={erase.released}
            busy={erase.erasing}
            failed={erase.failed}
            onConfirm={onErase}
          />
          <div>
            <Button
              className="button button-quiet"
              onPress={() => {
                setOpen(false);
              }}
            >
              {erase.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings (`#/settings`; spec §8.12, #78): Save a backup, Restore a backup,
 * and Erase Reconcile from this device behind a 3-second press and hold.
 * Protective features live here, not promoted elsewhere (ADR-0018), apart
 * from group home's quiet backup card.
 */
export function Settings(props: SettingsProps) {
  const { settings, backup, restore } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={settings.title} pageTitle={settings.pageTitle} />
      <div className="sections">
        <Section title={settings.backupHeading}>
          <div className="stack">
            <p className="lede">{backup.lede}</p>
            <SaveBackup hasGroups={props.hasGroups} onMake={props.onMake} onSave={props.onSave} />
          </div>
        </Section>
        <Section title={settings.restoreHeading}>
          <div className="stack">
            <p className="lede">{restore.lede}</p>
            <RestoreBackup onRestore={props.onRestore} />
          </div>
        </Section>
        <Section title={settings.eraseHeading}>
          <EraseCard onErase={props.onErase} />
        </Section>
      </div>
    </main>
  );
}
