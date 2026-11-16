import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { resultFor } from '../engine/expiry';
import type { GroupState } from '../engine/fold';
import { optionId } from '../engine/priority';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { formatDate, MINUTE_MS } from '../app/time';
import { clearedArchive } from '../store/archive';
import { type ClearedResult, ResultView } from './ResultView';

const ANA = authorOf('ana');
const FOUR = ['Fix the website', 'Plan the picnic', 'New bylaws', 'Rent strike'];

function show(state: GroupState, proposalId: string, cleared?: ClearedResult) {
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  if (proposal === undefined) throw new Error('Expected the priority vote.');
  const onProposeAgain = vi.fn();
  document.title = 'Proposal · Reconcile';
  render(
    <main>
      <h1>{proposal.title}</h1>
      <ResultView
        state={state}
        proposal={proposal}
        me={ANA}
        own="none"
        onProposeAgain={onProposeAgain}
        onTell={() => Promise.resolve('shared')}
        {...(cleared === undefined ? {} : { cleared })}
      />
    </main>,
  );
  const result = screen.getByRole('region', { name: 'Result' });
  return { result, onProposeAgain, user: userEvent.setup() };
}

/**
 * Ana asks about four options in a group of Ana, Ben and Cal, and all three score each, which
 * closes it early. Fix the website and Plan the picnic both pass; Plan the picnic has the higher
 * average. New bylaws averages under 2.0, and Rent strike has a 0 in three.
 */
function rankedVote(log = groupLog({ members: ['Ben', 'Cal'] })) {
  const id = log.ask('ana', FOUR);
  const o = (i: number) => optionId(id, i);
  log.minute += 5;
  log.ballot('ana', id, { [o(0)]: 3, [o(1)]: 4, [o(2)]: 1, [o(3)]: 4 });
  log.ballot('ben', id, { [o(0)]: 3, [o(1)]: 4, [o(2)]: 2, [o(3)]: 0 }, 'Not yet.');
  log.ballot('cal', id, { [o(0)]: 2, [o(1)]: 3, [o(2)]: 2, [o(3)]: 4 });
  return { log, state: log.state(), id };
}

