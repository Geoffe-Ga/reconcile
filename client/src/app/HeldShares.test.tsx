import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { HeldShareCard, HeldShares } from './HeldShares';

const HELD = [
  { id: 'share-1', groupId: 'g1', groupName: 'Riverside Tenants', author: 'ana', name: 'Ana' },
  { id: 'share-2', groupId: 'g2', groupName: 'Allotment', author: 'kim', name: 'Kim · 4f2a' },
];

describe('HeldShares', () => {
  it('lists each share as "You’re holding a recovery share for <name> (<group>)", names in <bdi>', () => {
    render(
      <main>
        <HeldShares held={HELD} />
      </main>,
    );

    const lines = screen.getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      'You’re holding a recovery share for Ana (Riverside Tenants)',
      'You’re holding a recovery share for Kim · 4f2a (Allotment)',
    ]);
    expect(screen.getByText('Kim · 4f2a').tagName).toBe('BDI');
    expect(screen.getByText('Allotment').tagName).toBe('BDI');
  });

  it('shows nothing for none', () => {
    const { container } = render(<HeldShares held={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('HeldShareCard', () => {
  it('is a quiet card with the same lines and OK, which puts them away, and passes axe', async () => {
    const onDismiss = vi.fn(() => Promise.resolve());
    document.title = 'Your group · Reconcile';
    render(
      <main>
        <h1>Riverside Tenants</h1>
        <HeldShareCard held={HELD.slice(0, 1)} onDismiss={onDismiss} />
      </main>,
    );

    expect(screen.getByRole('listitem')).toHaveTextContent(
      'You’re holding a recovery share for Ana (Riverside Tenants)',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'OK' }));
    expect(onDismiss).toHaveBeenCalledWith(['share-1']);
  });

  it('keeps the card when putting it away fails, so OK can be pressed again', async () => {
    const onDismiss = vi.fn(() => Promise.reject(new Error('blocked')));
    render(<HeldShareCard held={HELD} onDismiss={onDismiss} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'OK' }));
    expect(onDismiss).toHaveBeenCalledWith(['share-1', 'share-2']);
    expect(screen.getByRole('button', { name: 'OK' })).toBeVisible();
  });

  it('shows nothing for none', () => {
    const { container } = render(<HeldShareCard held={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
