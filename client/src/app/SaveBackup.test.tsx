import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import type { BackupToSave } from './backup';
import { SaveBackup } from './SaveBackup';
import type { SaveOutcome } from './share';

const BACKUP: BackupToSave = {
  file: new File([Uint8Array.of(1)], 'reconcile-backup-2026-11-08.bin'),
  groupIds: ['group-1'],
};

type OnMake = (passphrase: string) => Promise<BackupToSave>;
type OnSave = (backup: BackupToSave) => Promise<SaveOutcome>;

function setup(
  onMake = vi.fn<OnMake>(() => Promise.resolve(BACKUP)),
  onSave = vi.fn<OnSave>(() => Promise.resolve('downloaded')),
  hasGroups = true,
) {
  document.title = 'Settings · Reconcile';
  render(
    <main>
      <h1>Settings</h1>
      <SaveBackup hasGroups={hasGroups} onMake={onMake} onSave={onSave} />
    </main>,
  );
  return { user: userEvent.setup(), onMake, onSave };
}

const passphrase = () => screen.getByLabelText('Passphrase');
const again = () => screen.getByLabelText('Passphrase again');
const make = () => screen.getByRole('button', { name: 'Make a backup file' });

describe('SaveBackup', () => {
  it('asks for the passphrase twice, hidden as typed, with the hint that nobody can recover it', async () => {
    setup();

    expect(passphrase()).toHaveAttribute('type', 'password');
    expect(passphrase()).toHaveAttribute('autocomplete', 'new-password');
    expect(again()).toHaveAttribute('type', 'password');
    expect(passphrase()).toHaveAccessibleDescription(
      'At least 8 characters. Nobody can recover this passphrase for you.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a passphrase under 8 characters', async () => {
    const { user, onMake } = setup();

    await user.type(passphrase(), 'short77');
    await user.type(again(), 'short77');
    await user.click(make());

    expect(onMake).not.toHaveBeenCalled();
    expect(passphrase()).toHaveAccessibleDescription(/Use at least 8 characters\./);
  });

  it('refuses two passphrases that don’t match', async () => {
    const { user, onMake } = setup();

    await user.type(passphrase(), 'a long walk to the river');
    await user.type(again(), 'a long walk to the rivet');
    await user.click(make());

    expect(onMake).not.toHaveBeenCalled();
    expect(again()).toHaveAccessibleDescription('The two passphrases don’t match.');
  });

  it('makes the file under the passphrase exactly as typed, then saves it in a tap of its own', async () => {
    let made: (backup: BackupToSave) => void = () => undefined;
    const onMake = vi.fn<OnMake>(
      () =>
        new Promise((resolve) => {
          made = resolve;
        }),
    );
    const { user, onSave } = setup(onMake);

    await user.type(passphrase(), ' a long walk to the river ');
    await user.type(again(), ' a long walk to the river ');
    await user.click(make());

    expect(onMake).toHaveBeenCalledWith(' a long walk to the river ');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Locking your backup with your passphrase…',
    );
    expect(make()).toBeDisabled();
    made(BACKUP);
    const save = await screen.findByRole('button', { name: 'Save the file' });
    expect(screen.queryByLabelText('Passphrase')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(save);

    expect(onSave).toHaveBeenCalledWith(BACKUP);
    expect(
      await screen.findByText('Saved. Keep the file and the passphrase in different places.'),
    ).toBeVisible();
    expect(passphrase()).toHaveValue('');
    expect(again()).toHaveValue('');
  });

  it('keeps the file to save again when the person closes the share sheet', async () => {
    const onSave = vi.fn<OnSave>(() => Promise.resolve('cancelled'));
    const { user } = setup(undefined, onSave);

    await user.type(passphrase(), 'a long walk to the river');
    await user.type(again(), 'a long walk to the river');
    await user.click(make());
    await user.click(await screen.findByRole('button', { name: 'Save the file' }));

    expect(
      await screen.findByText('The file wasn’t saved. Save the file to try again.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save the file' })).toBeEnabled();
  });

  it('treats a save that throws like a closed sheet', async () => {
    const onSave = vi.fn<OnSave>(() => Promise.reject(new Error('No.')));
    const { user } = setup(undefined, onSave);

    await user.type(passphrase(), 'a long walk to the river');
    await user.type(again(), 'a long walk to the river');
    await user.click(make());
    await user.click(await screen.findByRole('button', { name: 'Save the file' }));

    expect(
      await screen.findByText('The file wasn’t saved. Save the file to try again.'),
    ).toBeVisible();
  });

  it('says so when the file can’t be made', async () => {
    const onMake = vi.fn<OnMake>(() => Promise.reject(new Error('No.')));
    const { user } = setup(onMake);

    await user.type(passphrase(), 'a long walk to the river');
    await user.type(again(), 'a long walk to the river');
    await user.click(make());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The backup file couldn’t be made. Try again.',
    );
    expect(make()).toBeEnabled();
  });

  it('offers nothing to back up on a device with no groups', () => {
    setup(undefined, undefined, false);

    expect(screen.getByText('There are no groups on this device to back up yet.')).toBeVisible();
    expect(screen.queryByLabelText('Passphrase')).not.toBeInTheDocument();
  });
});
