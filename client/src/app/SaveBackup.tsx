/**
 * Save a backup (#78; spec §8 Settings): the passphrase twice, then the file.
 *
 * Making the file derives a key from the passphrase, which takes about a
 * second, so it's a step of its own: "Make a backup file", then "Save the
 * file". The save starts inside its own tap, as the share sheet in an
 * installed iPhone app needs. The passphrase leaves the fields once the
 * file is made, and nothing is saved until the person saves the file.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { type BackupToSave, passphraseProblem } from './backup';
import { holdPresses } from './holdPresses';
import { messages } from './messages';
import type { SaveOutcome } from './share';
import { Field } from './ui';

/** Props for {@link SaveBackup}. */
export interface SaveBackupProps {
  /** Whether the device has any group to back up. */
  readonly hasGroups: boolean;
  /** Makes the sealed file under the passphrase; rejects when it can't. */
  readonly onMake: (passphrase: string) => Promise<BackupToSave>;
  /** Saves the file through the share sheet or a download. */
  readonly onSave: (backup: BackupToSave) => Promise<SaveOutcome>;
}

/** Where saving has got to. */
type Step =
  | { readonly kind: 'form' | 'making' | 'failed' | 'saved' }
  | { readonly kind: 'ready' | 'saving' | 'cancelled'; readonly backup: BackupToSave };

/** The live region's words for `step`. */
function statusOf(step: Step): string {
  const { backup } = messages;
  switch (step.kind) {
    case 'making':
      return backup.making;
    case 'ready':
    case 'saving':
      return backup.ready;
    case 'saved':
      return backup.saved;
    case 'cancelled':
      return backup.cancelled;
    default:
      return '';
  }
}

interface PassphraseFormProps {
  readonly making: boolean;
  readonly onMake: (passphrase: string) => void;
}

/** The passphrase, twice, and Make a backup file. */
function PassphraseForm({ making, onMake }: PassphraseFormProps) {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = (value: string) =>
    value === passphrase ? null : messages.backup.confirmMismatch;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (making || passphraseProblem(passphrase) !== null || mismatch(again) !== null) return;
    onMake(passphrase);
  };
  return (
    <Form className="form" onSubmit={submit}>
      <Field
        name="passphrase"
        type="password"
        autoComplete="new-password"
        label={messages.backup.passphrase}
        hint={messages.backup.passphraseHint}
        value={passphrase}
        onChange={setPassphrase}
        isRequired
        validate={passphraseProblem}
      />
      <Field
        name="again"
        type="password"
        autoComplete="new-password"
        label={messages.backup.confirm}
        value={again}
        onChange={setAgain}
        isRequired
        validate={mismatch}
      />
      <div onPointerDownCapture={holdPresses(making)}>
        <Button type="submit" className="button button-primary" isDisabled={making}>
          {messages.backup.make}
        </Button>
      </div>
    </Form>
  );
}

/** The passphrase form, or, once the file is made, Save the file. */
export function SaveBackup({ hasGroups, onMake, onSave }: SaveBackupProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' });
  // A fresh form after each file, so the passphrase never lingers in a field.
  const [made, setMade] = useState(0);

  if (!hasGroups) return <p>{messages.backup.none}</p>;

  const make = (passphrase: string) => {
    setStep({ kind: 'making' });
    onMake(passphrase).then(
      (backup) => {
        setMade((count) => count + 1);
        setStep({ kind: 'ready', backup });
      },
      () => {
        setStep({ kind: 'failed' });
      },
    );
  };
  const save = (backup: BackupToSave) => {
    setStep({ kind: 'saving', backup });
    onSave(backup).then(
      (outcome) => {
        setStep(outcome === 'cancelled' ? { kind: 'cancelled', backup } : { kind: 'saved' });
      },
      () => {
        setStep({ kind: 'cancelled', backup });
      },
    );
  };
  const holding = 'backup' in step ? step.backup : null;
  return (
    <div className="stack">
      {holding === null ? (
        <PassphraseForm key={made} making={step.kind === 'making'} onMake={make} />
      ) : (
        <div>
          <Button
            className="button button-primary"
            onPress={() => {
              save(holding);
            }}
            isDisabled={step.kind === 'saving'}
          >
            {messages.backup.save}
          </Button>
        </div>
      )}
      <p role="status" className="status">
        {statusOf(step)}
      </p>
      {step.kind === 'failed' ? (
        <p role="alert" className="form-error">
          {messages.backup.makeFailed}
        </p>
      ) : null}
    </div>
  );
}
