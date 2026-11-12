import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { formatMinute, MINUTE_MS } from '../app/time';
import { CheckMismatch, type HoldView } from '../recovery/holder';
import { axeViolations } from '../test/axe';
import { held, pastPressFallback } from '../test/press';
import { HelpRecover, type HelpRecoverProps } from './HelpRecover';

const CODE = `RR1.${'B'.repeat(64)}`;
const HELD = [
  { id: 'share-1', groupId: 'g1', groupName: 'Book Club', author: 'sam', name: 'Sam' },
  { id: 'share-2', groupId: 'g2', groupName: 'Allotment', author: 'kim', name: 'Kim' },
];
const UNTIL = Math.floor(Date.UTC(2025, 10, 13, 14, 5) / MINUTE_MS);

function renderHelp(overrides: Partial<HelpRecoverProps> = {}) {
  const props: HelpRecoverProps = {
    held: HELD,
    holds: [],
    onApprove: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  const view = render(<HelpRecover {...props} />);
  return { props, view };
}

/** Pastes the code and continues. */
async function enterCode(user: ReturnType<typeof userEvent.setup>, code = CODE) {
  await user.click(screen.getByRole('textbox', { name: messages.helpRecover.codeLabel }));
  await user.paste(code);
  await user.click(screen.getByRole('button', { name: messages.helpRecover.next }));
}

describe('HelpRecover', () => {
  it('takes the pasted code, asks which person, and passes axe at each step', async () => {
    renderHelp();
    expect(await axeViolations()).toEqual([]);
    const user = userEvent.setup();
    await enterCode(user, `Here it is: ${CODE} thanks`);

    const who = screen.getByRole('radiogroup', { name: messages.helpRecover.who });
    expect(within(who).map((radio) => radio.textContent)).toEqual([
      'Sam (Book Club)',
      'Kim (Allotment)',
    ]);
    expect(screen.getByText(/Call/).textContent).toBe(
      'Call Sam or meet them. Make sure it’s really them.',
    );
    // React Aria hides the input under its label, so the label takes the press.
    const [, kim] = within(who);
    if (kim === undefined) throw new Error('Expected Kim’s radio.');
    await user.click(kim);
    expect(screen.getByRole('radio', { name: 'Kim (Allotment)' })).toBeChecked();
    expect(screen.getByText(/Call/).textContent).toBe(
      'Call Kim or meet them. Make sure it’s really them.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses what isn’t a recovery code, without repeating it', async () => {
    renderHelp();
    await enterCode(userEvent.setup(), 'RL1.not-a-recovery-code');
    expect(await screen.findByText(messages.helpRecover.notACode)).toBeVisible();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('approves with the number read out, and says a wrong one doesn’t match', async () => {
    const onApprove = vi
      .fn<HelpRecoverProps['onApprove']>()
      .mockRejectedValueOnce(new CheckMismatch())
      .mockResolvedValueOnce();
    renderHelp({ onApprove });
    const user = userEvent.setup();
    await enterCode(user);
    const number = screen.getByRole('textbox', { name: messages.helpRecover.numberLabel });
    await user.type(number, '111 111');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(await screen.findByText(messages.helpRecover.wrongNumber)).toBeVisible();
    expect(onApprove).toHaveBeenLastCalledWith({
      code: CODE,
      groupId: 'g1',
      person: 'sam',
      check: '111 111',
    });

    await user.clear(number);
    await user.type(number, '304118');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: messages.helpRecover.another })).toBeVisible();
  });

  it('says when approving fails for another reason, and keeps the form', async () => {
    renderHelp({ onApprove: vi.fn(() => Promise.reject(new Error('offline'))) });
    const user = userEvent.setup();
    await enterCode(user);
    await user.type(
      screen.getByRole('textbox', { name: messages.helpRecover.numberLabel }),
      '304118',
    );
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(await screen.findByText(messages.helpRecover.failed)).toBeVisible();
    expect(screen.getByRole('button', { name: messages.helpRecover.approve })).toBeEnabled();
  });

  it('approves once when Approve is tapped again while it approves and that fails (#193)', async () => {
    const approving = held<undefined>();
    const onApprove = vi.fn<HelpRecoverProps['onApprove']>(() => approving.promise);
    renderHelp({ onApprove });
    const user = userEvent.setup();
    await enterCode(user);
    await user.type(
      screen.getByRole('textbox', { name: messages.helpRecover.numberLabel }),
      '304118',
    );
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(screen.getByRole('button', { name: messages.helpRecover.approve })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    approving.reject();
    expect(await screen.findByText(messages.helpRecover.failed)).toBeVisible();
    await pastPressFallback();

    expect(screen.getByRole('button', { name: messages.helpRecover.approve })).toBeEnabled();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('goes back to the code from the person and the number', async () => {
    renderHelp();
    const user = userEvent.setup();
    await enterCode(user);
    await user.click(screen.getByRole('button', { name: messages.helpRecover.back }));
    expect(screen.getByRole('textbox', { name: messages.helpRecover.codeLabel })).toBeVisible();
  });

  it('lists each hold by where it stands, names in <bdi>, and passes axe', async () => {
    const holds: HoldView[] = [
      { alert: 'a1', groupId: 'g1', name: 'Sam', status: { kind: 'holding', until: UNTIL } },
      { alert: 'a2', groupId: 'g1', name: 'Sam', status: { kind: 'soon' } },
      { alert: 'a3', groupId: 'g2', name: 'Kim', status: { kind: 'ready' } },
      { alert: 'a4', groupId: 'g2', name: 'Kim', status: { kind: 'sent' } },
      { alert: 'a5', groupId: 'g1', name: 'Sam', status: { kind: 'stopped' } },
    ];
    renderHelp({ holds });
    const list = screen.getByRole('list', { name: messages.helpRecover.heldHeading });
    expect([...list.querySelectorAll('li')].map((line) => line.textContent)).toEqual([
      `Holding Sam’s share until ${formatMinute(UNTIL)}. Open Reconcile after then to send it.`,
      'Holding Sam’s share. The 72 hours start once the relay has your approval.',
      'Kim’s share goes to their new device the next time Reconcile syncs.',
      'Kim’s share went to their new device.',
      'Sam’s share stays with you: this recovery was cancelled.',
    ]);
    expect(list.querySelector('bdi')?.textContent).toBe('Sam');
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when this device holds no share, and offers no form', async () => {
    renderHelp({ held: [] });
    expect(screen.getByText(messages.helpRecover.none)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

/** The radios in `group`, in order. */
function within(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('label')];
}
