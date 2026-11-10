import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { SuspendDialog } from './SuspendDialog';

type OnSuspend = (reason: string) => Promise<void>;

function setup(onSuspend = vi.fn<OnSuspend>(() => Promise.resolve())) {
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <SuspendDialog name="Kim" days={7} onSuspend={onSuspend} />
    </main>,
  );
  return { user: userEvent.setup(), onSuspend };
}

/** Opens the dialog from its Suspend button. */
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Suspend Kim' }));
  return screen.getByRole('dialog', { name: 'Suspend Kim?' });
}

describe('SuspendDialog', () => {
  it('opens from Suspend with the line everyone will see, an optional reason, and focus inside', async () => {
    const { user } = setup();
    const dialog = await open(user);
    expect(dialog).toHaveTextContent('Everyone in the group will see this. It ends after 7 days.');
    const reason = screen.getByRole('textbox', { name: 'Reason (optional)' });
    expect(reason).not.toBeRequired();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(await axeViolations()).toEqual([]);
  });

  it('queues one suspend with the trimmed reason, then closes', async () => {
    const { user, onSuspend } = setup();
    await open(user);
    await user.type(screen.getByRole('textbox', { name: 'Reason (optional)' }), '  Threats.  ');
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onSuspend).toHaveBeenCalledWith('Threats.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('suspends with no reason when none is given', async () => {
    const { user, onSuspend } = setup();
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(onSuspend).toHaveBeenCalledWith('');
  });

  it('refuses a reason over 280 code points, saying so, and queues nothing', async () => {
    const { user, onSuspend } = setup();
    await open(user);
    const reason = screen.getByRole('textbox', { name: 'Reason (optional)' });
    await user.click(reason);
    await user.paste('🙂'.repeat(281));
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(onSuspend).not.toHaveBeenCalled();
    expect(reason).toHaveAccessibleDescription(
      expect.stringContaining('Keep the reason to 280 characters or fewer.'),
    );
  });

  it('accepts a reason of exactly 280 code points', async () => {
    const { user, onSuspend } = setup();
    await open(user);
    await user.click(screen.getByRole('textbox', { name: 'Reason (optional)' }));
    await user.paste('🙂'.repeat(280));
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(onSuspend).toHaveBeenCalledWith('🙂'.repeat(280));
  });

  it('closes on Cancel and on Escape without suspending', async () => {
    const { user, onSuspend } = setup();
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await open(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSuspend).not.toHaveBeenCalled();
  });

  it('stays open and says so when the suspension can’t be saved', async () => {
    const { user } = setup(vi.fn<OnSuspend>(() => Promise.reject(new Error('full'))));
    const dialog = await open(user);
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The suspension couldn’t be saved on this device. Try again.',
    );
    expect(dialog).toBeInTheDocument();
  });
});
