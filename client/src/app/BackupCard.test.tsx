import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { BackupCard } from './BackupCard';

function setup(onNotNow = vi.fn(() => Promise.resolve())) {
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <h1>Riverside Tenants</h1>
      <BackupCard onNotNow={onNotNow} />
    </main>,
  );
  return { user: userEvent.setup(), onNotNow };
}

describe('BackupCard', () => {
  it('suggests a backup inline, never as a dialog, with Save a backup opening Settings', async () => {
    setup();

    expect(
      screen.getByText('Save a backup so you can get this group back if you lose your phone.'),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Save a backup' })).toHaveAttribute(
      'href',
      '#/settings',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('answers Not now', async () => {
    const { user, onNotNow } = setup();

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it('stays up, with nothing thrown, when Not now can’t be saved', async () => {
    const onNotNow = vi.fn(() => Promise.reject(new Error('No.')));
    const { user } = setup(onNotNow);

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(onNotNow).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeVisible();
  });
});
