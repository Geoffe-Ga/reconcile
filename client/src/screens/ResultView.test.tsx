import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ChatDetails, ChatMoment } from '../app/chatMessages';
import type { ShareOutcome } from '../app/share';
import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { formatMinute, minuteIso } from '../app/time';
import { resultFor } from '../engine/expiry';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import { type OwnBallot, ownBallot } from '../engine/ownBallot';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, type LogBuilder, START_MINUTE } from '../test/votes';
import { ResultView } from './ResultView';

const [, VOTING] = LEVELS;
const ANA = authorOf('ana');
const DEADLINE = deadlineOf(START_MINUTE);

type OnTell = (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;

interface Shown {
  readonly state: GroupState;
  readonly proposalId: string;
  readonly me?: string;
  readonly own?: OwnBallot;
  readonly leaving?: boolean;
}

function show({ state, proposalId, me = ANA, own = 'none', leaving = false }: Shown) {
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  if (proposal === undefined) throw new Error('Expected the Proposal.');
  const onProposeAgain = vi.fn();
  const onTell = vi.fn<OnTell>(() => Promise.resolve('shared'));
  document.title = 'Proposal · Reconcile';
  render(
    <main>
      <h1>{proposal.title}</h1>
      <ResultView
        state={state}
        proposal={proposal}
        me={me}
        own={own}
        onProposeAgain={onProposeAgain}
        onTell={onTell}
        leaving={leaving}
      />
    </main>,
  );
  const result = screen.getByRole('region', { name: 'Result' });
  return { proposal, result, onProposeAgain, onTell, user: userEvent.setup() };
}

/** The block the outcome sentence leads: on a pass, the new text and the thanks. */
function outcomeBlock(result: HTMLElement): HTMLElement {
  const block = result.querySelector<HTMLElement>('.result-outcome');
  if (block === null) throw new Error('Expected the outcome block.');
  return block;
}

/** Ana proposes in a group of Ana, Ben and Cal; each of `scores` votes in turn, closing it early. */
function decided(scores: readonly [number, number, number]): {
  log: LogBuilder;
  proposalId: string;
} {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposalId = log.propose('ana');
  const voters = ['ana', 'ben', 'cal'];
  scores.forEach((score, i) => {
    log.minute += 10;
    const reason = score === 0 ? 'It ends too late.' : undefined;
    log.vote(voters[i] ?? '', proposalId, score as 0 | 1 | 2 | 3 | 4, reason);
  });
  return { log, proposalId };
}

/** Ana proposes, Ben adds a version, and all three score both; Ben's version wins. */
function bensVersionPasses() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposalId = log.propose('ana');
  const ben = log.version('ben', proposalId, 'Quiet after midnight.');
  log.minute += 5;
  log.ballot('ana', proposalId, { [proposalId]: 2, [ben]: 4 }, 'Either is fine.');
  log.ballot('ben', proposalId, { [proposalId]: 2, [ben]: 4 });
  log.ballot('cal', proposalId, { [proposalId]: 1, [ben]: 3 });
  return { log, proposalId, ben };
}

/** Ana proposes; only Ana and Ben vote by the deadline, so it lapses; Cal's ballot arrives at it. */
function lapsed() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposalId = log.propose('ana');
  log.minute += 30;
  log.vote('ana', proposalId, 4);
  log.vote('ben', proposalId, 3);
  log.minute = DEADLINE;
  log.vote('cal', proposalId, 4);
  return { log, proposalId };
}

/** The line that says when voting ran. */
function ran(result: HTMLElement): HTMLElement {
  const line = Array.from(result.querySelectorAll<HTMLElement>('p')).find((p) =>
    p.textContent.startsWith('Voting ran '),
  );
  if (line === undefined) throw new Error('Expected when voting ran.');
  return line;
}

/** Every button and link a result offers. */
function actions(result: HTMLElement): string[] {
  return [...within(result).queryAllByRole('button'), ...within(result).queryAllByRole('link')].map(
    (element) => element.textContent,
  );
}

