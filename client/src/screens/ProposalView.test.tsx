import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute } from '../app/time';
import {
  createEvent,
  type EventInput,
  type ParsedEvent,
  parseEvent,
  type Score,
} from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { ProposalView, type ProposalViewProps } from './ProposalView';

type OnVote = (score: Score, note: string) => Promise<void>;

interface Setup {
  readonly state: GroupState;
  readonly proposalId: string;
  readonly me?: string;
  readonly now?: number;
  readonly pending?: readonly ParsedEvent[];
  readonly reachable?: boolean;
}

function setup({ state, proposalId, me = 'ana', now, pending = [], reachable = true }: Setup) {
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  const props: ProposalViewProps = {
    state,
    me,
    proposalId,
    pending,
    reachable,
    now: now ?? START_MINUTE + 60,
    onVote,
  };
  const view = render(<ProposalView {...props} />);
  const rerender = (next: Partial<ProposalViewProps>) => {
    view.rerender(<ProposalView {...props} {...next} />);
  };
  return { user: userEvent.setup(), onVote, rerender };
}

/** An event as `useGroup` lists it while it waits in the outbox. */
function pendingEvent(input: EventInput): ParsedEvent {
  const parsed = parseEvent(createEvent(input).bytes);
  if (parsed === null) throw new Error('Expected an event.');
  return parsed;
}

const PROPOSAL = {
  title: 'Later quiet hours',
  why: 'Weekends run late.',
  text: 'Quiet after 11pm.',
  link: 'https://chat.example.org/later',
};

/** Ana proposes at the start minute in a group of Ana and Ben; the vote is still open. */
function openVote() {
  const log = groupLog({ chat: 'https://chat.example.org/riverside' });
  const proposalId = log.propose('ana', PROPOSAL);
  return { log, proposalId };
}

