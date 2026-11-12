import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MAX_BACKUP_BYTES, type Restored } from '../store/snapshot';
import { axeViolations } from '../test/axe';
import { held, pastPressFallback } from '../test/press';
import { RestoreBackup } from './RestoreBackup';

type OnRestore = (bytes: Uint8Array, passphrase: string) => Promise<Restored>;

/** What a restore of `groups` groups, leaving out `skipped` group entries, resolves to. */
const restored = (groups: number, skipped = 0): Restored => ({ groups, skipped });

const FILE = new File([Uint8Array.of(82, 67, 66, 49)], 'reconcile-backup-2026-11-08.bin');

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
  });

  /** Chooses the file again, as Choose backup file lets, and restores it under its passphrase. */
  async function restoreAgain(user: ReturnType<typeof userEvent.setup>) {
    // Choose backup file clears the input first, so the same file can be chosen again.
    await user.click(screen.getByRole('button', { name: 'Choose backup file' }));
    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
  }

  it('says how many group entries it left out after how many came back, in the one status line (#336)', async () => {
    const onRestore = vi
      .fn<OnRestore>()
      .mockResolvedValueOnce(restored(2, 1))
      .mockResolvedValueOnce(restored(1, 3));
    const { user } = setup(onRestore);

    await restoreAgain(user);
    const status = await screen.findByText(
      '2 groups are back on this device. One group in this backup couldn’t be read and was left out.',
    );
    expect(status).toHaveAttribute('role', 'status');
    // Two sentences of caption text keep a field hint's measure (backup.css).
    expect(status).toHaveClass('status', 'restore-status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await restoreAgain(user);
    expect(
      await screen.findByText(
        '1 group is back on this device. 3 groups in this backup couldn’t be read and were left out.',
      ),
    ).toHaveAttribute('role', 'status');
  });

  it('says only what it left out when no group came back (#336)', async () => {
    const onRestore = vi
      .fn<OnRestore>()
      .mockResolvedValueOnce(restored(0, 1))
      .mockResolvedValueOnce(restored(0, 2));
    const { user } = setup(onRestore);

    await restoreAgain(user);
    expect(
      await screen.findByText('One group in this backup couldn’t be read and was left out.'),
    ).toHaveAttribute('role', 'status');

    await restoreAgain(user);
    expect(
      await screen.findByText('2 groups in this backup couldn’t be read and were left out.'),
    ).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/holds no groups/)).not.toBeInTheDocument();
  });

  it('restores once when Restore is tapped again while it restores and the backup doesn’t open (#193)', async () => {
    const restoring = held<Restored>();
    const { user, onRestore } = setup(vi.fn<OnRestore>(() => restoring.promise));
    await user.upload(fileInput(), FILE);
    await user.type(screen.getByLabelText('Its passphrase'), 'the wrong passphrase');
    const restore = screen.getByRole('button', { name: 'Restore' });
    await user.click(restore);
    expect(restore).toBeDisabled();
    await user.click(restore);
    restoring.reject();
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(restore).toBeEnabled();
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
