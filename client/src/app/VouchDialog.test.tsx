import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { VouchDialog } from './VouchDialog';

type OnVouch = () => Promise<void>;

const CHAT = 'https://chat.example.org/riverside';

/** How long React Aria's usePress waits for a click before clicking a pressed button itself. */
const PRESS_FALLBACK_MS = 80;

function setup(onVouch = vi.fn<OnVouch>(() => Promise.resolve()), chat: string | null = CHAT) {
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <VouchDialog name="Kim" chat={chat} onVouch={onVouch} />
    </main>,
  );
  return { user: userEvent.setup(), onVouch };
}

/** Opens the dialog from its Vouch for Kim button. */
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Vouch for Kim' }));
  return screen.getByRole('dialog', { name: 'Vouch for Kim?' });
}

describe('VouchDialog', () => {
  it('opens from Vouch for Kim, asks to meet first, says everyone sees it, and keeps focus inside', async () => {
    const { user } = setup();
    const dialog = await open(user);
    expect(dialog).toHaveTextContent(
      'Vouch only for someone you’ve met or talked with, on a call or in person. Everyone in the group sees your vouch.',
    );
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(await axeViolations()).toEqual([]);
  });

  it('puts the group’s chat beside that line, then Vouch and Cancel', async () => {
    const { user } = setup();
    const dialog = await open(user);
    const chat = within(dialog).getByRole('link', { name: /Join discussion/ });
    expect(chat).toHaveAttribute('href', CHAT);
    expect(chat).toHaveAttribute('target', '_blank');
    const controls = [...dialog.querySelectorAll('a, button')].map(
      (element) => element.textContent,
    );
    expect(controls).toEqual([expect.stringContaining('Join discussion'), 'Vouch', 'Cancel']);
  });

  it('leaves out the chat when the group has none', async () => {
    const { user } = setup(undefined, null);
    const dialog = await open(user);
    expect(within(dialog).queryByRole('link')).toBeNull();
  });

  it('queues one vouch, then closes', async () => {
    const { user, onVouch } = setup();
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Vouch' }));
    expect(onVouch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Cancel and on Escape without vouching', async () => {
    const { user, onVouch } = setup();
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await open(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onVouch).not.toHaveBeenCalled();
  });

  it('queues one vouch however often Vouch is pressed while it saves, even when saving fails (#192)', async () => {
    let fail: () => void = () => undefined;
    const onVouch = vi.fn<OnVouch>(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => {
            reject(new Error('full'));
          };
        }),
    );
    const { user } = setup(onVouch);
    const dialog = await open(user);
    const vouch = within(dialog).getByRole('button', { name: 'Vouch' });
    await user.click(vouch);
    expect(vouch).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(vouch);
    fail();
    expect(await screen.findByRole('alert')).toBeVisible();
    // usePress clicks a button itself when a press on it gets no click within 80 ms, so a
    // press on the disabled button would send once it re-enables (#190, #192).
    await act(() => new Promise((resolve) => setTimeout(resolve, PRESS_FALLBACK_MS + 20)));
    expect(vouch).toBeEnabled();
    expect(onVouch).toHaveBeenCalledTimes(1);
  });

  it('stays open and says so when the vouch can’t be saved', async () => {
    const { user } = setup(vi.fn<OnVouch>(() => Promise.reject(new Error('full'))));
    const dialog = await open(user);
    await user.click(screen.getByRole('button', { name: 'Vouch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your vouch couldn’t be saved on this device. Try again.',
    );
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Vouch' })).toBeEnabled();
  });
});
