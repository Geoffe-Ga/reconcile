/**
 * Restore a backup (#78; spec §8 Start and Settings): pick the file, then its
 * passphrase.
 *
 * The file picker is React Aria's `FileTrigger` with no `accept` list, since
 * iOS greys out a file whose type it doesn't know. Restoring reads the file
 * on the device and checks all of it before writing anything. Success says
 * how many groups came back; any failure says one plain line, whether the
 * passphrase was wrong or the file damaged, and writes nothing.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, FileTrigger, Form } from 'react-aria-components';

import { MAX_BACKUP_BYTES } from '../store/snapshot';
import { messages } from './messages';
import { Field } from './ui';

/** Props for {@link RestoreBackup}. */
export interface RestoreBackupProps {
  /** Restores the file's bytes under the passphrase; resolves to how many groups it held. */
  readonly onRestore: (bytes: Uint8Array, passphrase: string) => Promise<number>;
}

/** Where restoring has got to. */
type Outcome =
  | { readonly kind: 'idle' | 'restoring' | 'failed' }
  | { readonly kind: 'restored'; readonly groups: number };

/** The file's bytes, or null when it's too large to be a backup. */
async function bytesOf(file: File): Promise<Uint8Array | null> {
  if (file.size > MAX_BACKUP_BYTES) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Choose backup file, then the passphrase and Restore. */
export function RestoreBackup({ onRestore }: RestoreBackupProps) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const restoring = outcome.kind === 'restoring';

  const restore = async (chosen: File) => {
    setOutcome({ kind: 'restoring' });
    const bytes = await bytesOf(chosen).catch(() => null);
    const groups = bytes === null ? null : await onRestore(bytes, passphrase).catch(() => null);
    if (groups === null) {
      setOutcome({ kind: 'failed' });
      return;
    }
    setFile(null);
    setPassphrase('');
    setOutcome({ kind: 'restored', groups });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file !== null && passphrase !== '' && !restoring) void restore(file);
  };

  return (
    <div className="stack">
      <div>
        <FileTrigger
          onSelect={(files) => {
            setFile(files?.[0] ?? null);
            setOutcome({ kind: 'idle' });
          }}
        >
          <Button className="button button-secondary" isDisabled={restoring}>
            {messages.restore.choose}
          </Button>
        </FileTrigger>
      </div>
      {file === null ? null : (
        <Form className="form" onSubmit={submit}>
          <p className="caption restore-file">
            {messages.restore.chosen} <bdi>{file.name}</bdi>
          </p>
          <Field
            name="passphrase"
            type="password"
            autoComplete="current-password"
            label={messages.restore.passphrase}
            value={passphrase}
            onChange={setPassphrase}
            isRequired
            validate={(value) => (value === '' ? messages.restore.passphraseMissing : null)}
          />
          <div>
            <Button type="submit" className="button button-secondary" isDisabled={restoring}>
              {messages.restore.submit}
            </Button>
          </div>
        </Form>
      )}
      <p role="status" className="status">
        {outcome.kind === 'restoring' ? messages.restore.restoring : null}
        {outcome.kind === 'restored' ? messages.restore.restored(outcome.groups) : null}
      </p>
      {outcome.kind === 'failed' ? (
        <p role="alert" className="form-error">
          {messages.restore.failed}
        </p>
      ) : null}
    </div>
  );
}
