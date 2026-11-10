import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { axeViolations } from '../test/axe';
import { Settings, type SettingsProps } from './Settings';

function setup(props: Partial<SettingsProps> = {}) {
  const all: SettingsProps = {
    hasGroups: true,
    onMake: vi.fn(() => Promise.reject(new Error('unused'))),
    onSave: vi.fn(() => Promise.resolve('downloaded' as const)),
    onRestore: vi.fn(() => Promise.resolve(1)),
    onErase: vi.fn(() => new Promise<void>(() => undefined)),
    passkey: {
      state: 'offered',
      onCreate: vi.fn(() => Promise.resolve(Uint8Array.of(1))),
      onProtect: vi.fn(() => Promise.resolve('protected' as const)),
    },
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

  it('offers a passkey, saying the phone asks twice, and keeps the result in place of the offer', async () => {
    const { user } = setup();
    const section = screen.getByRole('region', { name: 'Lock with a passkey' });
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-labelledby'));
    const names = regions.map((id) => document.getElementById(id ?? '')?.textContent);
    expect(names).toEqual([
      'Back up your groups',
      'Restore a backup',
      'Lock with a passkey',
      'Erase this device',
    ]);
    for (const line of [messages.passkey.lede, messages.passkey.twice, messages.passkey.privacy]) {
      expect(within(section).getByText(line)).toBeVisible();
    }
    expect(await axeViolations()).toEqual([]);

    const make = within(section).getByRole('button', { name: 'Make a passkey' });
    // Settings' one primary action is Make a backup file (DESIGN.md).
    expect(make).toHaveClass('button-secondary');
    await user.click(make);
    await user.click(await within(section).findByRole('button', { name: 'Confirm your passkey' }));

    expect(await within(section).findByText(messages.passkey.locked)).toBeVisible();
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });

  it('says the keys are locked with a passkey, offering nothing to turn it off', async () => {
    setup({ passkey: { state: 'locked', onCreate: vi.fn(), onProtect: vi.fn() } });
    const section = screen.getByRole('region', { name: 'Lock with a passkey' });

    expect(section).toHaveTextContent(messages.passkey.locked);
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('says plainly where a passkey can’t protect the keys, offering no setup', async () => {
    setup({ passkey: { state: 'unavailable', onCreate: vi.fn(), onProtect: vi.fn() } });
    const section = screen.getByRole('region', { name: 'Lock with a passkey' });

    expect(section).toHaveTextContent(
      'This device’s passkey can’t protect your keys, so they stay on this device as before.',
    );
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
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
