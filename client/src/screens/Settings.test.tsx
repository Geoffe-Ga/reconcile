import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { Settings, type SettingsProps } from './Settings';

function setup(props: Partial<SettingsProps> = {}) {
  const all: SettingsProps = {
    hasGroups: true,
    onMake: vi.fn(() => Promise.reject(new Error('unused'))),
    onSave: vi.fn(() => Promise.resolve('downloaded' as const)),
    onRestore: vi.fn(() => Promise.resolve(1)),
    onErase: vi.fn(() => new Promise<void>(() => undefined)),
    ...props,
  };
  render(<Settings {...all} />);
  return { user: userEvent.setup(), ...all };
}

const ERASE_BODY =
  'This erases Reconcile’s data on this device. Your groups carry on for everyone else, and a backup file you saved can bring them back here.';

describe('Settings', () => {
  it('holds Save a backup, Restore a backup and Erase, each under its heading, and passes axe', async () => {
    setup();

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(document.title).toBe('Settings · Reconcile');
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    const save = screen.getByRole('region', { name: 'Back up your groups' });
    expect(within(save).getByLabelText('Passphrase')).toBeVisible();
    const restore = screen.getByRole('region', { name: 'Restore a backup' });
    expect(within(restore).getByRole('button', { name: 'Choose backup file' })).toBeVisible();
    const erase = screen.getByRole('region', { name: 'Erase this device' });
    expect(
      within(erase).getByRole('button', { name: 'Erase Reconcile from this device' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Link a new device under its heading, which opens the linking screen (#96)', async () => {
    setup();

    const link = screen.getByRole('region', { name: 'Link a new device' });
    expect(link).toHaveTextContent(
      'Use your groups on a laptop or a second phone. This device shows a code, the new one scans it, and both show a number for you to check before anything is sent.',
    );
    expect(within(link).getByRole('link', { name: 'Link a new device' })).toHaveAttribute(
      'href',
      '#/link-new',
    );
    // Linking comes after the backup and before Erase.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Back up your groups',
      'Restore a backup',
      'Link a new device',
      'Erase this device',
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('says there is nothing to link on a device with no groups, and offers no link (#96)', () => {
    setup({ hasGroups: false });

    const link = screen.getByRole('region', { name: 'Link a new device' });
    expect(link).toHaveTextContent('There are no groups on this device to link yet.');
    expect(within(link).queryByRole('link')).not.toBeInTheDocument();
  });

  it('reveals what Erase does and the press-and-hold, the only negative control, and Cancel hides them', async () => {
    const { user } = setup();
    const open = screen.getByRole('button', { name: 'Erase Reconcile from this device' });
    expect(screen.queryByRole('button', { name: 'Hold to erase' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.button-negative')).toHaveLength(0);

    await user.click(open);

    expect(open).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(open.getAttribute('aria-controls') ?? '');
    expect(panel).toHaveTextContent(ERASE_BODY);
    const hold = screen.getByRole('button', { name: 'Hold to erase' });
    expect(panel).toContainElement(hold);
    expect([...document.querySelectorAll('.button-negative')]).toEqual([hold]);
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Hold to erase' })).not.toBeInTheDocument();
  });

  it('erases nothing on a tap of Hold to erase', async () => {
    const { user, onErase } = setup();

    await user.click(screen.getByRole('button', { name: 'Erase Reconcile from this device' }));
    await user.click(screen.getByRole('button', { name: 'Hold to erase' }));

    expect(onErase).not.toHaveBeenCalled();
    expect(screen.getByText('You let go early, so nothing was erased.')).toBeVisible();
  });
});
