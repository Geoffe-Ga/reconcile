import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { RecoverStep } from '../recovery/request';
import { axeViolations } from '../test/axe';
import { RecoverStart, type RecoverStartProps } from './RecoverStart';

const CODE = `RR1.${'A'.repeat(64)}`;
const SHOWN = { code: CODE, check: '304118' };

function renderStart(overrides: Partial<RecoverStartProps> = {}) {
  const props: RecoverStartProps = {
    start: vi.fn(() => Promise.resolve(SHOWN)),
    poll: vi.fn(() => Promise.resolve<RecoverStep>({ kind: 'waiting', shares: 0, needed: null })),
    onShare: vi.fn(() => Promise.resolve('copied' as const)),
    onRestored: vi.fn(),
    onStop: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  render(<RecoverStart {...props} />);
  return props;
}

describe('RecoverStart', () => {
  it('shows the code, Share, the check in two groups of three with the issue’s words, and passes axe', async () => {
    renderStart();
    expect(await screen.findByRole('textbox', { name: messages.recover.codeLabel })).toHaveValue(
      CODE,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Recover with your contacts',
    );
    expect(
      screen.getByText(
        'Send this code to your recovery contacts, then call them and read them this number.',
      ),
    ).toBeVisible();
    expect(screen.getByText('304 118')).toBeVisible();
    expect(await screen.findByText(messages.recover.waiting)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('shares the code, saying how it went', async () => {
    const props = renderStart();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: messages.recover.share }));
    expect(props.onShare).toHaveBeenCalledWith(CODE);
    expect(await screen.findByText(messages.recover.copied)).toBeVisible();
  });

  it('says how many shares have come, and hands over once the groups are back', async () => {
    const steps: RecoverStep[] = [
      { kind: 'waiting', shares: 1, needed: 2 },
      { kind: 'restored', groups: 2, skipped: 0, skippedDocuments: 0 },
    ];
    const poll = vi.fn(() => Promise.resolve(steps.shift() ?? { kind: 'stopped' as const }));
    const props = renderStart({ poll });
    expect(await screen.findByText('1 of 2 shares have arrived.')).toBeVisible();
    // The next look comes LINK_POLL_MS later.
    await waitFor(
      () => {
        expect(props.onRestored).toHaveBeenCalledOnce();
      },
      { timeout: 4000 },
    );
  });

  it('says when the relay is out of reach, and keeps the code', async () => {
    renderStart({ poll: vi.fn(() => Promise.reject(new TypeError('offline'))) });
    expect(await screen.findByText(messages.recover.unreachable)).toBeVisible();
    expect(screen.getByRole('textbox', { name: messages.recover.codeLabel })).toHaveValue(CODE);
  });

  it('stops on Stop recovering', async () => {
    const props = renderStart();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: messages.recover.stop }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it('polls only once the request is kept', async () => {
    let keep = (): void => undefined;
    const start = vi.fn(
      () =>
        new Promise<typeof SHOWN>((resolve) => {
          keep = () => {
            resolve(SHOWN);
          };
        }),
    );
    const props = renderStart({ start });
    await Promise.resolve();
    expect(props.poll).not.toHaveBeenCalled();
    keep();
    await waitFor(() => {
      expect(props.poll).toHaveBeenCalled();
    });
  });
});
