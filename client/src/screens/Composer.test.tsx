import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProposalValues } from '../app/proposals';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { groupLog } from '../test/votes';
import { Composer, type ComposeOutcome } from './Composer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;

interface Setup {
  readonly state?: GroupState;
  readonly atom?: number;
  readonly me?: string;
  readonly onPropose?: OnPropose;
}

function setup({ state, atom = 0, me = 'ana', onPropose }: Setup = {}) {
  const group = state ?? groupLog({ chat: 'https://chat.example.org/riverside' }).state();
  const propose = vi.fn<OnPropose>(onPropose ?? (() => Promise.resolve('proposed')));
  render(
    <Composer
      state={group}
      me={me}
      atomId={`${group.group ?? ''}.${String(atom)}`}
      onPropose={propose}
    />,
  );
  return { user: userEvent.setup(), onPropose: propose, state: group };
}

const box = (name: string) => screen.getByRole('textbox', { name });
const submit = () => screen.getByRole('button', { name: 'Propose this change' });

async function replace(user: UserEvent, label: string, value: string): Promise<void> {
  await user.clear(box(label));
  if (value === '') return;
  await user.click(box(label));
  await user.paste(value);
}

async function fill(user: UserEvent, entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [label, value] of Object.entries(entries)) await replace(user, label, value);
}

describe('Composer', () => {
  it('shows the section as it reads now, and four fields, prefilled', async () => {
    const { state } = setup({ atom: 1 });

    expect(screen.getByRole('heading', { level: 1, name: 'Propose a change' })).toBeVisible();
    expect(screen.queryByText('Section 2', { selector: 'p' })).not.toBeInTheDocument();
    const now = screen.getByRole('region', { name: 'Section 2 now reads' });
    expect(now).toHaveTextContent('Bins go out on Tuesday.');
    expect(box('Title')).toHaveValue('');
    expect(box('Title')).toBeRequired();
    expect(box('Why')).toBeRequired();
    expect(box('Why').tagName).toBe('TEXTAREA');
    expect(box('New text')).toHaveValue('Bins go out on Tuesday.');
    expect(box('New text')).toHaveClass('input-document');
    expect(box('Discussion link (optional)')).toHaveValue('https://chat.example.org/riverside');
    expect(box('Discussion link (optional)')).not.toBeRequired();
    for (const label of ['Title', 'Why', 'New text']) {
      expect(box(label)).not.toHaveAttribute('maxlength');
    }
    expect(
      screen.getByText('Everyone in your group sees this Proposal and that you made it.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc`,
    );
    expect(document.title).toBe('Propose a change · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('prefills the link of the latest Proposal that carries one', () => {
    const log = groupLog({ chat: 'https://chat.example.org/riverside' });
    log.propose('ana', { link: 'https://chat.example.org/quiet-hours' });
    log.propose('ben', { atom: 1 });
    setup({ state: log.state() });
    expect(box('Discussion link (optional)')).toHaveValue('https://chat.example.org/quiet-hours');
  });

  it('hands over the entries, trimmed, with a blank link as none', async () => {
    const { user, onPropose, state } = setup();
    await fill(user, {
      Title: '  Later quiet hours ',
      Why: ' Weekends run late. ',
      'New text': 'Quiet after 11pm.\n',
      'Discussion link (optional)': '   ',
    });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledWith({
      atom: `${state.group ?? ''}.0`,
      title: 'Later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet after 11pm.\n',
      link: null,
    });
  });

  it('keeps a discussion link, trimmed', async () => {
    const { user, onPropose } = setup();
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await replace(user, 'Discussion link (optional)', ' https://chat.example.org/later ');
    await user.click(submit());
    expect(onPropose.mock.calls[0]?.[0].link).toBe('https://chat.example.org/later');
  });

  it('refuses a javascript: link, with the reason tied to the field', async () => {
    const { user, onPropose } = setup();
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await replace(user, 'Discussion link (optional)', 'javascript:alert(1)');
    await user.click(submit());

    expect(onPropose).not.toHaveBeenCalled();
    const link = box('Discussion link (optional)');
    expect(link).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText('Use a web link that starts with https:// or http://.');
    expect(link.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(await axeViolations()).toEqual([]);
  });

  it('names every missing entry, and sends nothing', async () => {
    const { user, onPropose } = setup();
    await replace(user, 'New text', ' \n ');
    await user.click(submit());

    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Title')).toHaveAccessibleDescription(
      'A few words that say what changes. Give your Proposal a title.',
    );
    expect(box('Why')).toHaveAccessibleDescription(
      'Tell your group what this fixes or makes better. Say why you’re proposing this.',
    );
    expect(box('New text')).toHaveAccessibleDescription(
      'If your group passes it, this replaces the section. Write the new text for this section.',
    );
    expect(box('Title')).toHaveFocus();
  });

  it('counts the title and why in code points after NFC, not UTF-16 units', async () => {
    const { user, onPropose } = setup();
    // "é" as e + combining accent: two code points each, one after NFC.
    await fill(user, { Title: 'é'.repeat(120), Why: '😀'.repeat(2000) });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledTimes(1);

    await fill(user, { Title: 'é'.repeat(121), Why: '😀'.repeat(2001) });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(box('Title')).toHaveAccessibleDescription(
      'A few words that say what changes. Keep the title to 120 characters or fewer.',
    );
    expect(box('Why')).toHaveAccessibleDescription(
      'Tell your group what this fixes or makes better. Keep it to 2,000 characters or fewer.',
    );
  });

  it('ties a too-large Proposal to its text', async () => {
    const onPropose = vi.fn<OnPropose>(() => Promise.resolve('too-large'));
    const { user } = setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await user.click(submit());
    expect(box('New text')).toHaveAttribute('aria-invalid', 'true');
    expect(box('New text')).toHaveAccessibleDescription(
      'If your group passes it, this replaces the section. This is too long to send. Shorten it, then try again.',
    );
  });

  it('keeps only the latest submit’s refusal', async () => {
    const outcomes: ComposeOutcome[] = ['too-large', 'failed'];
    const onPropose = vi.fn<OnPropose>(() => Promise.resolve(outcomes.shift() ?? 'failed'));
    const { user } = setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await user.click(submit());
    expect(box('New text')).toHaveAttribute('aria-invalid', 'true');
    await replace(user, 'New text', 'Quiet after 11pm.');
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(box('New text')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('This is too long to send. Shorten it, then try again.')).toBeNull();
  });

  it('says so when the Proposal couldn’t be saved', async () => {
    const onPropose = vi.fn<OnPropose>(() => Promise.reject(new Error('quota')));
    const { user } = setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your Proposal couldn’t be saved on this device. Try again.',
    );
    expect(submit()).toBeEnabled();
  });

  it('keeps the button disabled while it proposes, and proposes once', async () => {
    let finish: (outcome: ComposeOutcome) => void = () => undefined;
    const onPropose = vi.fn<OnPropose>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await user.click(submit());
    expect(submit()).toBeDisabled();
    await user.click(submit());
    finish('proposed');
    await Promise.resolve();
    expect(submit()).toBeDisabled();
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it('says when the section isn’t in the Document', async () => {
    const state = groupLog().state();
    render(<Composer state={state} me="ana" atomId="missing.0" onPropose={vi.fn()} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no composer to someone who may not propose', () => {
    setup({ me: 'stranger' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
