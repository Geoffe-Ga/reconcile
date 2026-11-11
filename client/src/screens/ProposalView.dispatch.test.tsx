/**
 * The Dispatch a Proposal carries, on its page (#112): while the vote is
 * open, voters read "If this passes", the Dispatch's title and text, and
 * that everyone in the group gets it. Once it has closed, the Dispatches
 * view has it, or it never went.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { ProposalView } from './ProposalView';

function setup(state: GroupState, proposalId: string, me: string) {
  render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={state.at}
      own="none"
      onVote={() => Promise.resolve()}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
    />,
  );
}

const DISPATCH = { title: 'Updated: House rules', text: 'Quiet hours start at 11.\nFrom Friday.' };
const carried = () => screen.queryByRole('region', { name: messages.proposal.dispatchHeading });

describe('ProposalView: a carried Dispatch (#112)', () => {
  it('shows an open Proposal’s Dispatch: its title, its plain text and who gets it', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.propose('Ana', { dispatch: DISPATCH });
    setup(log.state(), id, 'ben');
    const block = carried();
    if (block === null) throw new Error('Expected the carried Dispatch.');
    expect(within(block).getByText('Updated: House rules')).toBeVisible();
    const text = within(block).getByText(/Quiet hours start at 11\./);
    expect(text.textContent).toBe(DISPATCH.text);
    expect(text).toHaveClass('dispatch-text');
    expect(within(block).getByText(messages.proposal.dispatchLine)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('leaves out an empty text', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.propose('Ana', { dispatch: { title: 'Updated', text: '' } });
    setup(log.state(), id, 'ben');
    expect(carried()?.querySelector('.dispatch-text')).toBeNull();
  });

  it('shows nothing for a Proposal that carries none', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const plain = log.propose('Ana', { atom: 1 });
    setup(log.state(), plain, 'ben');
    expect(carried()).toBeNull();
  });

  it('shows nothing once the vote has closed, since the Dispatch has gone or never will', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.propose('Ana', { dispatch: DISPATCH });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, id, 4);
    expect(log.state().dispatches).toHaveLength(1);
    setup(log.state(), id, 'ben');
    expect(carried()).toBeNull();
  });
});