describe('ResultView', () => {
  it('leads a pass with its sentence, the new text and thanks, and no numbers', async () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const { result } = show({ state: log.state(), proposalId });

    const block = outcomeBlock(result);
    const [sentence, text, thanks] = within(block).getAllByRole('paragraph');
    expect(sentence).toHaveTextContent('This passed. The Document now reads:');
    expect(text).toHaveTextContent('Quiet after 11pm.');
    expect(thanks).toHaveTextContent(/^Thank you, Ana\.$/);
    expect(thanks?.querySelector('bdi')).toHaveTextContent('Ana');
    expect(block).not.toHaveTextContent(/Scored by|average|zero|\d\.\d|%/);
    expect(precedes(sentence, within(result).getByText('Totals'))).toBe(true);
    expect(result.querySelectorAll('.celebration, canvas, [data-confetti]')).toHaveLength(0);
    expect(await axeViolations()).toEqual([]);
  });

  it('thanks the winning version’s author and the proposer, and names the version', () => {
    const { log, proposalId } = bensVersionPasses();
    const { result } = show({ state: log.state(), proposalId });
    const block = outcomeBlock(result);
    expect(within(block).getByText('Version 2 passed. The Document now reads:')).toBeVisible();
    expect(within(block).getByText('Quiet after midnight.')).toBeVisible();
    expect(within(block).getByText(/^Thank you,/)).toHaveTextContent(/^Thank you, Ben and Ana\.$/);
  });

  it('gives each version’s totals after the outcome', () => {
    const { log, proposalId } = bensVersionPasses();
    const { result } = show({ state: log.state(), proposalId });
    const totals = within(result).getByRole('list', { name: 'Totals' });
    const rows = within(totals).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Version 1 · AnaScored by 3 · average 1.6 · no zeros',
      'Version 2 · BenScored by 3 · average 3.6 · no zeros',
    ]);
  });

  it('names a fail on zeros, and the condition it missed', () => {
    const { log, proposalId } = decided([4, 4, 0]);
    const { result } = show({ state: log.state(), proposalId });
    const block = outcomeBlock(result);
    expect(
      within(block)
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual(['This didn’t pass.', 'Too many zeros: 1 of 3.']);
  });

  it('names a fail on the average, and how far short it fell', () => {
    const { log, proposalId } = decided([1, 1, 2]);
    const { result } = show({ state: log.state(), proposalId });
    const block = outcomeBlock(result);
    expect(
      within(block)
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual(['This didn’t pass.', 'Its average was 1.3, short of 2.0 by 0.7.']);
  });

  it('names each version’s unmet conditions when none of several passed', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposalId = log.propose('ana');
    const ben = log.version('ben', proposalId, 'Quiet after midnight.');
    log.ballot('ana', proposalId, { [proposalId]: 1, [ben]: 0 }, 'Too late.');
    log.ballot('ben', proposalId, { [proposalId]: 1, [ben]: 4 });
    log.ballot('cal', proposalId, { [proposalId]: 2, [ben]: 4 });
    const { result } = show({ state: log.state(), proposalId });
    const block = outcomeBlock(result);
    expect(
      within(block)
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual([
      'No version passed.',
      'Version 1: Its average was 1.3, short of 2.0 by 0.7.',
      'Version 2: Too many zeros: 1 of 3.',
    ]);
  });

  it('says a version below quorum didn’t reach it, among versions that failed', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposalId = log.propose('ana');
    const ben = log.version('ben', proposalId, 'Quiet after midnight.');
    log.minute += 1;
    log.ballot('ana', proposalId, { [proposalId]: 1, [ben]: 4 });
    log.ballot('ben', proposalId, { [proposalId]: 1, [ben]: 4 });
    // Cal scores only version 1, so the vote runs to its deadline.
    log.vote('cal', proposalId, 1);
    const { result } = show({ state: log.state(DEADLINE), proposalId });
    expect(
      within(outcomeBlock(result))
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual([
      'No version passed.',
      'Version 1: Its average was 1.0, short of 2.0 by 1.0.',
      'Version 2: Scored by 2, but it needed 3.',
    ]);
  });

  it('shows a lapse gently, and offers Propose again to someone who can propose', async () => {
    const { log, proposalId } = lapsed();
    const { result, onProposeAgain, user } = show({ state: log.state(DEADLINE), proposalId });
    const block = outcomeBlock(result);
    expect(within(block).getByRole('paragraph')).toHaveTextContent(
      'Not enough people weighed in. This isn’t a no.',
    );
    const again = within(block).getByRole('button', { name: 'Propose again' });
    expect(again).toBeEnabled();
    await user.click(again);
    expect(onProposeAgain).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('disables Propose again, and says why, while another Proposal is open on the section', () => {
    const { log, proposalId } = lapsed();
    log.minute = DEADLINE + 1;
    log.propose('ben', { title: 'Quiet at nine' });
    const { result } = show({ state: log.state(), proposalId });
    const again = within(result).getByRole('button', { name: 'Propose again' });
    expect(again).toBeDisabled();
    const reason = within(result).getByText(
      'This section has an open Proposal now. You can propose this again once it closes.',
    );
    expect(again.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
  });

  it('says a passed new Document reads as its winning text, naming the version when there were several (#92)', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const alone = log.newDocument('ana', 'Budget', { text: '# Budget\n\nWe share costs.\n' });
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, alone, 4);
    const { result } = show({ state: log.state(), proposalId: alone });
    const block = outcomeBlock(result);
    expect(block.querySelector('.outcome-sentence')).toHaveTextContent(
      /^This passed\. The new Document reads:$/,
    );
    expect(within(block).getByRole('heading', { name: 'Budget' })).toBeVisible();
    expect(within(block).getByText('We share costs.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    cleanup();
    const shared = log.newDocument('ana', 'Chores', { text: 'Ana cooks.\n' });
    const other = log.version('ben', shared, 'Ben cooks.\n');
    for (const name of ['ana', 'ben', 'cal']) log.ballot(name, shared, { [shared]: 2, [other]: 4 });
    const second = show({ state: log.state(), proposalId: shared });
    expect(outcomeBlock(second.result).querySelector('.outcome-sentence')).toHaveTextContent(
      /^Version 2 passed\. The new Document reads:$/,
    );
  });

  it('offers Propose again on a lapsed new Document, as on a change (#92)', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposalId = log.newDocument('ana', 'Budget');
    const { result, onProposeAgain, user } = show({ state: log.state(DEADLINE), proposalId });
    const again = within(result).getByRole('button', { name: 'Propose again' });
    expect(again).toBeEnabled();
    await user.click(again);
    expect(onProposeAgain).toHaveBeenCalledTimes(1);
  });

  it('offers no Propose again to someone who can’t propose', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    const proposalId = log.propose('ana');
    const { result } = show({
      state: log.state(DEADLINE),
      proposalId,
      me: authorOf('cal'),
    });
    expect(within(result).getByText(/^Not enough people weighed in/)).toBeVisible();
    expect(within(result).queryByRole('button', { name: 'Propose again' })).not.toBeInTheDocument();
  });

  it('tells the author of a ballot that arrived too late that it wasn’t counted, and nobody else', () => {
    const { log, proposalId } = lapsed();
    const state = log.state(DEADLINE);
    const late = 'Your vote arrived after voting closed and wasn’t counted.';
    const cal = authorOf('cal');
    const view = show({
      state,
      proposalId,
      me: cal,
      own: ownBallot(state, log.records, proposalId, cal),
    });
    const notice = within(view.result).getByText(late);
    expect(notice).toBeVisible();
    // On a lapse it sits between the sentence and Propose again.
    const sentence = within(view.result).getByText(/^Not enough people weighed in/);
    expect(precedes(sentence, notice)).toBe(true);
    expect(
      precedes(notice, within(view.result).getByRole('button', { name: 'Propose again' })),
    ).toBe(true);
    cleanup();
    const ana = show({ state, proposalId, own: ownBallot(state, log.records, proposalId, ANA) });
    expect(within(ana.result).queryByText(late)).not.toBeInTheDocument();
  });

  it('puts the late notice after a pass’s thanks, never inside the outcome', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposalId = log.propose('ana');
    log.minute += 1;
    log.vote('ana', proposalId, 4);
    log.vote('ben', proposalId, 3);
    log.vote('cal', proposalId, 2);
    const { result } = show({ state: log.state(), proposalId, own: 'late' });
    const notice = within(result).getByText(
      'Your vote arrived after voting closed and wasn’t counted.',
    );
    expect(outcomeBlock(result)).not.toContainElement(notice);
    expect(precedes(outcomeBlock(result), notice)).toBe(true);
  });

  it('keeps individual ballots and notes under a disclosure, by name', async () => {
    const { log, proposalId } = bensVersionPasses();
    const { result, user } = show({ state: log.state(), proposalId });
    const toggle = within(result).getByRole('button', { name: 'Individual ballots (3)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(result).queryByText('Either is fine.')).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const ballots = within(result).getByRole('list', { name: 'Individual ballots (3)' });
    const rows = within(ballots).getAllByRole('listitem', { name: /./ });
    expect(rows.map((row) => row.querySelector('bdi')?.textContent)).toEqual(['Ana', 'Ben', 'Cal']);
    const [ana] = rows;
    expect(ana).toHaveTextContent('Version 1: 2 · Neutral');
    expect(ana).toHaveTextContent('Version 2: 4 · Strongly supportive');
    expect(ana).toHaveTextContent('Either is fine.');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a lone version’s scores without a version number, and says so when nobody voted', async () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const first = show({ state: log.state(), proposalId });
    await first.user.click(
      within(first.result).getByRole('button', { name: /Individual ballots/ }),
    );
    expect(within(first.result).getByRole('listitem', { name: 'Ana' })).toHaveTextContent(
      /^Ana4 · Strongly supportive$/,
    );
    cleanup();
    const empty = groupLog({ members: ['Ben', 'Cal'] });
    const quiet = empty.propose('ana');
    const second = show({ state: empty.state(DEADLINE), proposalId: quiet });
    expect(within(second.result).getByText('Nobody voted.')).toBeInTheDocument();
    expect(within(second.result).getByText('Nobody scored it.')).toBeVisible();
  });

  it('says until when individual scores and notes are visible, and that screenshots can outlast that', async () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const state = log.state();
    const closedAt = state.proposals[0]?.closedAt ?? 0;
    const { result } = show({ state, proposalId });
    const { visibleUntil, visibleUntilEnd } = messages.result;
    const line = within(result).getByText(
      (_text, element) => element?.tagName === 'P' && element.textContent.startsWith(visibleUntil),
    );
    expect(line).toBeVisible();
    expect(line).toHaveTextContent(
      `${visibleUntil} ${formatDay(closedAt + 43_200)}${visibleUntilEnd}`,
    );
    expect(line.querySelector('time')?.getAttribute('datetime')).toBe(minuteIso(closedAt + 43_200));
    expect(within(result).getByRole('button', { name: 'Individual ballots (3)' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says when individual scores and notes were cleared, offers no ballots, and keeps the totals', async () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const held = log.state();
    const closedAt = held.proposals[0]?.closedAt ?? 0;
    const body = resultFor(held.proposals[0] as Proposal);
    const cleared = groupLog({ members: ['Ben', 'Cal'] });
    cleared.propose('ana');
    cleared.minute = closedAt + 1;
    cleared.result('ben', body);
    const state = cleared.state(closedAt + 43_200, [proposalId]);
    const { result } = show({ state, proposalId });
    const { clearedOn, clearedOnEnd, totalsLine } = messages.result;
    expect(result).toHaveTextContent(`${clearedOn} ${formatDay(closedAt + 43_200)}${clearedOnEnd}`);
    expect(within(result).queryByRole('button', { name: /Individual ballots/ })).toBeNull();
    expect(within(result).getByText(totalsLine(3, '3.0', 0))).toBeVisible();
    expect(within(result).getByText(messages.result.passed)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('flags a record of the decision that doesn’t match the ballots on this device, naming who posted it', async () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const held = log.state();
    const body = resultFor(held.proposals[0] as Proposal);
    log.minute += 1;
    log.result('ben', { ...body, versions: [{ id: proposalId, counts: [0, 0, 0, 0, 3] }] });
    log.result('cal', body);
    const { result } = show({ state: log.state(), proposalId });
    const { mismatchBefore, mismatchAfter } = messages.result;
    const flag = within(result).getByText(
      (_text, element) =>
        element?.tagName === 'P' && element.textContent.startsWith(mismatchBefore),
    );
    expect(flag).toHaveTextContent(`${mismatchBefore} Ben ${mismatchAfter}`);
    expect(flag.querySelector('bdi')?.textContent).toBe('Ben');
    expect(
      within(result).queryAllByText(
        (_text, element) =>
          element?.tagName === 'P' && element.textContent.startsWith(mismatchBefore),
      ),
    ).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('says when voting ran in relay time, and that everyone had voted after an early close', () => {
    const early = decided([4, 3, 2]);
    const closed = early.log.state();
    const proposal = closed.proposals[0] as Proposal;
    const closedAt = proposal.closedAt ?? 0;
    const first = show({ state: closed, proposalId: early.proposalId });
    const ranEarly = ran(first.result);
    expect(ranEarly).toHaveTextContent(
      `Voting ran ${formatMinute(START_MINUTE)} – ${formatMinute(closedAt)}, when everyone had voted.`,
    );
    expect(
      Array.from(ranEarly.querySelectorAll('time'), (time) => time.getAttribute('datetime')),
    ).toEqual([minuteIso(START_MINUTE), minuteIso(closedAt)]);
    cleanup();
    const { log, proposalId } = lapsed();
    const second = show({ state: log.state(DEADLINE), proposalId });
    expect(ran(second.result)).toHaveTextContent(
      `Voting ran ${formatMinute(START_MINUTE)} – ${formatMinute(DEADLINE)}.`,
    );
  });

  it('never offers a part-ways, split or fork action, whatever the outcome', () => {
    const cases = [
      decided([4, 3, 2]),
      decided([4, 4, 0]),
      decided([1, 1, 2]),
      bensVersionPasses(),
      lapsed(),
    ];
    for (const { log, proposalId } of cases) {
      const { result } = show({ state: log.state(DEADLINE), proposalId });
      for (const label of actions(result)) expect(label).not.toMatch(/part|split|fork/i);
      expect(result).not.toHaveTextContent(/part ways|split|fork/i);
      cleanup();
    }
  });
});

describe('ResultView, Tell your group', () => {
  it.each([
    ['a pass', () => decided([4, 3, 2])],
    ['a fail', () => decided([1, 1, 2])],
    ['a lapse', lapsed],
  ] as const)('offers everyone the result message after %s', async (_, made) => {
    const { log, proposalId } = made();
    const { result, onTell, user } = show({
      state: log.state(DEADLINE),
      proposalId,
      me: authorOf('cal'),
    });

    expect(within(result).getByText('A vote has finished in Reconcile.')).toBeVisible();
    await user.click(within(result).getByRole('button', { name: 'Tell your group' }));

    expect(onTell).toHaveBeenCalledExactlyOnceWith('result', { deadline: DEADLINE });
    expect(await within(result).findByText('Shared.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('sits after the outcome and before the totals', () => {
    const { log, proposalId } = decided([4, 3, 2]);
    const { result } = show({ state: log.state(DEADLINE), proposalId });
    const tell = within(result).getByRole('button', { name: 'Tell your group' });
    expect(precedes(result.querySelector('.result-outcome') ?? undefined, tell)).toBe(true);
    expect(precedes(tell, within(result).getByRole('heading', { name: 'Totals' }))).toBe(true);
  });

  it('offers nothing to share while this device leaves the group', () => {
    const { log, proposalId } = lapsed();
    const { result } = show({ state: log.state(DEADLINE), proposalId, leaving: true });
    expect(within(result).queryByRole('button', { name: 'Tell your group' })).toBeNull();
  });
});

function precedes(first: Element | undefined, second: Element): boolean {
  if (first === undefined) return false;
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}
