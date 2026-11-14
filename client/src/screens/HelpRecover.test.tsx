import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { formatMinute, MINUTE_MS } from '../app/time';
import { CheckMismatch, type HoldView, SecondNumberInvalid } from '../recovery/holder';
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
    onResend: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  const view = render(<HelpRecover {...props} />);
  return { props, view };
}

/** A hold as `holdViews` gives it, with neither number nor resend unless named. */
function hold(view: Pick<HoldView, 'alert' | 'groupId' | 'name' | 'status'> & Partial<HoldView>) {
  return { number: null, resend: false, ...view };
}

/** Types the first and second numbers into the approval form. */
async function typeNumbers(
  user: ReturnType<typeof userEvent.setup>,
  check: string,
  second: string,
) {
  await user.type(screen.getByRole('textbox', { name: messages.helpRecover.numberLabel }), check);
  await user.type(screen.getByRole('textbox', { name: messages.helpRecover.secondLabel }), second);
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

  it('approves with both numbers read out, and says a wrong first one doesn’t match', async () => {
    const onApprove = vi
      .fn<HelpRecoverProps['onApprove']>()
      .mockRejectedValueOnce(new CheckMismatch())
      .mockResolvedValueOnce();
    renderHelp({ onApprove });
    const user = userEvent.setup();
    await enterCode(user);
    const number = screen.getByRole('textbox', { name: messages.helpRecover.numberLabel });
    await typeNumbers(user, '111 111', '966 043');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(await screen.findByText(messages.helpRecover.wrongNumber)).toBeVisible();
    expect(onApprove).toHaveBeenLastCalledWith({
      code: CODE,
      groupId: 'g1',
      person: 'sam',
      check: '111 111',
      number: '966 043',
    });
    expect(
      screen.getByRole('textbox', { name: messages.helpRecover.secondLabel }),
    ).toHaveAccessibleDescription(messages.helpRecover.secondHint);

    await user.clear(number);
    await user.type(number, '304118');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(onApprove).toHaveBeenLastCalledWith(expect.objectContaining({ check: '304118' }));
    expect(await screen.findByRole('button', { name: messages.helpRecover.another })).toBeVisible();
  });

  it('says when the second number isn’t six digits (#398)', async () => {
    renderHelp({ onApprove: vi.fn(() => Promise.reject(new SecondNumberInvalid())) });
    const user = userEvent.setup();
    await enterCode(user);
    await typeNumbers(user, '304118', '96604');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.approve }));
    expect(await screen.findByText(messages.helpRecover.badSecond)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says when approving fails for another reason, and keeps the form', async () => {
    renderHelp({ onApprove: vi.fn(() => Promise.reject(new Error('offline'))) });
    const user = userEvent.setup();
    await enterCode(user);
    await typeNumbers(user, '304118', '966043');
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
    await typeNumbers(user, '304118', '966043');
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
      hold({ alert: 'a1', groupId: 'g1', name: 'Sam', status: { kind: 'holding', until: UNTIL } }),
      hold({ alert: 'a2', groupId: 'g1', name: 'Sam', status: { kind: 'soon' } }),
      hold({ alert: 'a3', groupId: 'g2', name: 'Kim', status: { kind: 'ready' } }),
      hold({ alert: 'a4', groupId: 'g2', name: 'Kim', status: { kind: 'sent' } }),
      hold({ alert: 'a5', groupId: 'g1', name: 'Sam', status: { kind: 'stopped' } }),
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

  it('names the second number a share went with, and sends it again with another (#398)', async () => {
    const onResend = vi
      .fn<HelpRecoverProps['onResend']>()
      .mockRejectedValueOnce(new SecondNumberInvalid())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce();
    const sent = hold({
      alert: 'a4',
      groupId: 'g2',
      name: 'Kim',
      status: { kind: 'sent' },
      number: '966043',
      resend: true,
    });
    renderHelp({ holds: [sent], onResend });
    const list = screen.getByRole('list', { name: messages.helpRecover.heldHeading });
    expect(list.querySelector('li > p')?.textContent).toBe(
      'Kim’s share went to their new device with the second number 966 043.',
    );
    // Only once asked does the form open: most numbers go right the first time.
    expect(screen.queryByRole('textbox', { name: messages.helpRecover.secondLabel })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resendOpen }));
    const field = screen.getByRole('textbox', { name: messages.helpRecover.secondLabel });
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription(messages.helpRecover.resendHint);
    expect(await axeViolations()).toEqual([]);

    await user.type(field, '96604');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resend }));
    expect(await screen.findByText(messages.helpRecover.badSecond)).toBeVisible();
    await user.clear(field);
    await user.type(field, '966 034');
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resend }));
    expect(await screen.findByText(messages.helpRecover.resendFailed)).toBeVisible();
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resend }));
    expect(await screen.findByText(messages.helpRecover.resent)).toBeVisible();
    expect(onResend).toHaveBeenLastCalledWith({ groupId: 'g2', alert: 'a4', number: '966 034' });
    expect(onResend).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('textbox', { name: messages.helpRecover.secondLabel })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends again once while it sends, and Cancel closes the form', async () => {
    const sending = held<undefined>();
    const onResend = vi.fn<HelpRecoverProps['onResend']>(() => sending.promise);
    const sent = { alert: 'a4', groupId: 'g2', name: 'Kim', status: { kind: 'sent' } as const };
    renderHelp({ holds: [hold({ ...sent, number: '966043', resend: true })], onResend });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resendOpen }));
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resendCancel }));
    expect(screen.queryByRole('textbox', { name: messages.helpRecover.secondLabel })).toBeNull();

    await user.click(screen.getByRole('button', { name: messages.helpRecover.resendOpen }));
    await user.type(
      screen.getByRole('textbox', { name: messages.helpRecover.secondLabel }),
      '966034',
    );
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resend }));
    expect(screen.getByRole('button', { name: messages.helpRecover.resend })).toBeDisabled();
    expect(screen.getByText(messages.helpRecover.resending)).toBeVisible();
    await user.click(screen.getByRole('button', { name: messages.helpRecover.resend }));
    sending.reject();
    expect(await screen.findByText(messages.helpRecover.resendFailed)).toBeVisible();
    await pastPressFallback();
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it('offers no sending again once the hold has forgotten its code', () => {
    const sent = { alert: 'a4', groupId: 'g2', name: 'Kim', status: { kind: 'sent' } as const };
    renderHelp({ holds: [hold(sent)] });
    expect(screen.getByText(/share went to their new device\.$/)).toBeVisible();
    expect(screen.queryByRole('button', { name: messages.helpRecover.resendOpen })).toBeNull();
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
