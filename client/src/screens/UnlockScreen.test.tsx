/**
 * The unlock screen (#95): one button that asks for the passkey, and when it
 * doesn't unlock, Try again, Restore a backup file and Erase.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { axeViolations } from '../test/axe';
import { UnlockScreen, type UnlockScreenProps } from './UnlockScreen';

function setup(props: Partial<UnlockScreenProps> = {}) {
  const all: UnlockScreenProps = {
    onUnlock: vi.fn(() => Promise.resolve(false)),
    onRestore: vi.fn(() => Promise.resolve(1)),
    onErase: vi.fn(() => new Promise<void>(() => undefined)),
    ...props,
  };
  render(<UnlockScreen {...all} />);
  return { user: userEvent.setup(), ...all };
}

const { unlock } = messages;

describe('UnlockScreen', () => {
  it('asks for nothing until its one button is pressed, and passes axe', async () => {
    const { onUnlock } = setup();

    expect(screen.getByRole('heading', { level: 1, name: unlock.title })).toHaveFocus();
    expect(document.title).toBe('Unlock Reconcile · Reconcile');
    expect(screen.getByText(unlock.lede)).toBeVisible();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      unlock.unlock,
    ]);
    expect(screen.getByRole('button', { name: unlock.unlock })).toHaveClass('button-primary');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(onUnlock).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('asks the passkey once per press, saying so while it waits', async () => {
    let answer: (opened: boolean) => void = () => undefined;
    const onUnlock = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const { user } = setup({ onUnlock });
    const button = screen.getByRole('button', { name: unlock.unlock });

    await user.click(button);
    await user.click(button);

    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(unlock.unlocking);
    expect(button).toBeDisabled();
    await act(async () => {
      answer(true);
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the passkey didn’t unlock, then offers Try again, Restore a backup file and Erase', async () => {
    const { user, onUnlock } = setup();

    await user.click(screen.getByRole('button', { name: unlock.unlock }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your passkey didn’t unlock Reconcile.',
    );
    const again = screen.getByRole('button', { name: unlock.tryAgain });
    expect(again).toHaveFocus();
    const restore = screen.getByRole('region', { name: unlock.restoreHeading });
    expect(within(restore).getByText(unlock.restoreLede)).toBeVisible();
    expect(within(restore).getByRole('button', { name: 'Choose backup file' })).toBeVisible();
    const erase = screen.getByRole('region', { name: unlock.eraseHeading });
    expect(
      within(erase).getByRole('button', { name: 'Erase Reconcile from this device' }),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(again);
    expect(onUnlock).toHaveBeenCalledTimes(2);
  });

  it('reads a rejected unlock as one that didn’t unlock', async () => {
    const { user } = setup({ onUnlock: vi.fn(() => Promise.reject(new Error('gone'))) });

    await user.click(screen.getByRole('button', { name: unlock.unlock }));

    expect(await screen.findByRole('alert')).toHaveTextContent(unlock.failed);
  });

  it('erases only through its hold, as Settings does', async () => {
    const { user, onErase } = setup();
    await user.click(screen.getByRole('button', { name: unlock.unlock }));
    await user.click(
      await screen.findByRole('button', { name: 'Erase Reconcile from this device' }),
    );

    await user.click(screen.getByRole('button', { name: 'Hold to erase' }));

    expect(onErase).not.toHaveBeenCalled();
    expect(screen.getByText('You let go early, so nothing was erased.')).toBeVisible();
  });
});
