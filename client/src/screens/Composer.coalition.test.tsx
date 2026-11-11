/** The coalition's composer (#120): the group composer's form, writing a motion to the coalition. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CoalitionStanding } from '../app/coalitionHome';
import { messages } from '../app/messages';
import type { ProposalValues } from '../app/proposals';
import { fold, type GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { Logs } from '../test/coalitions';
import { memoryDrafts } from '../test/drafts';
import { CoalitionComposer, type ComposeOutcome } from './Composer';

/** The device clock: Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);
const R = 29_375_000;

/** A formed coalition of two seats, with `motion` open on its one section when asked. */
function coalition(withMotion = false): GroupState {
  const logs = new Logs();
  const at = logs.formed(R, ['Riverside', 'Oak St'], ['kim', 'zed']);
  if (withMotion) logs.motion(at, 'kim');
  return fold(logs.logs.coalition ?? [], at + 1);
}

/** Renders the coalition's composer for its first section. */
async function setup(standing: CoalitionStanding, state = coalition(), atom = '.0') {
  const onPropose = vi.fn<(values: ProposalValues) => Promise<ComposeOutcome>>(() =>
    Promise.resolve('proposed'),
  );
  render(
    <CoalitionComposer
      state={state}
      atomId={`${state.group ?? ''}${atom}`}
      standing={standing}
      drafts={memoryDrafts().drafts}
      now={NOW}
      onPropose={onPropose}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { onPropose, user: userEvent.setup(), state };
}

describe('CoalitionComposer', () => {
  it('proposes new text for the section, with a voting time and no Dispatch', async () => {
    const { onPropose, user, state } = await setup({ kind: 'proposes', groupId: 'g' });

    expect(screen.getByRole('heading', { level: 1, name: 'Propose a change' })).toBeVisible();
    expect(screen.getByText(messages.coalitions.composerLede)).toBeVisible();
    expect(screen.getByRole('link', { name: /Shared ground/ })).toHaveAttribute(
      'href',
      `#/c/${state.group ?? ''}/doc/${state.group ?? ''}`,
    );
    expect(screen.queryByRole('checkbox', { name: /Dispatch/ })).toBeNull();
    expect(screen.getByText(messages.coalitions.composerVisibility)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Why' })).toHaveAccessibleDescription(
      messages.coalitions.composerWhyHint,
    );
    expect(await axeViolations()).toEqual([]);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Banks too');
    await user.type(screen.getByRole('textbox', { name: 'Why' }), 'The banks matter.');
    const text = screen.getByRole('textbox', { name: 'New text' });
    await user.clear(text);
    await user.type(text, 'We keep the river and its banks clean.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));

    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        atom: `${state.group ?? ''}.0`,
        title: 'Banks too',
        why: 'The banks matter.',
        text: 'We keep the river and its banks clean.',
        window: 7,
      }),
    );
    expect(onPropose.mock.calls[0]?.[0]).not.toHaveProperty('dispatch');
  });

  it('offers no form to someone who hasn’t joined, or can’t propose', async () => {
    await setup({ kind: 'take-part', groupId: 'g' });
    expect(screen.getByText(messages.coalitions.takePartFirst)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers no form to a reader', async () => {
    await setup({ kind: 'reads' });
    expect(screen.getByText(messages.coalitions.cantPropose)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says a section with a motion open takes no other, and has no Add your version', async () => {
    await setup({ kind: 'proposes', groupId: 'g' }, coalition(true));
    expect(screen.getByText(messages.coalitions.sectionOpen)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says a section that isn’t in the Document is missing', async () => {
    await setup({ kind: 'proposes', groupId: 'g' }, coalition(), '.9');
    expect(screen.getByText(messages.composer.missing)).toBeVisible();
  });
});
