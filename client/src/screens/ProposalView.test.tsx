import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type ChatDetails, type ChatMoment, chatMessage } from '../app/chatMessages';
import type { ShareOutcome } from '../app/share';
import { formatMinute } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import { DAY_MINUTES } from '../engine/rules';
import {
  createEvent,
  type EventInput,
  type ParsedEvent,
  parseEvent,
  type Score,
} from '../engine/event';
import type { GroupState } from '../engine/fold';
import type { OwnBallot } from '../engine/ownBallot';
import { axeViolations } from '../test/axe';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { authorOf } from '../test/keys';
import { ProposalView, type ProposalViewProps } from './ProposalView';

type OnVote = (scores: Readonly<Record<string, Score>>, note: string) => Promise<void>;
type OnTell = (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;

const [FOLLOWING, VOTING] = LEVELS;

interface Setup {
  readonly state: GroupState;
  readonly proposalId: string;
  readonly me?: string;
  readonly now?: number;
  readonly pending?: readonly ParsedEvent[];
  readonly reachable?: boolean;
  readonly own?: OwnBallot;
  readonly leaving?: boolean;
  readonly onTell?: OnTell;
}

function setup({
  state,
  proposalId,
  me = authorOf('ana'),
  now,
  pending = [],
  reachable = true,
  own = 'none',
  leaving = false,
  onTell = vi.fn<OnTell>(() => Promise.resolve('copied')),
}: Setup) {
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  const onProposeAgain = vi.fn();
  const props: ProposalViewProps = {
    state,
    me,
    proposalId,
    pending,
    reachable,
    now: now ?? START_MINUTE + 60,
    own,
    leaving,
    onVote,
    onProposeAgain,
    onTell,
  };
  const view = render(<ProposalView {...props} />);
  const rerender = (next: Partial<ProposalViewProps>) => {
    view.rerender(<ProposalView {...props} {...next} />);
  };
  return { user: userEvent.setup(), onVote, onProposeAgain, onTell, rerender };
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

  it('says how long voting runs, beside the countdown and its date: the window chosen (#106)', async () => {
    const log = groupLog();
    const proposalId = log.propose('ana', { ...PROPOSAL, window: 10 });
    setup({ state: log.state(), proposalId });

    const runs = screen.getByText('Voting runs 10 days');
    expect(runs).toBeVisible();
    const meta = runs.closest('.meta-lines');
    expect(meta).toContainElement(screen.getByText('Closes in 10 days'));
    const deadline = START_MINUTE + 10 * 1_440;
    const time = screen.getByText(formatMinute(deadline));
    expect(time.tagName).toBe('TIME');
    expect(meta).toContainElement(time);
    expect(await axeViolations()).toEqual([]);
  });

  it('says a default window too, and stops saying it once voting has closed', () => {
    const { log, proposalId } = openVote();
    const { rerender } = setup({ state: log.state(), proposalId });
    expect(screen.getByText('Voting runs 7 days')).toBeVisible();
    const deadline = deadlineOf(START_MINUTE);
    rerender({ state: log.state(deadline), now: deadline });
    expect(screen.getByText('Voting closed')).toBeVisible();
    expect(screen.queryByText(/^Voting runs/)).not.toBeInTheDocument();
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
    const countdown = screen.getByText('Voting closed').closest('.countdown');
    expect(countdown).toBeVisible();
    expect(
      within(countdown as HTMLElement).getByText(formatMinute(START_MINUTE + 30)).tagName,
    ).toBe('TIME');
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
    // The ballot's own status line: Tell your group, offered to everyone, has one too (#113).
    const vote = screen.getByRole('region', { name: 'Changes to section 1' });
    expect(within(vote).getByRole('status')).toHaveTextContent(
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

describe('ProposalView, the consent meter and the result', () => {
  const meter = (n: number) =>
    screen.getByRole('group', { name: `How version ${String(n)} stands so far` });

  it('shows each version’s consent meter on an open ballot, live from the ballots so far', async () => {
    const { log, proposalId, ids } = versionsVote(2);
    const [first = '', second = ''] = ids;
    log.ballot('ana', proposalId, { [first]: 4, [second]: 0 }, 'Too late.');
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    const one = within(screen.getByRole('region', { name: 'Version 1 · Ana' }));
    expect(one.getByRole('group', { name: 'How version 1 stands so far' })).toBe(meter(1));
    const [average1] = within(meter(1)).getAllByRole('meter');
    expect(average1).toHaveAttribute('aria-valuetext', '4.0 · Passes');
    expect(meter(1)).toHaveTextContent('Scored by 1 · needs 3');
    const [, zeros2] = within(meter(2)).getAllByRole('meter');
    expect(zeros2).toHaveAttribute('aria-valuetext', '100% · Too many zeros: 1 of 1');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the meters to someone who can’t vote, too', () => {
    const { log, proposalId } = openVote();
    log.join('Cy');
    setup({ state: log.state(), proposalId, me: authorOf('cy') });
    expect(radios()).toEqual([]);
    expect(meter(1)).toHaveTextContent('No scores yet');
  });

  it('shows no meter once the vote has closed, and leads with the result instead', () => {
    const { log, proposalId } = openVote();
    log.vote('ana', proposalId, 3);
    log.vote('ben', proposalId, 4);
    setup({ state: log.state(), proposalId });
    expect(screen.queryByRole('group', { name: /stands so far/ })).not.toBeInTheDocument();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('Thank you,', { exact: false })).toHaveTextContent(
      'Thank you, Ana.',
    );
    expect(within(result).getByRole('list', { name: 'Totals' })).toHaveTextContent(
      'Scored by 2 · average 3.5 · no zeros',
    );
  });

  it('tells this member when their ballot reached the relay too late to count', () => {
    const { log, proposalId } = openVote();
    const deadline = deadlineOf(START_MINUTE);
    setup({ state: log.state(deadline), proposalId, now: deadline, own: 'late' });
    expect(
      screen.getByText('Your vote arrived after voting closed and wasn’t counted.'),
    ).toBeVisible();
  });

  it('proposes a lapsed Proposal again from its result', async () => {
    const { log, proposalId } = openVote();
    const deadline = deadlineOf(START_MINUTE);
    const { user, onProposeAgain } = setup({
      state: log.state(deadline),
      proposalId,
      now: deadline,
    });
    await user.click(screen.getByRole('button', { name: 'Propose again' }));
    expect(onProposeAgain).toHaveBeenCalledTimes(1);
  });
});

describe('ProposalView, Tell your group', () => {
  const tellButton = () => screen.queryByRole('button', { name: 'Tell your group' });
  const DEADLINE = deadlineOf(START_MINUTE);

  it.each(['ana', 'ben'])(
    'offers everyone the open message while the vote is open (%s)',
    async (me) => {
      const { log, proposalId } = openVote();
      const { user, onTell } = setup({ state: log.state(), proposalId, me: authorOf(me) });

      expect(screen.getByText(chatMessage('open', { deadline: DEADLINE }))).toBeVisible();
      await user.click(tellButton() as HTMLElement);

      expect(onTell).toHaveBeenCalledExactlyOnceWith('open', { deadline: DEADLINE });
      expect(await screen.findByText('Copied. Paste it into your group’s chat.')).toBeVisible();
      expect(await axeViolations()).toEqual([]);
    },
  );

  it('offers someone who added a version the version’s line', async () => {
    const { log, proposalId } = openVote();
    log.version('ben', proposalId, 'Quiet after midnight.');
    const { user, onTell } = setup({ state: log.state(), proposalId, me: authorOf('ben') });
    await user.click(tellButton() as HTMLElement);
    expect(onTell).toHaveBeenCalledExactlyOnceWith('version', { deadline: DEADLINE });
  });

  it('shares the title only once someone ticks Include the title', async () => {
    const { log, proposalId } = openVote();
    const { user, onTell } = setup({ state: log.state(), proposalId, me: authorOf('ben') });
    await user.click(screen.getByRole('checkbox', { name: 'Include the title' }));
    await user.click(tellButton() as HTMLElement);
    expect(onTell).toHaveBeenCalledExactlyOnceWith('open', {
      deadline: DEADLINE,
      title: 'Later quiet hours',
    });
  });

  it.each([3, 14])(
    'offers the closing message only from a day before the close until it (%i-day window)',
    async (window) => {
      const log = groupLog();
      const proposalId = log.propose('ana', { ...PROPOSAL, window });
      const deadline = START_MINUTE + window * DAY_MINUTES;
      const closing = chatMessage('closing', { deadline });
      const { rerender } = setup({ state: log.state(), proposalId, now: deadline - 1_441 });
      expect(screen.getByText(chatMessage('open', { deadline }))).toBeVisible();
      expect(screen.queryByText(closing)).not.toBeInTheDocument();

      for (const now of [deadline - DAY_MINUTES, deadline - 1]) {
        rerender({ now });
        expect(screen.getByText(closing)).toBeVisible();
        expect(tellButton()).toBeVisible();
      }
      expect(await axeViolations()).toEqual([]);

      rerender({ now: deadline });
      expect(screen.queryByText(closing)).not.toBeInTheDocument();
      expect(tellButton()).not.toBeInTheDocument();
    },
  );

  it('shares the closing message from the closing day, with a fresh, unticked box', async () => {
    const { log, proposalId } = openVote();
    const { user, onTell, rerender } = setup({ state: log.state(), proposalId });
    await user.click(screen.getByRole('checkbox', { name: 'Include the title' }));
    rerender({ now: DEADLINE - DAY_MINUTES });
    expect(screen.getByRole('checkbox', { name: 'Include the title' })).not.toBeChecked();
    await user.click(tellButton() as HTMLElement);
    expect(onTell).toHaveBeenCalledExactlyOnceWith('closing', { deadline: DEADLINE });
  });

  it('offers the result message, not the open one, once the vote has closed', async () => {
    const { log, proposalId } = openVote();
    const { user, onTell } = setup({
      state: log.state(DEADLINE),
      proposalId,
      now: DEADLINE,
    });
    expect(screen.getAllByRole('button', { name: 'Tell your group' })).toHaveLength(1);
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('A vote has finished in Reconcile.')).toBeVisible();
    await user.click(within(result).getByRole('button', { name: 'Tell your group' }));
    expect(onTell).toHaveBeenCalledExactlyOnceWith('result', { deadline: DEADLINE });
    expect(await axeViolations()).toEqual([]);
  });

  it('offers it only once the relay has the Proposal, since only then is its deadline known', () => {
    const { log } = openVote();
    const waiting = pendingEvent({
      type: 'proposal',
      group: log.group,
      author: authorOf('ana'),
      ts: 0,
      body: { atom: `${log.group}.1`, title: 'Bins', why: 'W', text: 'Bins out on Monday.' },
    });
    setup({ state: log.state(), proposalId: waiting.id, pending: [waiting] });
    expect(screen.getByRole('heading', { level: 1, name: 'Bins' })).toBeVisible();
    expect(tellButton()).not.toBeInTheDocument();
  });
});

describe('ProposalView, while leaving', () => {
  it('takes no vote, version or share, and says why', async () => {
    const { log, proposalId } = openVote();
    setup({ state: log.state(), proposalId, leaving: true });

    expect(radios()).toHaveLength(0);
    expect(screen.getByText('You’re leaving this group, so you can’t vote here.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add your version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tell your group' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Propose again on a lapsed Proposal', () => {
    const { log, proposalId } = openVote();
    const now = deadlineOf(START_MINUTE);
    setup({ state: log.state(now), proposalId, now, leaving: true });
    expect(screen.getByText('Not enough people weighed in. This isn’t a no.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).not.toBeInTheDocument();
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

describe('ProposalView: a priority vote (#107)', () => {
  const SEVEN = [
    'Fix the website',
    'Plan the picnic',
    'New bylaws',
    'Rent strike',
    'Fund the food bank',
    'Repaint the hall',
    'Start a **newsletter**',
  ];

  /** Ana asks about seven options in a group of Ana and Ben; the vote is still open. */
  function sevenOptions() {
    const log = groupLog();
    const proposalId = log.ask('ana', SEVEN);
    return { log, proposalId };
  }

  it('shows each option as plain text with its own pills and meter, and no Add your version', async () => {
    const { log, proposalId } = sevenOptions();
    setup({ state: log.state(), proposalId });
    expect(screen.getByText('Priority vote', { selector: 'p' })).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: 'What should we focus on?' }),
    ).toBeVisible();
    const options = screen.getByRole('region', { name: 'Options' });
    expect(
      within(options).getByText(
        'Score each option. The options that pass rank by their average, and the top one becomes your group’s focus.',
      ),
    ).toBeVisible();
    for (const option of SEVEN) {
      const card = within(options).getByRole('region', { name: option });
      expect(within(card).getByRole('radiogroup', { name: `Score for ${option}` })).toBeVisible();
      expect(
        within(card).getByRole('group', { name: `How ${option} stands so far` }),
      ).toBeVisible();
      expect(within(card).getAllByRole('radio')).toHaveLength(5);
    }
    // Plain text in <bdi>, never Markdown.
    const markdown = within(options).getByRole('heading', { name: 'Start a **newsletter**' });
    expect(markdown.querySelector('bdi')?.textContent).toBe('Start a **newsletter**');
    expect(markdown.querySelector('strong')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends a score for every option, each under its option id', async () => {
    const log = groupLog();
    const proposalId = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    const { user, onVote } = setup({ state: log.state(), proposalId });
    const group = (name: string) => screen.getByRole('radiogroup', { name: `Score for ${name}` });
    await user.click(within(group('Fix the website')).getByRole('radio', { name: /^4/ }));
    await user.click(within(group('Plan the picnic')).getByRole('radio', { name: /^2/ }));
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [`${proposalId}.0`]: 4, [`${proposalId}.1`]: 2 }, '');
  });

  it('shows the options without pills to someone who can’t vote on it', () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: FOLLOWING } });
    const proposalId = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    setup({ state: log.state(), proposalId, me: authorOf('ben') });
    const options = screen.getByRole('region', { name: 'Options' });
    expect(within(options).getByRole('region', { name: 'Fix the website' })).toBeVisible();
    expect(radios()).toEqual([]);
  });

  it('leads with the ranking once it closes, under “Closed priority vote”', () => {
    const log = groupLog();
    const proposalId = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    log.ballot('ana', proposalId, { [`${proposalId}.0`]: 3, [`${proposalId}.1`]: 4 });
    log.ballot('ben', proposalId, { [`${proposalId}.0`]: 3, [`${proposalId}.1`]: 4 });
    setup({ state: log.state(), proposalId });
    expect(screen.getByText('Closed priority vote', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText(/^Score each option\./)).toBeNull();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(
      within(result).getByText('Plan the picnic', { selector: '.result-focus bdi' }),
    ).toBeVisible();
  });

  it('shows a priority vote waiting in the outbox with its options', () => {
    const state = groupLog().state();
    const body = {
      target: { kind: 'priority' },
      title: 'What should we focus on?',
      why: 'One thing at a time.',
      options: ['Fix the website', 'Plan the picnic'],
    } as const;
    const event = pendingEvent({
      type: 'proposal',
      group: state.group ?? '',
      author: authorOf('ana'),
      ts: 0,
      body,
    });
    setup({ state, proposalId: event.id, pending: [event] });
    expect(
      screen.getByRole('heading', { level: 1, name: 'What should we focus on?' }),
    ).toBeVisible();
    const options = screen.getByRole('region', { name: 'Options' });
    expect(within(options).getByRole('region', { name: 'Plan the picnic' })).toBeVisible();
    expect(radios()).toEqual([]);
  });
});
