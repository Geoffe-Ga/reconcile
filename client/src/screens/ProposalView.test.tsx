import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute } from '../app/time';
import { LEVELS } from '../engine/capabilities';
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
import { authorOf } from '../test/keys';
import { ProposalView, type ProposalViewProps } from './ProposalView';

type OnVote = (scores: Readonly<Record<string, Score>>, note: string) => Promise<void>;

const [FOLLOWING, VOTING] = LEVELS;

interface Setup {
  readonly state: GroupState;
  readonly proposalId: string;
  readonly me?: string;
  readonly now?: number;
  readonly pending?: readonly ParsedEvent[];
  readonly reachable?: boolean;
}

function setup({
  state,
  proposalId,
  me = authorOf('ana'),
  now,
  pending = [],
  reachable = true,
}: Setup) {
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

/** The text one side of a word diff reads: its shared runs and that side's changes. */
function side(region: HTMLElement, keep: 'ins' | 'del'): string {
  const diff = region.querySelector('.word-diff');
  if (diff === null) throw new Error('Expected a word diff.');
  const copy = diff.cloneNode(true) as HTMLElement;
  for (const node of Array.from(
    copy.querySelectorAll(`${keep === 'ins' ? 'del' : 'ins'}, .diff-label`),
  )) {
    node.remove();
  }
  return copy.textContent;
}

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('ProposalView', () => {
  it('shows the title, why, the change as a word diff, a countdown and the ballot', async () => {
    const { log, proposalId } = openVote();
    setup({ state: log.state(), proposalId });

    expect(screen.getByRole('heading', { level: 1, name: 'Later quiet hours' })).toBeVisible();
    expect(screen.getByText('Open Proposal', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Weekends run late.')).toBeVisible();
    expect(screen.getByText(/^Proposed by/)).toHaveTextContent(/^Proposed by Ana$/);
    expect(screen.getByText('Closes in 7 days')).toBeVisible();
    const deadline = deadlineOf(START_MINUTE);
    expect(screen.getByText(formatMinute(deadline)).tagName).toBe('TIME');
    const changes = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(side(changes, 'del')).toBe('Quiet hours start at ten.');
    expect(side(changes, 'ins')).toBe('Quiet after 11pm.');
    expect(changes.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(changes.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(
      within(changes).getByText(
        'Added words are underlined and highlighted. Removed words are struck through.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Section 1 now reads' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Proposed text' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/later',
    );
    const version = within(changes).getByRole('region', { name: 'Version 1 · Ana' });
    const pills = within(version).getByRole('radiogroup', { name: 'Score for version 1' });
    expect(within(pills).getAllByRole('radio')).toHaveLength(5);
    expect(within(changes).getByRole('button', { name: 'Send your vote' })).toBeEnabled();
    expect(within(changes).getByRole('link', { name: 'Add your version' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/propose/${log.group}.0`,
    );
    expect(screen.getByRole('main')).not.toHaveClass('shell-wide');
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
    expect(document.title).toBe('Proposal · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows how the proposed text will read, formatted, behind a disclosure', async () => {
    const log = groupLog();
    const proposalId = log.propose('ana', {
      text: '# Quiet\n\nAfter **11pm**, see [the notice](https://example.org/n).\n',
    });
    const { user } = setup({ state: log.state(), proposalId });
    const toggle = screen.getByRole('button', { name: 'How it will read' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The diff shows the source, so the link's target is in plain view.
    const changes = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(side(changes, 'ins')).toContain('[the notice](https://example.org/n)');
    expect(within(changes).queryByRole('heading', { name: 'Quiet' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(changes).getByRole('heading', { level: 2, name: 'Quiet' })).toBeVisible();
    expect(within(changes).getByText('11pm', { selector: 'strong' })).toBeVisible();
    expect(within(changes).getByRole('link', { name: /the notice/ })).toHaveAttribute(
      'href',
      'https://example.org/n',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows hostile proposed text as inert source in the diff and as inert text when formatted', async () => {
    const log = groupLog();
    const proposalId = log.propose('ana', {
      text: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>alert(2)</script>\n',
    });
    const { user } = setup({ state: log.state(), proposalId });
    await user.click(screen.getByRole('button', { name: 'How it will read' }));
    const changes = screen.getByRole('region', { name: 'Changes to section 1' });
    const version = within(changes).getByRole('region', { name: 'Version 1 · Ana' });
    expect(version.querySelector('img, script, a')).toBeNull();
    expect(side(changes, 'ins')).toContain('<img src=x onerror=alert(1)>');
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

  it('names a proposer who shares a name with another member with a key suffix', () => {
    const log = groupLog({ founder: 'Sam', members: ['SAM '] });
    const proposalId = log.propose('sam', PROPOSAL);
    setup({ state: log.state(), proposalId, me: authorOf('sam') });
    expect(screen.getByText(/^Proposed by/)).toHaveTextContent(/^Proposed by Sam · [0-9a-f]{4}$/);
  });

  it('sends the ballot as this member', async () => {
    const { log, proposalId } = openVote();
    const { user, onVote } = setup({ state: log.state(), proposalId, me: authorOf('ben') });
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [proposalId]: 4 }, '');
  });

  it('tells someone who joined after it opened why they can’t vote, with no pills', async () => {
    const { log, proposalId } = openVote();
    log.join('Cy');
    setup({ state: log.state(), proposalId, me: authorOf('cy') });
    expect(
      screen.getByText('You joined after this opened, so you can’t vote on it.'),
    ).toBeVisible();
    expect(radios()).toEqual([]);
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('never sends a late joiner to change their level, when their level votes', () => {
    const { log, proposalId } = openVote();
    log.join('Cy');
    setup({ state: log.state(), proposalId, me: authorOf('cy') });
    expect(screen.queryByText(/voting level/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /involvement/ })).not.toBeInTheDocument();
  });

  it('tells a Member why they can’t vote, and where they choose their level (#166)', async () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    const proposalId = log.propose('ana', PROPOSAL);
    setup({ state: log.state(), proposalId, me: authorOf('kim') });
    const vote = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(vote).toHaveTextContent(
      'You weren’t at a voting level when this opened, so you can’t vote on it.',
    );
    expect(vote).not.toHaveTextContent('You joined after this opened');
    expect(within(vote).getByRole('link', { name: 'Change your involvement' })).toHaveAttribute(
      'href',
      `#/g/${log.group}`,
    );
    expect(radios()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps that reason, with no pills, after a Member steps up while it’s open', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    const proposalId = log.propose('ana', PROPOSAL);
    log.level('kim', VOTING);
    setup({ state: log.state(), proposalId, me: authorOf('kim') });
    expect(
      screen.getByText('You weren’t at a voting level when this opened, so you can’t vote on it.'),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).not.toBeInTheDocument();
    expect(radios()).toEqual([]);
  });

  it('tells someone who stepped down since it opened how to vote on it again', async () => {
    const { log, proposalId } = openVote();
    log.level('ben', FOLLOWING);
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    const vote = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(vote).toHaveTextContent(
      'You’re following this group. Choose Collaborator or Co-Creator to vote or propose.',
    );
    expect(vote).not.toHaveTextContent(/opened/);
    expect(within(vote).getByRole('link', { name: 'Change your involvement' })).toBeVisible();
    expect(radios()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a closed Proposal’s ballot, unchangeable, to someone in its eligible set who stepped down', () => {
    const { log, proposalId } = openVote();
    log.vote('ben', proposalId, 3);
    log.level('ben', FOLLOWING);
    const deadline = deadlineOf(START_MINUTE);
    setup({ state: log.state(deadline), proposalId, me: authorOf('ben'), now: deadline });
    expect(screen.getByText('Voting has closed, so this ballot can’t change.')).toBeVisible();
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    expect(screen.queryByText(/You’re following this group/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).not.toBeInTheDocument();
  });

  it('gives the ballot back once they step up again before the deadline', () => {
    const { log, proposalId } = openVote();
    log.level('ben', FOLLOWING);
    log.level('ben', VOTING);
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    expect(radios()).toHaveLength(5);
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
    expect(screen.queryByRole('region', { name: 'Changes to section 1' })).not.toBeInTheDocument();
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    expect(ballot.querySelector('.word-diff')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your version' })).not.toBeInTheDocument();
    expect(screen.getByText('Voting closed')).toBeVisible();
    expect(screen.getByText(formatMinute(START_MINUTE + 30)).tagName).toBe('TIME');
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    for (const radio of radios()) expect(radio).toBeDisabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('sets a passed Proposal’s new text as the Document will read it', () => {
    const log = groupLog();
    const proposalId = log.propose('ana', { text: 'Quiet after **11pm**.\n' });
    log.vote('ana', proposalId, 3);
    log.vote('ben', proposalId, 4);
    setup({ state: log.state(), proposalId });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('11pm', { selector: 'strong' })).toBeVisible();
    expect(result.querySelector('.atom-text')).not.toBeNull();
  });

  it('leads a failed Proposal with the outcome, then the change', () => {
    const { log, proposalId } = openVote();
    log.vote('ana', proposalId, 1);
    log.vote('ben', proposalId, 0, 'It ends band practice.');
    setup({ state: log.state(), proposalId, me: authorOf('ben') });

    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('This didn’t pass.');
    const changes = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(side(changes, 'del')).toBe('Quiet hours start at ten.');
    expect(precedes(result, changes)).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue('It ends band practice.');
  });

  it('shows a lapse, gently, once relay time passes the deadline with too few ballots', async () => {
    const { log, proposalId } = openVote();
    log.vote('ana', proposalId, 4);
    const deadline = deadlineOf(START_MINUTE);
    setup({ state: log.state(deadline), proposalId, now: deadline });

    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent('Not enough people weighed in. This isn’t a no.');
    expect(screen.getByRole('region', { name: 'Changes to section 1' })).toBeVisible();
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
      author: authorOf('ben'),
      ts: 0,
      body: { proposal: proposalId, scores: { [proposalId]: 2 }, note: 'Fine on weekends.' },
    });
    const { rerender } = setup({ state: log.state(), proposalId, me: authorOf('ben') });
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
      author: authorOf('ana'),
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
    expect(side(screen.getByRole('region', { name: 'Changes to section 1' }), 'ins')).toBe(
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

  it('offers no Add your version once relay time passes the deadline, or to a non-member', () => {
    const { log, proposalId } = openVote();
    const deadline = deadlineOf(START_MINUTE);
    const { rerender } = setup({ state: log.state(deadline - 1), proposalId, now: deadline });
    expect(screen.queryByRole('link', { name: 'Add your version' })).not.toBeInTheDocument();
    rerender({ now: START_MINUTE + 60, me: authorOf('zed') });
    expect(screen.queryByRole('link', { name: 'Add your version' })).not.toBeInTheDocument();
  });
});

/** Ana's open Proposal, with Ben's and then Cy's versions, in a group of Ana, Ben and Cy. */
function versionsVote(count: 2 | 3) {
  const log = groupLog({ members: ['Ben', 'Cy'] });
  const proposalId = log.propose('ana', PROPOSAL);
  const ids = [proposalId, log.version('ben', proposalId, 'Quiet after midnight.')];
  if (count === 3) ids.push(log.version('cy', proposalId, 'Quiet after 10pm.'));
  return { log, proposalId, ids };
}

describe('ProposalView, with several versions', () => {
  it('sets the versions side by side in a wider shell, each with its diff and own pills', async () => {
    const { log, proposalId } = versionsVote(3);
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    expect(screen.getByRole('main')).toHaveClass('shell', 'shell-wide');
    const changes = screen.getByRole('region', { name: 'Changes to section 1' });
    const names = ['Version 1 · Ana', 'Version 2 · Ben', 'Version 3 · Cy'];
    const texts = ['Quiet after 11pm.', 'Quiet after midnight.', 'Quiet after 10pm.'];
    names.forEach((name, i) => {
      const version = within(changes).getByRole('region', { name });
      expect(side(version, 'ins')).toBe(texts[i]);
      expect(side(version, 'del')).toBe('Quiet hours start at ten.');
      const group = within(version).getByRole('radiogroup', {
        name: `Score for version ${String(i + 1)}`,
      });
      expect(within(group).getAllByRole('radio')).toHaveLength(5);
    });
    expect(changes.querySelector('.versions')).toHaveClass('versions-3');
    expect(within(changes).getAllByRole('textbox')).toHaveLength(1);
    expect(within(changes).queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(within(changes).getByText('This ballot already has three versions.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends a score for every version, keyed by version id', async () => {
    const { log, proposalId, ids } = versionsVote(2);
    const { user, onVote } = setup({ state: log.state(), proposalId, me: authorOf('cy') });
    const [first = '', second = ''] = ids;
    const pick = async (n: number, pill: string) => {
      const group = screen.getByRole('radiogroup', { name: `Score for version ${String(n)}` });
      await user.click(within(group).getByRole('radio', { name: pill }));
    };
    await pick(1, '3 · Supportive');
    await pick(2, '4 · Strongly supportive');
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [first]: 3, [second]: 4 }, '');
  });

  it('asks a voter whose latest ballot misses a new version to score it, keeping the rest', async () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana', PROPOSAL);
    log.vote('ben', proposalId, 3, undefined);
    log.version('ana', proposalId, 'Quiet after midnight.');
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    expect(
      screen.getByText('A new version was added. Score it to update your ballot.'),
    ).toBeVisible();
    const first = screen.getByRole('radiogroup', { name: 'Score for version 1' });
    expect(within(first).getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    const second = screen.getByRole('radiogroup', { name: 'Score for version 2' });
    for (const radio of within(second).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Update your vote' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('names the winning version when several were on the ballot', async () => {
    const { log, proposalId, ids } = versionsVote(2);
    const [first = '', second = ''] = ids;
    for (const name of ['ana', 'ben', 'cy']) {
      log.ballot(name, proposalId, { [first]: 2, [second]: 4 });
    }
    setup({ state: log.state(), proposalId });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(result).toHaveTextContent(
      'Version 2 passed. The Document now reads:Quiet after midnight.',
    );
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    expect(within(ballot).getByRole('region', { name: 'Version 2 · Ben' })).toHaveTextContent(
      'Quiet after midnight.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the versions with no pills to someone who joined after it opened', () => {
    const { log, proposalId } = versionsVote(2);
    log.join('Dee');
    setup({ state: log.state(), proposalId, me: authorOf('dee') });
    expect(screen.getByRole('region', { name: 'Version 2 · Ben' })).toBeVisible();
    expect(radios()).toEqual([]);
    expect(
      screen.getByText('You joined after this opened, so you can’t vote on it.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add your version' })).toBeVisible();
  });

  it('shows this member’s version while it waits to send', async () => {
    const { log, proposalId } = openVote();
    const waiting = pendingEvent({
      type: 'version',
      group: log.group,
      author: authorOf('ben'),
      ts: 0,
      body: { proposal: proposalId, text: 'Quiet after midnight.' },
    });
    setup({
      state: log.state(),
      proposalId,
      me: authorOf('ben'),
      pending: [waiting],
      reachable: false,
    });
    const mine = screen.getByRole('region', { name: 'Your version' });
    expect(side(mine, 'ins')).toBe('Quiet after midnight.');
    expect(within(mine).getByRole('status')).toHaveTextContent(
      'Saved on this device. It will send when you’re back online.',
    );
    expect(await axeViolations()).toEqual([]);
  });
});

describe('ProposalView, adding and removing sections', () => {
  it('shows an add as a new section: each version says where it goes, all its text added', async () => {
    const log = groupLog({ members: ['Ben'] });
    const add = log.addSection('ana', `${log.group}.1`, { title: 'Guests' });
    const second = log.version('ben', add, 'Guests leave by midnight.\n');
    const { user, onVote } = setup({ state: log.state(), proposalId: add });
    const block = screen.getByRole('region', { name: 'New section' });
    expect(within(block).getByText(/^Added words are underlined/)).toBeVisible();
    for (const [name, text] of [
      ['Version 1 · Ana', 'Guests leave by 11pm.\n'],
      ['Version 2 · Ben', 'Guests leave by midnight.\n'],
    ] as const) {
      const version = within(block).getByRole('region', { name });
      const lines = Array.from(version.querySelectorAll('h3 ~ *')).map((node) => node.className);
      expect(lines.slice(0, 2)).toEqual(['version-does', 'word-diff']);
      expect(
        within(version).getByText('Adds a section after ‘Bins go out on Tuesday.’'),
      ).toBeVisible();
      expect(side(version, 'ins')).toBe(text);
      expect(side(version, 'del')).toBe('');
      expect(within(version).getByRole('button', { name: 'How it will read' })).toBeVisible();
    }
    expect(screen.getByRole('link', { name: 'Add your version' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/propose/${add}`,
    );
    expect(await axeViolations()).toEqual([]);
    for (const [index, group] of screen.getAllByRole('radiogroup').entries()) {
      await user.click(within(group).getByText(index === 0 ? 'Supportive' : 'Strongly supportive'));
    }
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [add]: 3, [second]: 4 }, '');
  });

  it('says an add at the start goes there', () => {
    const log = groupLog();
    const add = log.addSection('ana', null);
    setup({ state: log.state(), proposalId: add });
    expect(screen.getByText('Adds a section at the start')).toBeVisible();
  });

  it('puts a removal on a rewording’s ballot: it says so, and strikes the whole section through', async () => {
    const log = groupLog({ members: ['Ben'] });
    const proposalId = log.propose('ana', {
      atom: 1,
      title: 'Bins on Monday',
      text: 'Bins go out on Monday.\n',
    });
    log.version('ben', proposalId, '');
    setup({ state: log.state(), proposalId });
    const block = screen.getByRole('region', { name: 'Changes to section 2' });
    const rewording = within(block).getByRole('region', { name: 'Version 1 · Ana' });
    expect(rewording.querySelector('.version-does')).toBeNull();
    const removing = within(block).getByRole('region', { name: 'Version 2 · Ben' });
    expect(within(removing).getByText('Removes this section')).toBeVisible();
    expect(side(removing, 'del')).toBe('Bins go out on Tuesday.');
    expect(side(removing, 'ins')).toBe('');
    expect(within(removing).queryByRole('button', { name: 'How it will read' })).toBeNull();
    expect(within(removing).getByRole('radiogroup', { name: 'Score for version 2' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a passed removal took the section out, naming its version when there were several', async () => {
    const log = groupLog({ members: ['Ben'] });
    const alone = log.propose('ana', { atom: 0, text: '' });
    log.vote('ana', alone, 4);
    log.vote('ben', alone, 4);
    const shared = log.propose('ana', { atom: 1, text: 'Bins go out on Monday.\n' });
    const removal = log.version('ben', shared, '');
    log.ballot('ana', shared, { [shared]: 2, [removal]: 4 });
    log.ballot('ben', shared, { [shared]: 2, [removal]: 4 });
    const state = log.state();
    expect(state.atoms).toEqual([]);
    const { rerender } = setup({ state, proposalId: alone });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(
      within(result)
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual(['This passed. The Document no longer has this section.']);
    const onBallot = screen.getByRole('region', { name: 'On the ballot' });
    expect(within(onBallot).getByText('Removes this section')).toBeVisible();
    expect(onBallot.querySelector('.atom-card')).toBeNull();
    rerender({ proposalId: shared });
    expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent(
      /^ResultVersion 2 passed\. The Document no longer has this section\.$/,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a new add while it waits to send, saying where it goes', () => {
    const log = groupLog();
    const waiting = pendingEvent({
      type: 'proposal',
      group: log.group,
      author: authorOf('ana'),
      ts: 0,
      body: { target: { kind: 'add', after: null }, ...PROPOSAL },
    });
    setup({ state: log.state(), proposalId: waiting.id, pending: [waiting] });
    const block = screen.getByRole('region', { name: 'New section' });
    expect(within(block).getByText('Adds a section at the start')).toBeVisible();
    expect(side(block, 'ins')).toBe('Quiet after 11pm.');
  });
});

describe('ProposalView, missing', () => {
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
