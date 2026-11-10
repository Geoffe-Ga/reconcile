import { useState } from 'react';
import { SwitchButton, SwitchField } from 'react-aria-components';

import type { BackupToSave } from '../app/backup';
import { EraseCard } from '../app/EraseCard';
import { messages } from '../app/messages';
import type { Protection } from '../app/passkey';
import { PasskeySetup } from '../app/PasskeySetup';
import { RestoreBackup } from '../app/RestoreBackup';
import { SaveBackup } from '../app/SaveBackup';
import type { SaveOutcome } from '../app/share';
import { BackLink, PageHeader, Section } from '../app/ui';
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
/**
 * Settings' passkey section (#95): the keys are locked with a passkey, a
 * passkey can be set up, or this device can't protect them with one.
 */
export interface SettingsPasskey {
  readonly state: 'locked' | 'offered' | 'unavailable';
  /** Tap 1: makes the passkey. */
  readonly onCreate: () => Promise<Uint8Array>;
  /** Tap 2: locks the keys with it when it can. */
  readonly onProtect: (credentialId: Uint8Array) => Promise<Protection>;
}

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
  /** The passkey section (#95). */
  readonly passkey: SettingsPasskey;
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
 * Lock with a passkey (#95): what it does and the two-tap setup, or one line
 * saying the keys are locked, or that this device can't protect them. The
 * passkey can't be turned off yet (deferred past the MVP). Save a backup sits
 * on this same screen, so the no-PRF line links nowhere, and its one primary
 * action is Make a backup file, so this button is secondary.
 */
function PasskeySection({ passkey }: { readonly passkey: SettingsPasskey }) {
  const words = messages.passkey;
  if (passkey.state === 'locked') return <p className="lede">{words.locked}</p>;
  if (passkey.state === 'unavailable') return <p className="lede">{words.noPrf}</p>;
  return (
    <div className="stack">
      <p className="lede">{words.lede}</p>
      <p className="lede">{words.twice}</p>
      <p className="lede">{words.privacy}</p>
      <PasskeySetup
        onCreate={passkey.onCreate}
        onProtect={passkey.onProtect}
        linkBackup={false}
        secondary
      />
    </div>
  );
}

/**
 * Settings (`#/settings`; spec §8.12, #78, #95, #99): Notifications, one
 * switch per group, then Save a backup, Restore a backup, Lock with a
 * passkey, and Erase Reconcile from this device behind a 3-second press and
 * hold.
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
        <Section title={settings.passkeyHeading}>
          <PasskeySection passkey={props.passkey} />
        </Section>
        <Section title={settings.eraseHeading}>
          <EraseCard onErase={props.onErase} />
        </Section>
      </div>
    </main>
  );
}
