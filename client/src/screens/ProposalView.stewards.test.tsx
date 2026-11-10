/**
 * Steward ballots and a suspended voter in the Proposal view (#102): the
 * ballot reads "Make <name> steward (seat N)" or "Recall <name> as steward",
 * the steward a recall names reads why they don't vote, and a suspended
 * voter reads until when, over a disabled ballot.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute } from '../app/time';
import { createEvent, type ParsedEvent, parseEvent, type Score } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { ProposalView, type ProposalViewProps } from './ProposalView';

type OnVote = (scores: Readonly<Record<string, Score>>, note: string) => Promise<void>;

const UNTIL = START_MINUTE + 7 * DAY_MINUTES;
const SUSPENDED = `A steward suspended you until ${formatMinute(UNTIL)}. You can read, but not post, propose or vote.`;

function setup(
  state: GroupState,
  proposalId: string,
  me: string,
  extra: Partial<ProposalViewProps> = {},
) {
  document.title = 'Proposal · Reconcile';
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={state.at}
      own="none"
      onVote={onVote}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
      {...extra}
    />,
  );
  return { user: userEvent.setup(), onVote };
}

/** Ben proposes himself for seat 1 in Ana, Ben and Cal's group. */
function election() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const id = log.steward('Ben', 1, 'Ben', { title: 'Ben for steward', why: 'Calm in a storm.' });
  return { log, id };
}

/** Ben proposes recalling Ana from seat 1 in Ana, Ben, Cal and Dee's group. */
function recall() {
  const log = groupLog({ members: ['Ben', 'Cal', 'Dee'] });
  const id = log.steward('Ben', 1, null, { title: 'Recall Ana', why: 'We talked it over.' });
  return { log, id };
}

describe('ProposalView: a steward election (#102)', () => {
  it('reads "Make Ben steward (seat 1)", with one score group and no Add your version', async () => {
    const { log, id } = election();
    setup(log.state(), id, 'cal');
    const card = screen.getByRole('region', { name: 'Make Ben steward (seat 1)' });
    expect(
      within(card).getByText(/If this passes, they can suspend someone at once, for 7 days/),
    ).toBeVisible();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(screen.queryByText(/Added words are underlined/)).toBeNull();
    expect(screen.getByRole('region', { name: 'On the ballot' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('queues a ballot scoring the Proposal itself', async () => {
    const { log, id } = election();
    const { user, onVote } = setup(log.state(), id, 'cal');
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [id]: 4 }, '');
  });

  it('names the new steward once it passes, with no Document text', async () => {
    const { log, id } = election();
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, id, 4);
    setup(log.state(), id, 'cal');
    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('This passed. Ben is now steward for seat 1.');
    expect(result).not.toHaveTextContent('The Document now reads');
    expect(result).not.toHaveTextContent('Thank you');
    expect(result).toHaveTextContent('Make Ben steward (seat 1)Scored by 3');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Propose again on a lapsed steward vote: Group home says when one is due', () => {
    const { log, id } = election();
    setup(log.state(START_MINUTE + 7 * DAY_MINUTES), id, 'ben');
    expect(screen.getByText('Not enough people weighed in. This isn’t a no.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
  });
});

describe('ProposalView: a recall (#102)', () => {
  it('reads "Recall Ana as steward" to the voters', () => {
    const { log, id } = recall();
    setup(log.state(), id, 'cal');
    const card = screen.getByRole('region', { name: 'Recall Ana as steward' });
    expect(
      within(card).getByText(/their seat is empty until your group elects a steward/),
    ).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
  });

  it('tells the steward it names that they don’t vote on their own recall', async () => {
    const { log, id } = recall();
    setup(log.state(), id, 'ana');
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(
      screen.getByText('This Proposal would recall you as steward, so you don’t vote on it.'),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: /Change your involvement/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the steward is no longer one once it passes', () => {
    const { log, id } = recall();
    for (const name of ['Ben', 'Cal', 'Dee']) log.vote(name, id, 4);
    setup(log.state(), id, 'ana');
    expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent(
      'This passed. Ana is no longer a steward.',
    );
  });
});

describe('ProposalView: a suspended voter (#102)', () => {
  it('shows the suspended line over a disabled ballot that keeps their earlier score', async () => {
    const log = groupLog({ members: ['Ben', 'Kim'] });
    const id = log.propose('Ana');
    log.vote('Kim', id, 3);
    log.suspend('Ana', 'Kim', 'Threats.');
    setup(log.state(), id, 'kim');
    expect(screen.getByText(SUSPENDED)).toBeVisible();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    for (const radio of radios) expect(radio).toBeDisabled();
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /your vote$/ })).toBeNull();
    expect(screen.queryByText('Voting has closed, so this ballot can’t change.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps them on the ballot of a Proposal that opens during the suspension, disabled until it ends', () => {
    const log = groupLog({ members: ['Ben', 'Kim'] });
    log.suspend('Ana', 'Kim', 'Threats.');
    const id = log.propose('Ana');
    setup(log.state(), id, 'kim');
    expect(screen.getByText(SUSPENDED)).toBeVisible();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('gives the ballot back once the suspension ends, while the vote is open', () => {
    const log = groupLog({ members: ['Ben', 'Kim'] });
    log.suspend('Ana', 'Kim', 'Threats.');
    log.minute = START_MINUTE + 10;
    const id = log.propose('Ana');
    setup(log.state(UNTIL), id, 'kim');
    expect(screen.queryByText(SUSPENDED)).toBeNull();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send your vote' })).toBeVisible();
  });

  it('leaves everyone else’s ballot alone', () => {
    const log = groupLog({ members: ['Ben', 'Kim'] });
    const id = log.propose('Ana');
    log.suspend('Ana', 'Kim', 'Threats.');
    setup(log.state(), id, 'ben');
    expect(screen.queryByText(SUSPENDED)).toBeNull();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled();
  });
});

describe('ProposalView: a steward Proposal still in the outbox (#102)', () => {
  it('shows its title, why and what its ballot will say, waiting to send', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const input = {
      type: 'proposal',
      group: log.group,
      author: authorOf('ben'),
      ts: 0,
      body: {
        target: { kind: 'steward', seat: 1, member: null },
        title: 'Recall Ana',
        why: 'We talked it over.',
      },
    } as const;
    const parsed: ParsedEvent | null = parseEvent(createEvent(input).bytes);
    if (parsed === null) throw new Error('Expected an event.');
    setup(log.state(), parsed.id, 'ben', { pending: [parsed] });
    expect(screen.getByRole('heading', { level: 1, name: 'Recall Ana' })).toBeVisible();
    expect(screen.getByText('We talked it over.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Recall Ana as steward' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Sending…');
  });
});
