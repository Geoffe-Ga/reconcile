import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MAX_BACKUP_BYTES, type Restored } from '../store/snapshot';
import { axeViolations } from '../test/axe';
import { messages } from './messages';
import { RestoreBackup } from './RestoreBackup';

type OnRestore = (bytes: Uint8Array, passphrase: string) => Promise<Restored>;

const FILE = new File([Uint8Array.of(82, 67, 66, 49)], 'reconcile-backup-2026-11-08.bin');

/** A restore of `groups` groups from a current file, or an older one (#225). */
function restored(groups: number, older = false): Restored {
  return { groups, older };
}

function setup(onRestore = vi.fn<OnRestore>(() => Promise.resolve(restored(2)))) {
  document.title = 'Settings · Reconcile';
  render(
    <main>
      <h1>Settings</h1>
      <RestoreBackup onRestore={onRestore} />
    </main>,
  );
  return { user: userEvent.setup(), onRestore };
}

/** The file input React Aria's FileTrigger keeps behind Choose backup file. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected the file input.');
  return input;
}

describe('RestoreBackup', () => {
  it('picks any file, with no type list for iOS to grey out, and passes axe', async () => {
    setup();

    expect(screen.getByRole('button', { name: 'Choose backup file' })).toBeVisible();
    expect(fileInput()).not.toHaveAttribute('accept');
    expect(fileInput()).not.toHaveAttribute('multiple');
    expect(screen.queryByLabelText('Its passphrase')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('restores the chosen file’s bytes under its passphrase and says how many groups came back', async () => {
    const { user, onRestore } = setup();

    await user.upload(fileInput(), FILE);
    expect(screen.getByText('reconcile-backup-2026-11-08.bin')).toBeVisible();
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    expect(screen.getByLabelText('Its passphrase')).toHaveAttribute('type', 'password');
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('2 groups are back on this device.')).toBeVisible();
    const [bytes, passphrase] = onRestore.mock.calls[0] ?? [];
    expect(Array.from(bytes ?? [])).toEqual([82, 67, 66, 49]);
    expect(passphrase).toBe('a long walk to the river');
    expect(screen.queryByLabelText('Its passphrase')).not.toBeInTheDocument();
  });

  it('says the one plain line when the backup doesn’t open, and keeps the file to try again', async () => {
    const onRestore = vi.fn<OnRestore>(() => Promise.reject(new Error('BackupUnreadable')));
    const { user } = setup(onRestore);

    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'the wrong passphrase');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That passphrase doesn’t open this backup, or the file is damaged.',
    );
    expect(screen.getByLabelText('Its passphrase')).toHaveValue('the wrong passphrase');
  });

  it('refuses a file too large to be a backup without reading it', async () => {
    const { user, onRestore } = setup();
    const huge = new File([Uint8Array.of(1)], 'film.mov');
    Object.defineProperty(huge, 'size', { value: MAX_BACKUP_BYTES + 1 });
    const read = vi.spyOn(huge, 'arrayBuffer');

    await user.upload(fileInput(), huge);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That passphrase doesn’t open this backup, or the file is damaged.',
    );
    expect(read).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('asks for the passphrase before restoring', async () => {
    const { user, onRestore } = setup();

    await user.upload(fileInput(), FILE);
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Its passphrase')).toHaveAccessibleDescription(
      'Enter the passphrase this backup was saved with.',
    );
  });

  it('says how many came back for one group, and for none', async () => {
    const onRestore = vi
      .fn<OnRestore>()
      .mockResolvedValueOnce(restored(1))
      .mockResolvedValueOnce(restored(0));
    const { user } = setup(onRestore);

    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('1 group is back on this device.')).toBeVisible();

    // Choose backup file clears the input first, so the same file can be chosen again.
    await user.click(screen.getByRole('button', { name: 'Choose backup file' }));
    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('This backup holds no groups.')).toBeVisible();
    expect(screen.queryByText(messages.restore.older)).not.toBeInTheDocument();
  });

  it('says plainly when the file is from before groups changed keys, and how this device gets back in (#225)', async () => {
    const onRestore = vi.fn<OnRestore>(() => Promise.resolve(restored(2, true)));
    const { user } = setup(onRestore);

    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const status = await screen.findByRole('status');
    await vi.waitFor(() => {
      expect(status).toHaveTextContent('2 groups are back on this device.');
    });
    expect(status).toHaveTextContent(
      'This backup is from an older version of Reconcile. If you’ve used Reconcile on another device since you saved it, this device won’t get a group’s new key when someone leaves. Ask someone in that group for a new invite link then, or restore a newer backup saved on that device.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing of an older file that holds no groups', async () => {
    const { user } = setup(vi.fn<OnRestore>(() => Promise.resolve(restored(0, true))));

    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('This backup holds no groups.')).toBeVisible();
    expect(screen.queryByText(messages.restore.older)).not.toBeInTheDocument();
  });
});
