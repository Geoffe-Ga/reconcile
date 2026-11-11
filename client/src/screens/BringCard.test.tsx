import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardLookup, FoundCard } from '../app/reconcile';
import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { axeViolations } from '../test/axe';
import { BringCard, type BringCardProps } from './BringCard';

const SEED = new Uint8Array(32).fill(7);
const PAYLOAD = base64url(SEED);

const FOUND: FoundCard = {
  card: {
    secret: new Uint8Array(32).fill(1),
    inner: new Uint8Array(32).fill(2),
    seat: { name: 'Riverside Tenants', key: base64url(new Uint8Array(32).fill(3)) },
    name: 'Eastside Housing',
    title: 'Mission statement',
    atoms: ['Everyone has a **home**.', 'We meet monthly.'],
    entries: [],
  },
  mode: 'found',
  log: { records: [], cursor: 0, relayNow: 29_000_000, instance: 'i' },
  groups: [
    { groupId: 'oak', name: 'Oak St Co-op' },
    { groupId: 'elm', name: 'Elm Row' },
  ],
};

function props(overrides: Partial<BringCardProps> = {}): BringCardProps {
  return {
    payload: PAYLOAD,
    heldSeed: null,
    lookup: vi.fn(() => Promise.resolve<CardLookup>({ kind: 'found', found: FOUND })),
    onBring: vi.fn(() => Promise.resolve(true)),
    onNotNow: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

describe('BringCard', () => {
  it('shows the card as plain text and brings it to the group picked, under a name', async () => {
    const user = userEvent.setup();
    const onBring = vi.fn(() => Promise.resolve(true));
    window.history.replaceState(null, '', `#reconcile/${PAYLOAD}`);
    render(<BringCard {...props({ onBring })} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' }),
    ).toBeVisible();
    expect(window.location.hash).toBe('#/card');
    expect(screen.getByText('Everyone has a **home**.')).toBeVisible();
    expect(screen.getByText(/^From/)).toHaveTextContent('From Riverside Tenants');
    expect(screen.queryByText(messages.bring.admitLede)).not.toBeInTheDocument();
    const picker = screen.getByRole('radiogroup', { name: 'Your group' });
    expect(within(picker).getByRole('radio', { name: 'Oak St Co-op' })).toBeChecked();
    expect(await axeViolations()).toEqual([]);
    await user.click(within(picker).getByRole('radio', { name: 'Elm Row' }));
    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));
    expect(onBring).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), ' Cy ');
    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));

    expect(onBring).toHaveBeenCalledWith(FOUND, 'elm', 'Cy');
  });

  it('says bringing didn’t finish, and lets the person try again', async () => {
    const user = userEvent.setup();
    const onBring = vi
      .fn<BringCardProps['onBring']>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('closed'))
      .mockResolvedValue(true);
    render(<BringCard {...props({ onBring })} />);
    await user.type(
      await screen.findByRole('textbox', { name: 'Your name in the coalition' }),
      'Cy',
    );

    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.bring.failed);
    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.bring.failed);
    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));
    expect(onBring).toHaveBeenCalledTimes(3);
  });

  it('says a card from a formed coalition admits the group, and Not now drops it', async () => {
    const user = userEvent.setup();
    const onNotNow = vi.fn();
    const lookup = vi.fn(() =>
      Promise.resolve<CardLookup>({ kind: 'found', found: { ...FOUND, mode: 'admit' } }),
    );
    render(<BringCard {...props({ lookup, onNotNow })} />);

    expect(await screen.findByText(messages.bring.admitLede)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it('says when no group on this device can take the card', async () => {
    const user = userEvent.setup();
    const onNotNow = vi.fn();
    const lookup = vi.fn(() =>
      Promise.resolve<CardLookup>({ kind: 'found', found: { ...FOUND, groups: [] } }),
    );
    render(<BringCard {...props({ lookup, onNotNow })} />);

    expect(await screen.findByText(messages.bring.noGroups)).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', messages.bring.badLinkTitle, messages.bring.badLink],
    ['used', messages.bring.usedTitle, messages.bring.used],
  ] as const)('shows the %s line', async (kind, title, line) => {
    render(<BringCard {...props({ lookup: () => Promise.resolve({ kind }) })} />);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.getByText(line)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Try again while the relay can’t be reached, and reads the card again', async () => {
    const user = userEvent.setup();
    const lookup = vi
      .fn<BringCardProps['lookup']>()
      .mockResolvedValueOnce({ kind: 'offline' })
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ kind: 'found', found: FOUND });
    render(<BringCard {...props({ lookup })} />);

    expect(await screen.findByText(messages.bring.offline)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(messages.bring.offline)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('reads a seed held in memory when the address bar has none, and none at all as damaged', async () => {
    const lookup = vi.fn(() => Promise.resolve<CardLookup>({ kind: 'found', found: FOUND }));
    const { unmount } = render(<BringCard {...props({ payload: null, heldSeed: SEED, lookup })} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledWith(SEED);
    unmount();

    render(<BringCard {...props({ payload: null, heldSeed: null, lookup })} />);
    expect(screen.getByText(messages.bring.badLink)).toBeVisible();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('opens a new card that arrives while one shows', async () => {
    const lookup = vi.fn(() => Promise.resolve<CardLookup>({ kind: 'used' }));
    const { rerender } = render(<BringCard {...props({ lookup })} />);
    expect(await screen.findByText(messages.bring.used)).toBeVisible();

    const other = base64url(new Uint8Array(32).fill(9));
    rerender(<BringCard {...props({ lookup, payload: other })} />);
    expect(await screen.findByText(messages.bring.used)).toBeVisible();
    expect(lookup).toHaveBeenLastCalledWith(new Uint8Array(32).fill(9));
  });
});