const radios = () => screen.queryAllByRole('radio');

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('ProposalView', () => {
  it('shows the title, why, both texts one above the other, a countdown and the ballot', async () => {
    const { log, proposalId } = openVote();
    setup({ state: log.state(), proposalId });

    expect(screen.getByRole('heading', { level: 1, name: 'Later quiet hours' })).toBeVisible();
    expect(screen.getByText('Open Proposal', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Weekends run late.')).toBeVisible();
    expect(screen.getByText('Ana', { selector: 'bdi' }).parentElement).toHaveTextContent(
      /^Proposed by Ana$/,
    );
    expect(screen.getByText('Closes in 7 days')).toBeVisible();
    const deadline = deadlineOf(START_MINUTE);
    expect(screen.getByText(formatMinute(deadline)).tagName).toBe('TIME');
    const now = screen.getByRole('region', { name: 'Section 1 now reads' });
    const proposed = screen.getByRole('region', { name: 'Proposed text' });
    expect(now).toHaveTextContent('Quiet hours start at ten.');
    expect(proposed).toHaveTextContent('Quiet after 11pm.');
    expect(precedes(now, proposed)).toBe(true);
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/later',
    );
    const vote = screen.getByRole('region', { name: 'Your vote' });
    expect(within(vote).getAllByRole('radio')).toHaveLength(5);
    expect(within(vote).getByRole('button', { name: 'Send your vote' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
    expect(document.title).toBe('Proposal · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('points Join discussion at the group’s latest link when the Proposal has none', () => {
    const log = groupLog({ chat: 'https://chat.example.org/riverside' });
    const proposalId = log.propose('ana', { title: 'No link' });
    setup({ state: log.state(), proposalId });
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/riverside',
    );
  });

  it('sends the ballot as this member', async () => {
    const { log, proposalId } = openVote();
    const { user, onVote } = setup({ state: log.state(), proposalId, me: 'ben' });
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith(4, '');
  });

  it('tells someone who joined after it opened why they can’t vote, with no pills', async () => {
    const { log, proposalId } = openVote();
    log.join('Cy');
    setup({ state: log.state(), proposalId, me: 'cy' });
    expect(
      screen.getByText('You joined after this opened, so you can’t vote on it.'),
    ).toBeVisible();
    expect(radios()).toEqual([]);
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('disables the ballot once relay time passes the deadline, before the close syncs', () => {
    const { log, proposalId } = openVote();
    const deadline = deadlineOf(START_MINUTE);
    setup({ state: log.state(deadline - 1), proposalId, now: deadline });
    expect(screen.getByText('Voting closed')).toBeVisible();
    for (const radio of radios()) expect(radio).toBeDisabled();
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
  });

  it('leads a passed Proposal with the outcome and the Document’s new text', async () => {
    const { log, proposalId } = openVote();
    log.minute += 30;
    log.vote('ana', proposalId, 3);
    log.vote('ben', proposalId, 4);
    setup({ state: log.state(), proposalId });

    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('This passed. The Document now reads:Quiet after 11pm.');
    expect(screen.getByText('Closed Proposal', { selector: 'p' })).toBeVisible();
    expect(precedes(result, screen.getByText('Weekends run late.'))).toBe(true);
    expect(screen.queryByRole('region', { name: 'Section 1 now reads' })).not.toBeInTheDocument();
    expect(screen.getByText('Voting closed')).toBeVisible();
    expect(screen.getByText(formatMinute(START_MINUTE + 30)).tagName).toBe('TIME');
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    for (const radio of radios()) expect(radio).toBeDisabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('leads a failed Proposal with the outcome, then both texts', () => {
    const { log, proposalId } = openVote();
    log.vote('ana', proposalId, 1);
    log.vote('ben', proposalId, 0, 'It ends band practice.');
    setup({ state: log.state(), proposalId, me: 'ben' });

    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('This didn’t pass.');
    expect(screen.getByRole('region', { name: 'Section 1 now reads' })).toHaveTextContent(
      'Quiet hours start at ten.',
    );
    expect(screen.getByRole('textbox')).toHaveValue('It ends band practice.');
  });

  it('shows a lapse, gently, once relay time passes the deadline with too few ballots', async () => {
    const { log, proposalId } = openVote();
    log.vote('ana', proposalId, 4);
    const deadline = deadlineOf(START_MINUTE);
    setup({ state: log.state(deadline), proposalId, now: deadline });

    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('Not enough people weighed in. This isn’t a no.');
    expect(screen.getByRole('region', { name: 'Section 1 now reads' })).toBeVisible();
    for (const radio of radios()) expect(radio).toBeDisabled();
    expect(screen.getByRole('radio', { name: '4 · Strongly supportive' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('starts the ballot from this member’s latest ballot, sent or waiting to send', () => {
    const { log, proposalId } = openVote();
    log.vote('ben', proposalId, 1, 'Too late for me.');
    const waiting = pendingEvent({
      type: 'vote',
      group: log.group,
      author: 'ben',
      ts: 0,
      body: { proposal: proposalId, scores: { [proposalId]: 2 }, note: 'Fine on weekends.' },
    });
    const { rerender } = setup({ state: log.state(), proposalId, me: 'ben' });
    expect(screen.getByRole('radio', { name: '1 · Opposed' })).toBeChecked();
    expect(screen.getByRole('textbox')).toHaveValue('Too late for me.');
    expect(screen.getByRole('button', { name: 'Update your vote' })).toBeVisible();

    rerender({ proposalId: 'other' });
    rerender({ proposalId, pending: [waiting], reachable: false });
    expect(screen.getByRole('radio', { name: '2 · Neutral' })).toBeChecked();
    expect(screen.getByRole('textbox')).toHaveValue('Fine on weekends.');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved on this device. It will send when you’re back online.',
    );
  });

  it('shows a new Proposal while it waits to send, then that it was sent', async () => {
    const log = groupLog();
    const waiting = pendingEvent({
      type: 'proposal',
      group: log.group,
      author: 'ana',
      ts: 0,
      body: { atom: `${log.group}.0`, ...PROPOSAL },
    });
    const { rerender } = setup({
      state: log.state(),
      proposalId: waiting.id,
      pending: [waiting],
      reachable: false,
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Later quiet hours' })).toBeVisible();
    expect(screen.getByText('Weekends run late.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Proposed text' })).toHaveTextContent(
      'Quiet after 11pm.',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device.');
    expect(radios()).toEqual([]);
    expect(await axeViolations()).toEqual([]);

    rerender({ pending: [waiting], reachable: true });
    expect(screen.getByRole('status')).toHaveTextContent('Sending…');

    // Sent, but not yet read back from the relay: still this Proposal, not "missing".
    rerender({ pending: [] });
    expect(screen.getByRole('status')).toHaveTextContent(/^Sent$/);
    expect(screen.getByRole('heading', { level: 1, name: 'Later quiet hours' })).toBeVisible();
  });

  it('says when the Proposal isn’t on this device', async () => {
    const log = groupLog();
    setup({ state: log.state(), proposalId: 'missing' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This Proposal isn’t on this device' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      `#/g/${log.group}`,
    );
    expect(await axeViolations()).toEqual([]);
  });
});
