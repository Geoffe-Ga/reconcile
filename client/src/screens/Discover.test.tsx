/**
 * Discover (#423; ADR-0077 §6, DESIGN.md "Discover"): the eyebrow and heading,
 * one empty-state sentence, and "Open a card or link", which reads an invite,
 * a reconcile card, a follow link or a front door link, as Start does, and
 * hands each to its own handler.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { inviteLink } from '../app/invite';
import { cardLink } from '../coalition/card';
import { followLink } from '../coalition/follow';
import { newInviteSeed } from '../crypto/invite';
import { axeViolations } from '../test/axe';
import { Discover } from './Discover';

const ORIGIN = 'https://reconcile.example';
const ADDRESS = `${'A'.repeat(42)}E`;

/** Discover with a spy for each kind of link. */
function setup() {
  const open = {
    onOpenInvite: vi.fn(),
    onOpenCard: vi.fn(),
    onOpenFollow: vi.fn(),
    onOpenDoor: vi.fn(),
  };
  render(<Discover feed={[]} {...open} />);
  return { user: userEvent.setup(), open };
}

/** Pastes `text` into the field and presses Open. */
async function paste(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Card or link' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Open' }));
}

describe('Discover', () => {
  it('shows the eyebrow, the heading, one empty-state sentence and the field, with Open its one primary action', async () => {
    setup();

    expect(screen.getByText('Reconcile', { selector: '.eyebrow' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Discover' })).toHaveFocus();
    expect(document.title).toBe('Discover · Reconcile');
    expect(
      screen.getByText(
        'Dispatches from your groups, and from the coalitions you’re in or follow, show up here.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Open a card or link' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Card or link' })).toHaveAccessibleDescription(
      'Paste an invite link, a reconcile card, a coalition’s follow link or a group’s front door link.',
    );
    expect(screen.getByRole('button', { name: 'Open' })).toHaveClass('button-primary');
    expect(await axeViolations()).toEqual([]);
  });

  it('opens a pasted reconcile card by its seed, and nothing else from it', async () => {
    const { user, open } = setup();
    const seed = newInviteSeed();

    await paste(user, ` ${cardLink(ORIGIN, seed)}\n`);

    expect(open.onOpenCard).toHaveBeenCalledTimes(1);
    expect(Array.from(open.onOpenCard.mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(seed));
    expect(open.onOpenInvite).not.toHaveBeenCalled();
    expect(open.onOpenFollow).not.toHaveBeenCalled();
    expect(open.onOpenDoor).not.toHaveBeenCalled();
  });

  it.each([
    ['an invite', 'onOpenInvite', (seed: Uint8Array) => inviteLink(ORIGIN, seed)],
    ['a follow link', 'onOpenFollow', (seed: Uint8Array) => followLink(ORIGIN, seed)],
  ] as const)('opens %s by its seed, as Start does', async (_kind, handler, link) => {
    const { user, open } = setup();
    const seed = newInviteSeed();

    await paste(user, link(seed));

    expect(open[handler]).toHaveBeenCalledTimes(1);
    expect(Array.from(open[handler].mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(seed));
  });

  it('opens a front door link, from any origin, by its address', async () => {
    const { user, open } = setup();

    await paste(user, `https://elsewhere.example/#door/${ADDRESS}`);

    expect(open.onOpenDoor).toHaveBeenCalledWith(ADDRESS);
    expect(open.onOpenInvite).not.toHaveBeenCalled();
  });

  it('says plainly it can’t open anything else, without repeating it back', async () => {
    const { user, open } = setup();

    await paste(user, 'https://example.org/#/join/not-a-real-payload');

    const field = screen.getByRole('textbox', { name: 'Card or link' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(
      'Paste an invite link, a reconcile card, a coalition’s follow link or a group’s front door link. This isn’t a link Reconcile can open. Check you copied all of it.',
    );
    expect(document.body).not.toHaveTextContent('not-a-real-payload');
    for (const handler of Object.values(open)) expect(handler).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('never reads the clipboard on its own', async () => {
    const { user } = setup();
    const readText = vi.spyOn(navigator.clipboard, 'readText');
    const read = vi.spyOn(navigator.clipboard, 'read');

    await user.click(screen.getByRole('textbox', { name: 'Card or link' }));
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(readText).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
