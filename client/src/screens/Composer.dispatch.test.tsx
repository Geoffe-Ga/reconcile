/**
 * The composer's "Send a Dispatch if this passes" (#112): a checkbox,
 * unchecked, that adds a Dispatch title, prefilled 'Updated: {Document
 * title}', and an optional text to the Proposal; kept in the private draft;
 * checked against the fold's limits before anything is queued; and carried
 * over when a lapsed Proposal is proposed again.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { ProposalValues } from '../app/proposals';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import { Composer, type ComposeOutcome } from './Composer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;

/** Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);
const { composer } = messages;

interface Setup {
  readonly state?: GroupState;
  readonly drafts?: Readonly<Record<string, Draft>>;
  readonly again?: Proposal;
}

async function setup(options: Setup = {}) {
  const state = options.state ?? groupLog().state();
  const onPropose = vi.fn<OnPropose>(() => Promise.resolve('proposed'));
  const memory = memoryDrafts(options.drafts);
  const atomId = `${state.group ?? ''}.0`;
  render(
    <Composer
      state={state}
      me={authorOf('ana')}
      atomId={atomId}
      drafts={memory.drafts}
      now={NOW}
      onPropose={onPropose}
      onAddVersion={() => Promise.resolve('added')}
      {...(options.again === undefined ? {} : { again: options.again })}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { user: userEvent.setup(), onPropose, memory, atomId };
}

const box = (name: string) => screen.getByRole('textbox', { name });
const choice = () => screen.getByRole('checkbox', { name: composer.dispatchLabel });

async function fillProposal(user: UserEvent): Promise<void> {
  await user.click(box('Title'));
  await user.paste('Later quiet hours');
  await user.click(box('Why'));
  await user.paste('Weekends run late.');
  await user.clear(box('New text'));
  await user.click(box('New text'));
  await user.paste('Quiet after 11pm.');
}

describe('Composer: Send a Dispatch if this passes (#112)', () => {
  it('starts unchecked, with what it does tied to it, and no Dispatch fields', async () => {
    await setup();
    expect(choice()).not.toBeChecked();
    expect(choice()).toHaveAccessibleDescription(composer.dispatchHint);
    expect(screen.queryByRole('textbox', { name: composer.dispatchTitleLabel })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens a title prefilled ‘Updated: <Document title>’ and a text, and the Proposal carries them', async () => {
    const { user, onPropose, atomId } = await setup();
    await fillProposal(user);
    await user.click(choice());
    expect(choice()).toBeChecked();
    expect(box(composer.dispatchTitleLabel)).toHaveValue('Updated: House rules');
    expect(box(composer.dispatchTextLabel)).toHaveValue('');
    expect(await axeViolations()).toEqual([]);
    await user.click(box(composer.dispatchTextLabel));
    await user.paste('  Quiet hours now start at 11.  ');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        atom: atomId,
        title: 'Later quiet hours',
        dispatch: { title: 'Updated: House rules', text: 'Quiet hours now start at 11.' },
      }),
    );
  });

  it('carries no Dispatch once it is unchecked again', async () => {
    const { user, onPropose } = await setup();
    await fillProposal(user);
    await user.click(choice());
    await user.click(choice());
    expect(screen.queryByRole('textbox', { name: composer.dispatchTitleLabel })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledOnce();
    expect(onPropose.mock.calls[0]?.[0]).not.toHaveProperty('dispatch');
  });

  it('refuses an 81-code-point Dispatch title, or a blank one, tied to the field, and queues nothing', async () => {
    const { user, onPropose } = await setup();
    await fillProposal(user);
    await user.click(choice());
    await user.clear(box(composer.dispatchTitleLabel));
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box(composer.dispatchTitleLabel)).toHaveAccessibleDescription(
      messages.sendDispatch.titleMissing,
    );
    await user.click(box(composer.dispatchTitleLabel));
    await user.paste('a'.repeat(81));
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box(composer.dispatchTitleLabel)).toBeInvalid();
    expect(box(composer.dispatchTitleLabel)).toHaveAccessibleDescription(
      'Keep the title to 80 characters or fewer.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a 501-code-point Dispatch text', async () => {
    const { user, onPropose } = await setup();
    await fillProposal(user);
    await user.click(choice());
    await user.click(box(composer.dispatchTextLabel));
    await user.paste('b'.repeat(501));
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box(composer.dispatchTextLabel)).toHaveAccessibleDescription(
      'Keep it to 500 characters or fewer.',
    );
  });

  it('keeps the Dispatch in the private draft, and brings it back', async () => {
    const { user, memory, atomId } = await setup();
    await user.click(choice());
    await user.click(box(composer.dispatchTextLabel));
    await user.paste('See you Sunday.');
    await waitFor(() => {
      expect(memory.shelf.get(atomId)?.dispatch).toEqual({
        title: 'Updated: House rules',
        text: 'See you Sunday.',
      });
    });
  });

  it('restores a draft’s Dispatch checked, with its words', async () => {
    const state = groupLog().state();
    const atomId = `${state.group ?? ''}.0`;
    const draft: Draft = {
      title: 'Later',
      why: 'Late.',
      text: 'Quiet after 11pm.',
      link: '',
      dispatch: { title: 'Quiet hours moved', text: 'From Friday.' },
    };
    await setup({ state, drafts: { [atomId]: draft } });
    expect(choice()).toBeChecked();
    expect(box(composer.dispatchTitleLabel)).toHaveValue('Quiet hours moved');
    expect(box(composer.dispatchTextLabel)).toHaveValue('From Friday.');
  });

  it('carries a lapsed Proposal’s Dispatch when it is proposed again (#74)', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const opened = log.minute;
    const dispatch = { title: 'Updated: House rules', text: 'Later quiet hours.' };
    const lapsed = log.propose('Ana', { dispatch });
    const state = log.state(deadlineOf(opened));
    const again = state.proposals.find((proposal) => proposal.id === lapsed);
    expect(again?.outcome.kind).toBe('lapse');
    const { user, onPropose } = await setup({ state, ...(again === undefined ? {} : { again }) });
    expect(choice()).toBeChecked();
    expect(box(composer.dispatchTitleLabel)).toHaveValue('Updated: House rules');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dispatch }));
  });
});
