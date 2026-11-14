import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { RecoverStep } from '../recovery/request';
import { axeViolations } from '../test/axe';
import { held, pastPressFallback } from '../test/press';
import { RecoverStart, type RecoverStartProps } from './RecoverStart';

const CODE = `RR1.${'A'.repeat(64)}`;
const SHOWN = { code: CODE, check: '304118', number: '966043' };
const WAITING: RecoverStep = { kind: 'waiting', shares: 0, needed: null, mismatched: 0 };
const FOUND: RecoverStep = { kind: 'found', groups: ['Riverside Tenants', 'سكن النهر'] };
const RESTORED: RecoverStep = { kind: 'restored', groups: 2, skipped: 0 };

function renderStart(overrides: Partial<RecoverStartProps> = {}) {
  const props: RecoverStartProps = {
    start: vi.fn(() => Promise.resolve(SHOWN)),
    poll: vi.fn(() => Promise.resolve(WAITING)),
    confirm: vi.fn(() => Promise.resolve(RESTORED)),
    decline: vi.fn(),
    onShare: vi.fn(() => Promise.resolve('copied' as const)),
    onRestored: vi.fn(),
    onStop: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  render(<RecoverStart {...props} />);
  return props;
}

describe('RecoverStart', () => {
  it('shows the code, Share, and both numbers in two groups of three with what to do, and passes axe', async () => {
    renderStart();
    expect(await screen.findByRole('textbox', { name: messages.recover.codeLabel })).toHaveValue(
      CODE,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Recover with your contacts',
    );
    expect(
      screen.getByText(
        'Send this code to your recovery contacts, then call them and read them both numbers.',
      ),
    ).toBeVisible();
    // The check, from the code, then the second number, from this device's key (#398).
    const numbers = screen.getAllByRole('definition').map((each) => each.textContent);
    expect(numbers).toEqual(['304 118', '966 043']);
    expect(screen.getAllByRole('term').map((each) => each.textContent)).toEqual([
      messages.recover.firstNumber,
      messages.recover.secondNumber,
    ]);
    expect(screen.getByText(messages.recover.numbersNote)).toBeVisible();
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

  it('says how many shares have come, asks about the groups found, and hands over on Yes', async () => {
    const steps: RecoverStep[] = [{ kind: 'waiting', shares: 1, needed: 2, mismatched: 0 }];
    const poll = vi.fn(() => Promise.resolve(steps.shift() ?? FOUND));
    const props = renderStart({ poll });
    expect(await screen.findByText('1 of 2 shares have arrived.')).toBeVisible();
    // The next look comes LINK_POLL_MS later.
    const yes = await screen.findByRole(
      'button',
      { name: messages.recover.yes },
      { timeout: 4000 },
    );
    expect(props.onRestored).not.toHaveBeenCalled();
    await userEvent.setup().click(yes);
    expect(props.confirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(props.onRestored).toHaveBeenCalledOnce();
    });
    expect(props.decline).not.toHaveBeenCalled();
  });

  it('hands over once another look finds the groups back, as another tab would', async () => {
    const props = renderStart({ poll: vi.fn(() => Promise.resolve(RESTORED)) });
    await waitFor(() => {
      expect(props.onRestored).toHaveBeenCalledOnce();
    });
  });

  it('says when shares came with a different second number (#398)', async () => {
    const steps: RecoverStep[] = [{ kind: 'waiting', shares: 1, needed: 2, mismatched: 1 }];
    renderStart({ poll: vi.fn(() => Promise.resolve(steps.shift() ?? WAITING)) });
    expect(await screen.findByText(messages.recover.mismatched(1))).toBeVisible();
    expect(messages.recover.mismatched(1)).toMatch(/^A share came with a different second number/);
    expect(messages.recover.mismatched(3)).toMatch(/^3 shares came with a different second number/);
    expect(await axeViolations()).toEqual([]);
  });

  it('asks “Are these your groups?” with each name in <bdi>, in place of the code, and passes axe', async () => {
    renderStart({ poll: vi.fn(() => Promise.resolve(FOUND)) });
    const question = await screen.findByRole('region', { name: messages.recover.foundHeading });
    expect(within(question).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Are these your groups?',
    );
    const names = within(question).getByRole('list');
    expect([...names.querySelectorAll('li > bdi')].map((name) => name.textContent)).toEqual([
      'Riverside Tenants',
      'سكن النهر',
    ]);
    expect(within(question).getByRole('button', { name: messages.recover.yes })).toHaveClass(
      'button-primary',
    );
    expect(within(question).getByRole('button', { name: messages.recover.no })).toHaveClass(
      'button-secondary',
    );
    // While it asks, the code and its Share, the screen's other primary action, step aside.
    expect(screen.queryByRole('textbox', { name: messages.recover.codeLabel })).toBeNull();
    expect(screen.queryByRole('button', { name: messages.recover.share })).toBeNull();
    expect(screen.getByRole('button', { name: messages.recover.stop })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a backup with no groups holds none', async () => {
    renderStart({ poll: vi.fn(() => Promise.resolve<RecoverStep>({ kind: 'found', groups: [] })) });
    expect(await screen.findByText(messages.recover.foundNone)).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('on No restores nothing, says what to do next, shows the code again and keeps waiting', async () => {
    const steps: RecoverStep[] = [FOUND];
    const poll = vi.fn(() => Promise.resolve(steps.shift() ?? WAITING));
    const props = renderStart({ poll });
    await userEvent.setup().click(await screen.findByRole('button', { name: messages.recover.no }));
    expect(props.decline).toHaveBeenCalledOnce();
    expect(props.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(messages.recover.declined)).toBeVisible();
    expect(screen.queryByRole('region', { name: messages.recover.foundHeading })).toBeNull();
    expect(screen.getByRole('textbox', { name: messages.recover.codeLabel })).toHaveValue(CODE);
    expect(await axeViolations()).toEqual([]);
    // It keeps looking: the next look waits as before.
    await waitFor(
      () => {
        expect(poll).toHaveBeenCalledTimes(2);
      },
      { timeout: 4000 },
    );
    expect(screen.getByText(messages.recover.waiting)).toBeVisible();
    expect(props.onRestored).not.toHaveBeenCalled();
  });

  it('asks again about another backup found after a No', async () => {
    const other: RecoverStep = { kind: 'found', groups: ['Allotment'] };
    const steps: RecoverStep[] = [FOUND];
    renderStart({ poll: vi.fn(() => Promise.resolve(steps.shift() ?? other)) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: messages.recover.no }));
    const question = await screen.findByRole(
      'region',
      { name: messages.recover.foundHeading },
      { timeout: 4000 },
    );
    expect(within(question).getByRole('list')).toHaveTextContent('Allotment');
  });

  it('says when Yes couldn’t restore, and asks again; Yes goes once while it restores', async () => {
    const restoring = held<RecoverStep>();
    const confirm = vi
      .fn<RecoverStartProps['confirm']>()
      .mockImplementationOnce(() => restoring.promise)
      .mockResolvedValueOnce(RESTORED);
    const props = renderStart({ poll: vi.fn(() => Promise.resolve(FOUND)), confirm });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: messages.recover.yes }));
    expect(screen.getByRole('button', { name: messages.recover.yes })).toBeDisabled();
    expect(screen.getByRole('button', { name: messages.recover.no })).toBeDisabled();
    expect(screen.getByText(messages.recover.restoring)).toBeVisible();
    await user.click(screen.getByRole('button', { name: messages.recover.yes }));
    restoring.reject();
    expect(await screen.findByText(messages.recover.restoreFailed)).toBeVisible();
    await pastPressFallback();
    expect(confirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: messages.recover.yes }));
    await waitFor(() => {
      expect(props.onRestored).toHaveBeenCalledOnce();
    });
  });

  it('goes back to waiting when Yes finds the backup no longer reads', async () => {
    const props = renderStart({
      poll: vi.fn(() => Promise.resolve(FOUND)),
      confirm: vi.fn(() => Promise.resolve(WAITING)),
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: messages.recover.yes }));
    expect(await screen.findByRole('textbox', { name: messages.recover.codeLabel })).toHaveValue(
      CODE,
    );
    expect(screen.queryByText(messages.recover.declined)).toBeNull();
    expect(props.onRestored).not.toHaveBeenCalled();
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
