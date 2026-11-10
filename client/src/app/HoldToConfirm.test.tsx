import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { HoldToConfirm } from './HoldToConfirm';
import { messages } from './messages';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const RELEASED = 'You let go early, so nothing was erased.';
const BUSY = 'Erasing…';

/**
 * A mouse, a key and a clock, as events a browser sends: Testing Library's
 * async wrapper waits on a timer Vitest's fake clock never fires, so these
 * dispatch events directly. A mouse release sends `click` after `pointerup`,
 * which is when React Aria ends the press.
 */
function input(button: HTMLElement) {
  const pointer = { pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true };
  return {
    press: () => {
      fireEvent.pointerDown(button, pointer);
      fireEvent.mouseDown(button);
    },
    release: () => {
      fireEvent.pointerUp(button, pointer);
      fireEvent.mouseUp(button);
      fireEvent.click(button);
    },
    keyDown: (key: string) => {
      act(() => {
        button.focus();
      });
      fireEvent.keyDown(button, { key });
    },
    keyUp: (key: string) => {
      fireEvent.keyUp(button, { key });
    },
  };
}

function renderHold(onConfirm = vi.fn(() => new Promise<void>(() => undefined))) {
  document.title = 'Settings · Reconcile';
  render(
    <main>
      <h1>Settings</h1>
      <HoldToConfirm
        label="Hold to erase"
        released={RELEASED}
        busy={BUSY}
        failed="It didn’t finish."
        onConfirm={onConfirm}
      />
    </main>,
  );
  const button = screen.getByRole('button', { name: 'Hold to erase' });
  return { ...input(button), button, onConfirm };
}

/**
 * Moves the clock on by `ms`, 100 ms at a time, letting React render and run
 * its effects between steps as a browser would: each second of the hold is a
 * timer its last render set.
 */
async function wait(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(100, left));
    });
  }
}

const status = () => screen.getByRole('status');

describe('HoldToConfirm', () => {
  it('erases nothing when released at 2.9 seconds, and says so in a polite live region', async () => {
    const { press, release, onConfirm } = renderHold();

    press();
    await wait(2_900);
    release();
    await wait(1_000);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(RELEASED);
    expect(status()).not.toHaveAttribute('aria-live', 'assertive');
  });

  it('confirms once after a 3-second hold by pointer, counting down as it goes', async () => {
    const { press, release, button, onConfirm } = renderHold();

    press();
    expect(status()).toHaveTextContent('Keep holding: 3 seconds left.');
    await wait(1_000);
    expect(status()).toHaveTextContent('Keep holding: 2 seconds left.');
    await wait(1_000);
    expect(status()).toHaveTextContent('Keep holding: 1 second left.');
    await wait(1_000);

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(status()).toHaveTextContent(BUSY);
    release();
    press();
    release();
    await wait(4_000);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
  });

  it.each([
    ['Space', ' '],
    ['Enter', 'Enter'],
  ])(
    'confirms after holding %s for 3 seconds, and not when it’s let go sooner',
    async (_name, key) => {
      const { keyDown, keyUp, onConfirm } = renderHold();

      keyDown(key);
      await wait(2_000);
      keyUp(key);
      await wait(2_000);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(status()).toHaveTextContent(RELEASED);

      keyDown(key);
      // A held key repeats; a repeat is no new press, so the count runs on.
      await wait(1_500);
      fireEvent.keyDown(document.activeElement ?? document.body, { key, repeat: true });
      await wait(1_500);
      expect(onConfirm).toHaveBeenCalledOnce();
    },
  );

  it('starts over from 3 seconds after a release', async () => {
    const { press, release, onConfirm } = renderHold();

    press();
    await wait(2_000);
    release();
    press();
    await wait(2_000);
    expect(onConfirm).not.toHaveBeenCalled();
    await wait(1_000);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('says what failed, and can be held again, when confirming rejects', async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error('No.')));
    const { press, release, button } = renderHold(onConfirm);

    press();
    await wait(3_000);
    release();

    expect(screen.getByRole('alert')).toHaveTextContent('It didn’t finish.');
    expect(button).toBeEnabled();
    press();
    await wait(3_000);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('describes how to hold it, by pointer or keyboard, and passes axe', async () => {
    const { button } = renderHold();

    expect(button).toHaveAccessibleDescription(messages.hold.hint(3));
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
  });
});
