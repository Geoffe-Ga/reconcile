import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { type ChatDetails, type ChatMoment, chatMessage } from './chatMessages';
import type { ShareOutcome } from './share';
import { TellYourGroup, type TellYourGroupProps } from './TellYourGroup';

type OnTell = (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;

/** How long React Aria's usePress waits for a click after a pointerup before clicking itself. */
const PRESS_FALLBACK_MS = 80;

const DEADLINE = 29_010_080;
const EDIT = { deadline: DEADLINE, title: 'Quiet hours', target: { kind: 'edit' } } as const;
const STEWARD = {
  deadline: DEADLINE,
  title: 'Make Ben steward (seat 1)',
  target: { kind: 'steward', seat: 1, member: 'ben', holder: 'ana' },
} as const;

function setup(props: Partial<TellYourGroupProps> = {}) {
  const onTell = vi.fn<OnTell>(() => Promise.resolve('copied'));
  const all: TellYourGroupProps = { moment: 'open', proposal: EDIT, onTell, ...props };
  document.title = 'Proposal · Reconcile';
  render(
    <main>
      <h1>Proposal</h1>
      <TellYourGroup {...all} />
    </main>,
  );
  return { user: userEvent.setup(), onTell: all.onTell };
}

const tell = () => screen.getByRole('button', { name: 'Tell your group' });
const includeTitle = () => screen.getByRole('checkbox', { name: 'Include the title' });

describe('TellYourGroup', () => {
  it.each(['open', 'version', 'closing', 'result'] as const)(
    'shows the %s message it shares, with no title, and shares just that',
    async (moment) => {
      const { user, onTell } = setup({ moment });
      const line = chatMessage(moment, { deadline: DEADLINE });

      expect(screen.getByText('Shares this message and Reconcile’s address:')).toBeVisible();
      expect(screen.getByText(line)).toBeVisible();
      expect(tell()).toHaveAccessibleDescription(line);
      expect(includeTitle()).not.toBeChecked();
      await user.click(tell());

      expect(onTell).toHaveBeenCalledExactlyOnceWith(moment, { deadline: DEADLINE });
      expect(await screen.findByText('Copied. Paste it into your group’s chat.')).toBeVisible();
      expect(await axeViolations()).toEqual([]);
    },
  );

  it('adds the title, for that one share, once someone ticks Include the title', async () => {
    const { user, onTell } = setup({ moment: 'result' });

    await user.click(includeTitle());
    expect(screen.getByText('A vote has finished in Reconcile: "Quiet hours".')).toBeVisible();
    await user.click(tell());

    expect(onTell).toHaveBeenCalledExactlyOnceWith('result', {
      deadline: DEADLINE,
      title: 'Quiet hours',
    });
    await screen.findByText('Copied. Paste it into your group’s chat.');
    // It isn't remembered: the next share leaves the title out unless ticked again.
    expect(includeTitle()).not.toBeChecked();
    expect(screen.getByText('A vote has finished in Reconcile.')).toBeVisible();
    await user.click(tell());
    expect(onTell).toHaveBeenLastCalledWith('result', { deadline: DEADLINE });
    expect(await axeViolations()).toEqual([]);
  });

  it('leaves the title out when the box is ticked and then cleared', async () => {
    const { user, onTell } = setup();
    await user.click(includeTitle());
    await user.click(includeTitle());
    await user.click(tell());
    expect(onTell).toHaveBeenCalledExactlyOnceWith('open', { deadline: DEADLINE });
  });

  it('offers no title on a steward Proposal, whose title names a member', () => {
    setup({ proposal: STEWARD });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(chatMessage('open', { deadline: DEADLINE }))).toBeVisible();
  });

  it.each([
    ['shared', 'Shared.'],
    ['blocked', 'Sharing and copying are both blocked here. Tell your group in your chat instead.'],
  ] as const)('says when it was %s', async (outcome, line) => {
    const { user } = setup({ onTell: vi.fn<OnTell>(() => Promise.resolve(outcome)) });
    await user.click(tell());
    expect(await screen.findByText(line)).toBeVisible();
  });

  it('says sharing was blocked when the share fails outright', async () => {
    const { user } = setup({ onTell: vi.fn<OnTell>(() => Promise.reject(new Error('gone'))) });
    await user.click(tell());
    expect(
      await screen.findByText(
        'Sharing and copying are both blocked here. Tell your group in your chat instead.',
      ),
    ).toBeVisible();
  });

  it('stays disabled while it shares, and a tap meanwhile neither shares again nor ticks the box', async () => {
    let finish: (outcome: ShareOutcome) => void = () => undefined;
    const onTell = vi.fn<OnTell>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = setup({ onTell });
    await user.click(tell());
    expect(tell()).toBeDisabled();
    expect(includeTitle()).toBeDisabled();
    await user.click(tell());
    await user.click(includeTitle());
    finish('shared');
    expect(await screen.findByText('Shared.')).toBeVisible();
    // A press on a disabled React Aria control still gets pointerdown and pointerup,
    // and usePress clicks the control itself when no click follows within 80 ms
    // (#190, #192). Wait past that so a late click can't hide.
    await act(() => new Promise((resolve) => setTimeout(resolve, PRESS_FALLBACK_MS + 20)));
    expect(tell()).toBeEnabled();
    expect(includeTitle()).not.toBeChecked();
    expect(screen.getByText(chatMessage('open', { deadline: DEADLINE }))).toBeVisible();
    expect(onTell).toHaveBeenCalledTimes(1);
  });
});
