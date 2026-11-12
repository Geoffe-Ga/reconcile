import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { messages } from './messages';
import { RecoveryAlert } from './RecoveryAlert';
import { formatDay, MINUTE_MS } from './time';

/** A relay minute on Thu 13 Nov 2025, as the issue's example has it. */
const COMPLETES = Math.floor(Date.UTC(2025, 10, 13, 14, 5) / MINUTE_MS);

function page(children: React.ReactNode) {
  document.title = 'Your groups · Reconcile';
  return render(
    <main>
      <h1>Your groups</h1>
      {children}
    </main>,
  );
}

describe('RecoveryAlert', () => {
  it('says what happened in the issue’s words, with the day it completes, and passes axe', async () => {
    page(
      <RecoveryAlert
        summary={{ kind: 'pending', completes: COMPLETES }}
        onCancel={() => Promise.resolve()}
      />,
    );
    const day = formatDay(COMPLETES * MINUTE_MS);
    expect(day).toMatch(/13 Nov/);
    expect(
      screen.getByText(
        `Someone asked your recovery contacts to restore your Reconcile on a new device. If this wasn’t you, cancel now. It completes ${day}.`,
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel this recovery' })).toBeEnabled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('cancels on a press, saying so while it goes, and shows nothing more once the summary says cancelled', async () => {
    let finish = (): void => undefined;
    const onCancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = page(
      <RecoveryAlert summary={{ kind: 'pending', completes: COMPLETES }} onCancel={onCancel} />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel this recovery' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent(messages.recoveryAlert.cancelling);
    expect(screen.getByRole('button', { name: 'Cancel this recovery' })).toBeDisabled();
    finish();

    rerender(
      <main>
        <h1>Your groups</h1>
        <RecoveryAlert summary={{ kind: 'cancelled' }} onCancel={onCancel} />
      </main>,
    );
    expect(await screen.findByText(messages.recoveryAlert.cancelled)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps Cancel when cancelling fails, and says so', async () => {
    const onCancel = vi.fn(() => Promise.reject(new Error('offline')));
    page(<RecoveryAlert summary={{ kind: 'pending', completes: COMPLETES }} onCancel={onCancel} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel this recovery' }));
    expect(await screen.findByText(messages.recoveryAlert.failed)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel this recovery' })).toBeEnabled();
  });

  it('shows nothing without an alert', () => {
    const { container } = render(
      <RecoveryAlert summary={null} onCancel={() => Promise.resolve()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
