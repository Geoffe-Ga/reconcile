/**
 * The passkey offer (#95): once after the pilot notice, with Not now, and a
 * Continue once setup has ended. It locks nothing until the groups have a
 * way back (#389): with none, it asks for a backup file in the same step, or
 * recovery contacts instead, and on a device with no group yet it says so,
 * and Continue opens the app without an answer, to come back once there is one.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackupToSave } from '../app/backup';
import { messages } from '../app/messages';
import type { Passkey, Protection } from '../app/passkey';
import type { RecoveryPath } from '../app/recoveryPath';
import { axeViolations } from '../test/axe';
import { PasskeyOffer } from './PasskeyOffer';

const BACKUP: BackupToSave = { file: new File(['x'], 'backup.reconcile'), groupIds: ['g1'] };

function setup(protection: Protection = 'protected', paths: RecoveryPath[] = ['backup']) {
  const create = vi.fn(() => Promise.resolve(Uint8Array.of(1)));
  const recoveryPath = vi.fn(() => Promise.resolve(paths.length > 1 ? paths.shift() : paths[0]));
  const passkey: Passkey = {
    available: true,
    isProtected: vi.fn(() => Promise.resolve(false)),
    recoveryPath: recoveryPath as Passkey['recoveryPath'],
    create,
    protect: vi.fn(() => Promise.resolve(protection)),
  };
  const backup = {
    onMake: vi.fn(() => Promise.resolve(BACKUP)),
    onSave: vi.fn(() => Promise.resolve('downloaded' as const)),
  };
  const onDone = vi.fn();
  const onSkip = vi.fn();
  render(<PasskeyOffer passkey={passkey} backup={backup} onDone={onDone} onSkip={onSkip} />);
  return { user: userEvent.setup(), create, onDone, onSkip, backup, recoveryPath };
}

const { passkey: words } = messages;

describe('PasskeyOffer', () => {
  it('says what a passkey does, that the phone asks twice, and what the password manager sees', async () => {
    setup();

    expect(await screen.findByRole('heading', { level: 1, name: words.title })).toHaveFocus();
    expect(document.title).toBe('Lock with a passkey · Reconcile');
    for (const line of [words.lede, words.twice, words.privacy]) {
      expect(screen.getByText(line)).toBeVisible();
    }
    expect(screen.getByRole('button', { name: words.create })).toHaveClass('button-primary');
    expect(screen.getByRole('button', { name: words.notNow })).toHaveClass('button-quiet');
    expect(screen.queryByText(words.gate)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('closes on Not now, making nothing', async () => {
    const { user, create, onDone } = setup();

    await user.click(await screen.findByRole('button', { name: words.notNow }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('offers Continue, the one primary button left, once the keys are locked', async () => {
    const { user, onDone } = setup();

    await user.click(await screen.findByRole('button', { name: words.create }));
    await user.click(await screen.findByRole('button', { name: words.confirm }));
    expect(await screen.findByText(words.locked)).toBeVisible();

    expect(screen.queryByRole('button', { name: words.notNow })).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: words.continue });
    expect(next).toHaveClass('button-primary');
    expect(await axeViolations()).toEqual([]);
    await user.click(next);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('links to Save a backup when the passkey can’t protect the keys, closing the offer', async () => {
    const { user, onDone } = setup('no-prf');

    await user.click(await screen.findByRole('button', { name: words.create }));
    await user.click(await screen.findByRole('button', { name: words.confirm }));
    const link = await screen.findByRole('link', { name: words.saveBackup });

    expect(screen.getByText(words.noPrf)).toBeVisible();
    expect(link).toHaveAttribute('href', '#/settings');
    expect(await axeViolations()).toEqual([]);
    await user.click(link);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  describe('without a way back (#389)', () => {
    it('asks for a backup file in the same step, with contacts instead, and no passkey yet', async () => {
      const { onSkip } = setup('protected', ['none']);

      const gate = await screen.findByRole('region', { name: words.gateHeading });
      expect(gate).toHaveTextContent(words.gate);
      expect(screen.getByText(words.lede)).toBeVisible();
      expect(screen.queryByRole('button', { name: words.create })).not.toBeInTheDocument();
      expect(screen.getByLabelText(messages.backup.passphrase)).toBeVisible();
      // The one primary action is the backup file's.
      const primary = document.querySelectorAll('.button-primary');
      expect([...primary].map((button) => button.textContent)).toEqual([messages.backup.make]);
      expect(screen.getByRole('link', { name: words.gateContacts })).toHaveAttribute(
        'href',
        '#/recovery',
      );
      expect(screen.getByRole('button', { name: words.notNow })).toHaveClass('button-quiet');
      expect(onSkip).not.toHaveBeenCalled();
      expect(await axeViolations()).toEqual([]);
    });

    it('offers the passkey once the backup file is saved, and says it is', async () => {
      const { user, backup, recoveryPath } = setup('protected', ['none', 'backup']);
      const passphrase = 'a long walk to the river';

      await user.type(await screen.findByLabelText(messages.backup.passphrase), passphrase);
      await user.type(screen.getByLabelText(messages.backup.confirm), passphrase);
      await user.click(screen.getByRole('button', { name: messages.backup.make }));
      await user.click(await screen.findByRole('button', { name: messages.backup.save }));

      expect(await screen.findByText(words.wayBack)).toBeVisible();
      expect(backup.onMake).toHaveBeenCalledWith(passphrase);
      expect(backup.onSave).toHaveBeenCalledWith(BACKUP);
      expect(recoveryPath).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('region', { name: words.gateHeading })).not.toBeInTheDocument();
      const primary = document.querySelectorAll('.button-primary');
      expect([...primary].map((button) => button.textContent)).toEqual([words.create]);
      expect(await axeViolations()).toEqual([]);
    });

    it('keeps asking when the file wasn’t saved, or still leaves a group out', async () => {
      const { user, backup } = setup('protected', ['none', 'none']);
      backup.onSave.mockResolvedValueOnce('cancelled' as never);
      const passphrase = 'a long walk to the river';

      await user.type(await screen.findByLabelText(messages.backup.passphrase), passphrase);
      await user.type(screen.getByLabelText(messages.backup.confirm), passphrase);
      await user.click(screen.getByRole('button', { name: messages.backup.make }));
      await user.click(await screen.findByRole('button', { name: messages.backup.save }));
      expect(await screen.findByText(messages.backup.cancelled)).toBeVisible();
      await user.click(screen.getByRole('button', { name: messages.backup.save }));

      expect(await screen.findByText(messages.backup.saved)).toBeVisible();
      expect(screen.getByRole('region', { name: words.gateHeading })).toBeVisible();
      expect(screen.queryByRole('button', { name: words.create })).not.toBeInTheDocument();
    });

    it('closes without an answer to choose recovery contacts', async () => {
      const { user, onSkip, onDone } = setup('protected', ['none']);

      await user.click(await screen.findByRole('link', { name: words.gateContacts }));

      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('shows its heading at once, while it reads the way back', () => {
      setup('protected', ['none']);

      expect(screen.getByRole('heading', { level: 1, name: words.title })).toBeVisible();
      expect(screen.getByText(words.lede)).toBeVisible();
    });

    it('says why it waits on a device with no group yet, and Continue answers nothing', async () => {
      const { user, onSkip, onDone } = setup('protected', ['empty']);

      expect(await screen.findByText(words.gateEmpty)).toBeVisible();
      expect(screen.queryByRole('button', { name: words.create })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: words.continue })).toHaveClass('button-primary');
      expect(screen.getByRole('button', { name: words.notNow })).toHaveClass('button-quiet');
      expect(await axeViolations()).toEqual([]);
      await user.click(screen.getByRole('button', { name: words.continue }));

      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('takes Not now on a device with no group yet as an answer', async () => {
      const { user, onSkip, onDone } = setup('protected', ['empty']);

      await user.click(await screen.findByRole('button', { name: words.notNow }));

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onSkip).not.toHaveBeenCalled();
    });
  });
});
