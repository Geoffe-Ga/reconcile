/**
 * The Proposal view for someone whose vote hadn't arrived when it opened
 * (#101): they read why, with no ballot and no level to change.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { ProposalView } from './ProposalView';

const KIM = authorOf('kim');

/** When Kim's wait ends: she joins at START_MINUTE. */
const WAIT_END = START_MINUTE + DEFAULT_RULES.waitDays * DAY_MINUTES;

/** Ana, Ben and Cal hold rights; Kim, a newcomer at the creating level, joins before Ana proposes. */
function kimWaits() {
  const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
  const proposalId = log.propose('Ana');
  return { log, proposalId };
}

function view(log: ReturnType<typeof kimWaits>['log'], proposalId: string, at?: number) {
  const folded = log.state(at);
  render(
    <ProposalView
      state={folded}
      me={KIM}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={folded.at}
      own="none"
      onVote={vi.fn(() => Promise.resolve())}
      onProposeAgain={vi.fn()}
      onTell={vi.fn(() => Promise.resolve('copied' as const))}
    />,
  );
}

describe('ProposalView for a newcomer (#101)', () => {
  it('says they didn’t have a vote yet when it opened, with no ballot or level link', async () => {
    const { log, proposalId } = kimWaits();
    view(log, proposalId);
    expect(screen.getByText('You didn’t have a vote yet when this opened.')).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/voting level/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says so even once their vote has arrived, for a Proposal that opened before', () => {
    const { log, proposalId } = kimWaits();
    log.vouch('Ana', 'Kim');
    log.vouch('Ben', 'Kim');
    view(log, proposalId, WAIT_END);
    expect(screen.getByText('You didn’t have a vote yet when this opened.')).toBeVisible();
  });

  it('still tells someone who joined after it opened that they joined after', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposalId = log.propose('Ana');
    log.join('Kim');
    view(log, proposalId);
    expect(
      screen.getByText('You joined after this opened, so you can’t vote on it.'),
    ).toBeVisible();
  });
});
