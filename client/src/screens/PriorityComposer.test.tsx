import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PriorityValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import { optionId } from '../engine/priority';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import type { ComposeOutcome } from './Composer';
import { PriorityComposer } from './PriorityComposer';

type OnAsk = (values: PriorityValues) => Promise<ComposeOutcome>;

const [, VOTING] = LEVELS;

interface Setup {
  readonly state?: GroupState;
  readonly me?: string;
  readonly onAsk?: OnAsk;
  readonly again?: Proposal;
}

function setup(options: Setup = {}) {
  const state = options.state ?? groupLog().state();
  const onAsk = vi.fn<OnAsk>(options.onAsk ?? (() => Promise.resolve('proposed')));
  render(
    <PriorityComposer
      state={state}
      me={options.me ?? authorOf('ana')}
      onAsk={onAsk}
      {...(options.again === undefined ? {} : { again: options.again })}
    />,
  );
  return { user: userEvent.setup(), onAsk };
}

const box = (name: string) => screen.getByRole('textbox', { name });
const options = () => screen.getAllByRole('textbox', { name: /^Option \d$/ });
const submit = () => screen.getByRole('button', { name: 'Ask your group' });

async function type(user: UserEvent, label: string, value: string): Promise<void> {
  await user.clear(box(label));
  await user.click(box(label));
  await user.paste(value);
}

describe('PriorityComposer (#107)', () => {
  it('starts with the question, an empty why, and two empty options', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask what to focus on' })).toBeDefined();
    expect(document.title).toBe('Ask what to focus on · Reconcile');
    expect(box('Question')).toHaveProperty('value', 'What should we focus on?');
    expect(box('Why')).toHaveProperty('value', '');
    expect(options().map((option) => (option as HTMLInputElement).value)).toEqual(['', '']);
    expect(screen.getByRole('group', { name: 'Options' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Remove option/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('adds options up to seven, then offers no more, and moves the focus to each new one', async () => {
    const { user } = setup();
    for (let n = 3; n <= 7; n += 1) {
      await user.click(screen.getByRole('button', { name: 'Add option' }));
      expect(options()).toHaveLength(n);
      expect(document.activeElement).toBe(box(`Option ${String(n)}`));
    }
    expect(screen.queryByRole('button', { name: 'Add option' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Remove option/ })).toHaveLength(7);
    expect(await axeViolations()).toEqual([]);
  });

  it('removes an option, keeping the others’ text, and offers no Remove at two', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await type(user, 'Option 1', 'Fix the website');
    await type(user, 'Option 2', 'Plan the picnic');
    await type(user, 'Option 3', 'New bylaws');
    await user.click(screen.getByRole('button', { name: 'Remove option 2' }));
    expect(options().map((option) => (option as HTMLInputElement).value)).toEqual([
      'Fix the website',
      'New bylaws',
    ]);
    expect(document.activeElement).toBe(box('Option 1'));
    expect(screen.queryByRole('button', { name: /^Remove option/ })).toBeNull();
  });

  it('sends the question, why and options as typed, for the action to normalize', async () => {
    const { user, onAsk } = setup();
    await type(user, 'Why', '  We can only do one thing well.  ');
    await type(user, 'Option 1', ' Fix the website ');
    await type(user, 'Option 2', 'Plan the picnic');
    await user.click(submit());
    expect(onAsk).toHaveBeenCalledWith({
      title: 'What should we focus on?',
      why: 'We can only do one thing well.',
      options: [' Fix the website ', 'Plan the picnic'],
    });
    expect(submit()).toHaveProperty('disabled', true);
  });

  it('refuses a blank, repeated or too-long option, and a missing question or why', async () => {
    const { user, onAsk } = setup();
    await user.clear(box('Question'));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await type(user, 'Option 1', 'Café');
    // The same option once NFC-normalized and trimmed, as it would be signed.
    await type(user, 'Option 2', ' Cafe\u0301 ');
    await type(user, 'Option 3', 'x'.repeat(121));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.click(submit());
    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByText('Write the question your group will answer.')).toBeDefined();
    expect(screen.getByText('Say why you’re asking now.')).toBeDefined();
    expect(screen.getByText('This option is already on the list.')).toBeDefined();
    expect(screen.getByText('Keep each option to 120 characters or fewer.')).toBeDefined();
    expect(screen.getByText('Write this option, or remove it.')).toBeDefined();
    expect(box('Option 1').getAttribute('aria-invalid')).toBeNull();
    expect(box('Option 2').getAttribute('aria-invalid')).toBe('true');
    expect(await axeViolations()).toEqual([]);
  });

  it('counts an option’s length in code points, so 120 emoji fit', async () => {
    const { user, onAsk } = setup();
    await type(user, 'Why', 'Because.');
    await type(user, 'Option 1', '🌱'.repeat(120));
    await type(user, 'Option 2', 'Plan the picnic');
    await user.click(submit());
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it('says so when the question couldn’t be saved, and lets the asker try again', async () => {
    const { user, onAsk } = setup({ onAsk: () => Promise.reject(new Error('quota')) });
    await type(user, 'Why', 'Because.');
    await type(user, 'Option 1', 'Fix the website');
    await type(user, 'Option 2', 'Plan the picnic');
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Your question couldn’t be saved on this device. Try again.',
    );
    expect(submit()).toHaveProperty('disabled', false);
    await user.click(submit());
    expect(onAsk).toHaveBeenCalledTimes(2);
  });

  it('shows no form to someone who can’t propose', () => {
    const state = groupLog({ members: ['Ben'], levels: { Ben: VOTING } }).state();
    setup({ state, me: authorOf('ben') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows no form while a priority vote is open, and links to it', () => {
    const log = groupLog();
    const open = log.ask('ben', ['Fix the website', 'Plan the picnic']);
    setup({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Your group is already choosing a focus' }),
    ).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    const link = screen.getByRole('link', { name: 'See the open vote' });
    expect(link.getAttribute('href')).toBe(`#/g/${log.group}/p/${open}`);
  });

  it('asks a lapsed priority vote again from its own question, why and options', async () => {
    const log = groupLog();
    const lapsed = log.ask('ana', ['Fix the website', 'Plan the picnic', 'New bylaws'], {
      title: 'What first?',
      why: 'Spring is coming.',
    });
    log.ballot('ana', lapsed, { [optionId(lapsed, 0)]: 4 });
    const state = log.state(deadlineOf(START_MINUTE));
    const again = state.proposals.find((proposal) => proposal.id === lapsed);
    const { user, onAsk } = setup({ state, ...(again === undefined ? {} : { again }) });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeDefined();
    expect(box('Question')).toHaveProperty('value', 'What first?');
    await user.click(submit());
    expect(onAsk).toHaveBeenCalledWith({
      title: 'What first?',
      why: 'Spring is coming.',
      options: ['Fix the website', 'Plan the picnic', 'New bylaws'],
    });
    expect(
      within(screen.getByRole('group', { name: 'Options' })).getAllByRole('textbox'),
    ).toHaveLength(3);
  });
});
