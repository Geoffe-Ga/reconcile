/**
 * The passkey offer (#95): once after the pilot notice, with Not now, and a
 * Continue once setup has ended.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { Passkey, Protection } from '../app/passkey';
import { axeViolations } from '../test/axe';
import { PasskeyOffer } from './PasskeyOffer';

function setup(protection: Protection = 'protected') {
  const create = vi.fn(() => Promise.resolve(Uint8Array.of(1)));
  const passkey: Passkey = {
    available: true,
    isProtected: vi.fn(() => Promise.resolve(false)),
    create,
    protect: vi.fn(() => Promise.resolve(protection)),
  };
  const onDone = vi.fn();
  render(<PasskeyOffer passkey={passkey} onDone={onDone} />);
  return { user: userEvent.setup(), create, onDone };
}

const { passkey: words } = messages;

describe('PasskeyOffer', () => {
  it('says what a passkey does, that the phone asks twice, and what the password manager sees', async () => {
    setup();

    expect(screen.getByRole('heading', { level: 1, name: words.title })).toHaveFocus();
    expect(document.title).toBe('Lock with a passkey · Reconcile');
    for (const line of [words.lede, words.twice, words.privacy]) {
      expect(screen.getByText(line)).toBeVisible();
    }
    expect(screen.getByRole('button', { name: words.create })).toHaveClass('button-primary');
    expect(screen.getByRole('button', { name: words.notNow })).toHaveClass('button-quiet');
    expect(await axeViolations()).toEqual([]);
  });

  it('closes on Not now, making nothing', async () => {
    const { user, create, onDone } = setup();

    await user.click(screen.getByRole('button', { name: words.notNow }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('offers Continue, the one primary button left, once the keys are locked', async () => {
    const { user, onDone } = setup();

    await user.click(screen.getByRole('button', { name: words.create }));
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

    await user.click(screen.getByRole('button', { name: words.create }));
    await user.click(await screen.findByRole('button', { name: words.confirm }));
    const link = await screen.findByRole('link', { name: words.saveBackup });

    expect(screen.getByText(words.noPrf)).toBeVisible();
    expect(link).toHaveAttribute('href', '#/settings');
    expect(await axeViolations()).toEqual([]);
    await user.click(link);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
