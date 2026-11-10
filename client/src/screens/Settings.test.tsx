import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { Settings, type SettingsProps } from './Settings';

function setup(props: Partial<SettingsProps> = {}) {
  const all: SettingsProps = {
    notify: {
      availability: 'ready',
      groups: [{ groupId: 'g1', name: 'Riverside Tenants', on: false }],
      onTurnOn: vi.fn(() => Promise.resolve('on' as const)),
      onTurnOff: vi.fn(() => Promise.resolve()),
    },
    hasGroups: true,
    onMake: vi.fn(() => Promise.reject(new Error('unused'))),
    onSave: vi.fn(() => Promise.resolve('downloaded' as const)),
    onRestore: vi.fn(() => Promise.resolve(1)),
    onErase: vi.fn(() => new Promise<void>(() => undefined)),
    relayBackup: { kind: 'off' },
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
    // Linking comes after the backup and before Erase, with Notifications (#99) first.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Notifications',
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

describe('Settings’ relay backup line (#97)', () => {
  // Tue 10 Nov 2026, 15:00 UTC: the same day in every time zone from UTC−9 to UTC+8.
  const AT = Date.UTC(2026, 10, 10, 15);

  it('says nothing of a relay backup while the device keeps none', () => {
    setup({ relayBackup: { kind: 'off' } });

    // Scoped to the backup: Notifications' disclosure speaks of the relay too (#99).
    const section = screen.getByRole('region', { name: 'Back up your groups' });
    expect(within(section).queryByText(/relay/)).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: 'saved', at: AT } as const, 'Backed up to the relay Tue 10 Nov.'],
    [
      { kind: 'too-large' } as const,
      'Your groups are too large for the relay backup. Save a backup file instead.',
    ],
    [
      { kind: 'waiting' } as const,
      'Your groups will be backed up to the relay the next time Reconcile syncs.',
    ],
  ])('says where the relay backup stands: %o', async (relayBackup, words) => {
    setup({ relayBackup });

    const section = screen.getByRole('region', { name: 'Back up your groups' });
    expect(within(section).getByText(words)).toHaveAttribute('role', 'status');
    expect(await axeViolations()).toEqual([]);
  });
});

describe('Settings › Notifications (#99)', () => {
  const notify = (overrides: Partial<SettingsProps['notify']> = {}): SettingsProps['notify'] => ({
    availability: 'ready',
    groups: [{ groupId: 'g1', name: 'Riverside Tenants', on: true }],
    onTurnOn: vi.fn(() => Promise.resolve('failed' as const)),
    onTurnOff: vi.fn(() => Promise.resolve()),
    ...overrides,
  });

  it('says a turn-on didn’t reach the relay, and that a turn-off failed', async () => {
    const off = notify({ onTurnOff: vi.fn(() => Promise.reject(new Error('closed'))) });
    const { user } = setup({ notify: off });

    await user.click(screen.getByRole('switch', { name: 'Notify me about Riverside Tenants' }));

    expect(
      await screen.findByText(
        'That didn’t reach the relay, so nothing changed. Try again when you’re online.',
      ),
    ).toBeVisible();
    expect(off.onTurnOff).toHaveBeenCalledWith('g1');
  });

  it('shows each group’s switch as the store holds it, and none for no groups', async () => {
    setup({ notify: notify({ groups: [] }) });

    expect(
      screen.getByText('Once you’re in a group, you can turn on its notifications here.'),
    ).toBeVisible();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('turns on through onTurnOn, holding the switch still until it answers', async () => {
    let answer: (outcome: 'failed') => void = () => undefined;
    const pending = notify({
      groups: [{ groupId: 'g1', name: 'Riverside Tenants', on: false }],
      onTurnOn: vi.fn(
        () =>
          new Promise<'failed'>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const { user } = setup({ notify: pending });
    const toggle = screen.getByRole('switch', { name: 'Notify me about Riverside Tenants' });

    await user.click(toggle);

    expect(pending.onTurnOn).toHaveBeenCalledWith('g1');
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    answer('failed');
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
  });
});
