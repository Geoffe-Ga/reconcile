import { type ReactNode, useId, useState } from 'react';
import { Button, SwitchButton, SwitchField } from 'react-aria-components';

import type { BackupToSave } from '../app/backup';
import { HoldToConfirm } from '../app/HoldToConfirm';
import { messages } from '../app/messages';
import { RestoreBackup } from '../app/RestoreBackup';
import { SaveBackup } from '../app/SaveBackup';
import type { SaveOutcome } from '../app/share';
import { BackLink, PageHeader } from '../app/ui';
import type { PushAvailability, TurnOnOutcome } from '../store/push';

/** A group as its push switch shows it: its name, and whether push is on for it. */
export interface NotifyGroup {
  readonly groupId: string;
  readonly name: string;
  readonly on: boolean;
}

/** What Settings › Notifications shows and does (#99). */
export interface NotifyProps {
  /** Whether this device can get push now. */
  readonly availability: PushAvailability;
  /** Each group with a name that isn't leaving, in the store's order. */
  readonly groups: readonly NotifyGroup[];
  /** Turns a group on; called straight from the tap, since it asks permission first. */
  readonly onTurnOn: (groupId: string) => Promise<TurnOnOutcome>;
  /** Turns a group off. */
  readonly onTurnOff: (groupId: string) => Promise<void>;
}

/** Props for {@link Settings}. */
export interface SettingsProps {
  /** Push, one switch per group (#99). */
  readonly notify: NotifyProps;
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

/** The line under the switches: why a group didn't turn on, or nothing. */
type NotifyNote = 'blocked' | 'unavailable' | 'failed' | null;

function noteOf(outcome: TurnOnOutcome): NotifyNote {
  return outcome === 'blocked' || outcome === 'unavailable' || outcome === 'failed'
    ? outcome
    : null;
}

/**
 * Notifications (#99; ADR-0012, ADR-0075 §2): the disclosure first, then one
 * switch per group, off until the relay has the endpoint. A switch shows
 * what the store holds, so it turns on only once that has succeeded.
 */
function NotifySection({ notify }: { readonly notify: NotifyProps }) {
  const { push } = messages;
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<NotifyNote>(
    notify.availability === 'blocked' ? 'blocked' : null,
  );
  const settle = (groupId: string): void => {
    setBusy((now) => new Set([...now].filter((id) => id !== groupId)));
  };
  const toggle = (groupId: string, on: boolean): void => {
    // Turning on asks permission at once: still inside the tap that changed the switch.
    const done = on
      ? notify.onTurnOn(groupId).then(noteOf)
      : notify.onTurnOff(groupId).then(() => null);
    setBusy((now) => new Set([...now, groupId]));
    done
      .then(setNote)
      .catch(() => {
        setNote('failed');
      })
      .finally(() => {
        settle(groupId);
      });
  };
  return (
    <div className="stack">
      <p className="lede">{push.disclosure}</p>
      {notify.availability === 'unsupported' ? (
        <p className="notify-note">{push.unavailable}</p>
      ) : (
        <>
          {notify.groups.length === 0 ? <p className="notify-note">{push.none}</p> : null}
          <ul className="notify-list">
            {notify.groups.map((group) => (
              <li key={group.groupId}>
                <SwitchField
                  isSelected={group.on}
                  isDisabled={busy.has(group.groupId)}
                  onChange={(on) => {
                    toggle(group.groupId, on);
                  }}
                >
                  <SwitchButton className="notify-switch">
                    <span className="notify-name">{push.notify(group.name)}</span>
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-thumb" />
                    </span>
                  </SwitchButton>
                </SwitchField>
              </li>
            ))}
          </ul>
          <p className="notify-note" role="status">
            {note === null ? null : push[note]}
          </p>
        </>
      )}
    </div>
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
 * Settings (`#/settings`; spec §8.12, #78, #99): Notifications, one switch
 * per group, then Save a backup, Restore a backup, and Erase Reconcile from
 * this device behind a 3-second press and hold.
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
        <Section title={settings.notifyHeading}>
          <NotifySection notify={props.notify} />
        </Section>
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