describe('a priority vote’s result (#107)', () => {
  it('names the focus, then the options that passed best first, then the rest, with no numbers', () => {
    const { state, id } = rankedVote();
    const { result } = show(state, id);
    const outcome = result.querySelector<HTMLElement>('.result-outcome');
    expect(outcome?.textContent).toBe('Your group’s focus is now:Plan the picnicThank you, Ana.');
    const ranked = within(result).getByRole('list', { name: 'Passed, best first' });
    expect(
      within(ranked)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Plan the picnic', 'Fix the website']);
    expect(ranked.tagName).toBe('OL');
    const rest = within(result).getByRole('list', { name: 'Didn’t clear the floor' });
    expect(
      within(rest)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['New bylaws', 'Rent strike']);
    // No totals, averages or counts outside the disclosure, which starts closed.
    expect(within(result).queryByRole('heading', { name: 'Totals' })).toBeNull();
    for (const block of result.querySelectorAll('.result-outcome, .result-ranking')) {
      expect(block.textContent).not.toMatch(/\d/);
    }
  });

  it('keeps each option’s totals and every ballot under one disclosure', async () => {
    const { state, id } = rankedVote();
    const { result, user } = show(state, id);
    const toggle = within(result).getByRole('button', {
      name: 'Totals and individual ballots (3)',
    });
    await user.click(toggle);
    const totals = within(result).getByRole('list', { name: 'Totals' });
    expect(
      within(totals)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Fix the websiteScored by 3 · average 2.6 · no zeros',
      'Plan the picnicScored by 3 · average 3.6 · no zeros',
      'New bylawsScored by 3 · average 1.6 · no zeros',
      'Rent strikeScored by 3 · average 2.6 · 1 zero',
    ]);
    expect(within(result).getByRole('heading', { name: 'Totals', level: 4 })).toBeDefined();
    const ballots = within(result).getByRole('list', { name: 'Totals and individual ballots (3)' });
    const ben = within(ballots).getByRole('listitem', { name: 'Ben' });
    expect(
      within(ben)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Fix the website: 3 · Supportive',
      'Plan the picnic: 4 · Strongly supportive',
      'New bylaws: 2 · Neutral',
      'Rent strike: 0 · Strongly opposed',
    ]);
    expect(within(ben).getByText('Not yet.')).toBeDefined();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the focus stays as it was when no option passes', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    for (const voter of ['ana', 'ben', 'cal']) {
      log.ballot(voter, id, { [optionId(id, 0)]: 1, [optionId(id, 1)]: 1 });
    }
    const { result } = show(log.state(), id);
    expect(result.querySelector('.result-outcome')?.textContent).toBe(
      'No option passed, so your group’s focus stays as it was.',
    );
    expect(within(result).queryByRole('list', { name: 'Passed, best first' })).toBeNull();
    const rest = within(result).getByRole('list', { name: 'Didn’t clear the floor' });
    expect(within(rest).getAllByRole('listitem')).toHaveLength(2);
  });

  it('says a lapse isn’t a no, lists no ranking, and offers asking again', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    log.ballot('ana', id, { [optionId(id, 0)]: 4, [optionId(id, 1)]: 4 });
    const { result, onProposeAgain, user } = show(log.state(deadlineOf(START_MINUTE)), id);
    expect(
      within(result).getByText('Not enough people weighed in. This isn’t a no.'),
    ).toBeDefined();
    expect(result.querySelector('.result-ranking')).toBeNull();
    await user.click(within(result).getByRole('button', { name: 'Propose again' }));
    expect(onProposeAgain).toHaveBeenCalledOnce();
  });

  it('holds Propose again, and says why, while another priority vote is open', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    log.minute = deadlineOf(START_MINUTE);
    log.ask('ben', ['New bylaws', 'Rent strike']);
    const { result } = show(log.state(), id);
    const again = within(result).getByRole('button', { name: 'Propose again' });
    expect(again).toHaveProperty('disabled', true);
    expect(
      within(result).getByText(
        'Your group has an open priority vote now. You can ask again once it closes.',
      ),
    ).toBeDefined();
    cleanup();
  });

  it('ranks from the tally a cleared archive kept, and holds its totals with when the ballots were cleared (#108)', async () => {
    const { state, id } = rankedVote();
    const at = Date.UTC(2026, 11, 14, 9);
    const kept = clearedArchive(state, at);
    const tally = kept.tallies[id];
    if (tally === undefined) throw new Error('Expected the kept tally.');
    const { result, user } = show(kept.state, id, { at, tally });
    expect(
      within(result).getByText('Plan the picnic', { selector: '.result-focus bdi' }),
    ).toBeVisible();
    expect(
      within(within(result).getByRole('list', { name: 'Passed, best first' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(2);
    // No totals outside the disclosure.
    expect(within(result).queryByRole('list', { name: 'Totals' })).toBeNull();
    await user.click(within(result).getByRole('button', { name: 'Totals' }));
    expect(within(result).getByRole('list', { name: 'Totals' })).toHaveTextContent(
      'Plan the picnicScored by 3 · average 3.6 · no zeros',
    );
    expect(
      within(result).getByText(
        `Individual scores and notes were cleared on ${formatDate(Math.floor(at / MINUTE_MS))}.`,
      ),
    ).toBeVisible();
    expect(within(result).queryByText('Nobody voted.')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('ranks from its result once this device has cleared its ballots, and says when (#111)', async () => {
    const { log, state: held, id } = rankedVote();
    const decided = held.proposals.find((candidate) => candidate.id === id);
    if (decided?.closedAt == null) throw new Error('Expected the closed priority vote.');
    const { closedAt } = decided;
    // Clearing keeps every record's relay seq, which the result's closedSeq names (#289).
    log.minute = closedAt + 1;
    log.result('ben', resultFor(decided));
    const expires = closedAt + 43_200;
    const { result, user } = show(log.state(expires, [id]), id);

    expect(
      within(result).getByText('Plan the picnic', { selector: '.result-focus bdi' }),
    ).toBeVisible();
    expect(
      within(within(result).getByRole('list', { name: 'Passed, best first' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(2);
    expect(within(result).queryByRole('button', { name: /individual ballots/ })).toBeNull();
    await user.click(within(result).getByRole('button', { name: 'Totals' }));
    expect(within(result).getByRole('list', { name: 'Totals' })).toHaveTextContent(
      'Plan the picnicScored by 3 · average 3.6 · no zeros',
    );
    const { clearedOn, clearedOnEnd } = messages.result;
    expect(result).toHaveTextContent(`${clearedOn} ${formatDay(expires)}${clearedOnEnd}`);
    expect(within(result).queryByText('Nobody voted.')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says until when the ballots are visible, and names who posted a record that doesn’t match them (#111)', () => {
    const { state: held, id } = rankedVote();
    const decided = held.proposals.find((candidate) => candidate.id === id);
    if (decided === undefined) throw new Error('Expected the closed priority vote.');
    const log = groupLog({ members: ['Ben', 'Cal'] });
    rankedVote(log);
    log.minute += 1;
    log.result('ben', { ...resultFor(decided), commit: 'not-these-ballots' });
    const { result } = show(log.state(), id);
    const { visibleUntil, mismatchBefore, mismatchAfter } = messages.result;
    expect(within(result).getByText(new RegExp(`^${visibleUntil}`))).toBeVisible();
    expect(result).toHaveTextContent(`${mismatchBefore} Ben ${mismatchAfter}`);
    cleanup();
  });
});
