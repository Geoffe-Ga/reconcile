/**
 * The shelf line on a listed group's Dispatch ballot (#430; ADR-0081;
 * listed-doors.md §5.1): two scored lines, each with its own pills and
 * consent meter, and once voting closes, both results, saying whether the
 * group put its name to the Dispatch on the public shelf and, if not, why.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Scores } from '../app/Ballot';
import { messages } from '../app/messages';
import type { Score } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { DOOR, LISTED } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { ProposalView } from './ProposalView';

afterEach(() => {
  cleanup();
});

const WORDS = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };
const { shelfLine, rising } = messages;
const SHELF_TITLE = shelfLine.ballotTitle('Riverside Tenants');

/** Ana, Ben and Cal, whose front door is open and listed, and Ana's Dispatch put to the vote with a shelf line. */
function listedVote(): { log: LogBuilder; id: string } {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const listing = log.rules('Ana', 'frontDoor', LISTED, { title: 'List our door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, listing, 4);
  log.minute += 1;
  const id = log.rising('Ana', 0, WORDS, undefined, true);
  log.minute += 1;
  return { log, id };
}

/** Each of Ana, Ben and Cal scores both lines, with a reason beside any 0. */
function scoreBoth(log: LogBuilder, id: string, dispatch: Score[], shelf: Score[]) {
  ['Ana', 'Ben', 'Cal'].forEach((name, i) => {
    const scores = { [id]: dispatch[i] ?? 4, [`${id}.shelf`]: shelf[i] ?? 4 };
    const zero = Object.values(scores).includes(0);
    log.ballot(name, id, scores, zero ? 'Not like this.' : undefined);
    log.minute += 1;
  });
}

function setup(state: GroupState, proposalId: string, me: string) {
  const onVote = vi.fn<(scores: Scores, note: string) => Promise<void>>(() => Promise.resolve());
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
    />,
  );
  return { user: userEvent.setup(), onVote };
}

const result = () => screen.getByRole('region', { name: messages.result.title });

describe('ProposalView: the shelf line (#430)', () => {
  it('shows two scored lines, each with its own pills and consent meter', async () => {
    const { log, id } = listedVote();
    log.ballot('Ben', id, { [id]: 4, [`${id}.shelf`]: 3 });
    setup(log.state(), id, 'cal');

    expect(screen.getByText(rising.ballotTitle)).toBeVisible();
    expect(screen.getByText(SHELF_TITLE)).toBeVisible();
    expect(screen.getByText(shelfLine.line)).toBeVisible();
    expect(screen.getByText(rising.groupLine[0])).toBeVisible();
    const { names } = shelfLine;
    expect(
      screen.getByRole('radiogroup', { name: shelfLine.scoreFor(names.dispatch) }),
    ).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: shelfLine.scoreFor(names.shelf) })).toBeVisible();
    expect(screen.getByRole('group', { name: shelfLine.meterLabel(names.dispatch) })).toBeVisible();
    expect(screen.getByRole('group', { name: shelfLine.meterLabel(names.shelf) })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends a score for each line, and asks for a reason when the shelf line gets a 0', async () => {
    const { log, id } = listedVote();
    const { user, onVote } = setup(log.state(), id, 'ben');
    const { names } = shelfLine;
    const dispatch = screen.getByRole('radiogroup', { name: shelfLine.scoreFor(names.dispatch) });
    const shelf = screen.getByRole('radiogroup', { name: shelfLine.scoreFor(names.shelf) });
    await user.click(within(dispatch).getByRole('radio', { name: /^4/ }));
    await user.click(within(shelf).getByRole('radio', { name: /^0/ }));
    await user.click(screen.getByRole('button', { name: messages.ballot.submit }));
    expect(onVote).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox'), 'Not under our name.');
    await user.click(screen.getByRole('button', { name: messages.ballot.submit }));
    expect(onVote).toHaveBeenCalledExactlyOnceWith(
      { [id]: 4, [`${id}.shelf`]: 0 },
      'Not under our name.',
    );
  });

  it('says the group put its name to it on the public shelf, with both lines’ totals', async () => {
    const { log, id } = listedVote();
    scoreBoth(log, id, [4, 3, 3], [3, 3, 2]);
    setup(log.state(), id, 'ben');
    const region = result();
    expect(within(region).getByText(rising.passedHere)).toBeVisible();
    expect(within(region).getByText(shelfLine.published)).toBeVisible();
    expect(within(region).getByText(SHELF_TITLE)).toBeVisible();
    expect(within(region).getAllByText(/^Scored by 3 · average/)).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);
  });

  it('says the shelf line fell short, and what it missed, when only the Dispatch passed', () => {
    const { log, id } = listedVote();
    scoreBoth(log, id, [4, 3, 3], [4, 0, 1]);
    setup(log.state(), id, 'ben');
    const region = result();
    expect(within(region).getByText(rising.passedHere)).toBeVisible();
    expect(within(region).getByText(shelfLine.failed)).toBeVisible();
    expect(within(region).getByText(messages.result.tooManyZeros(1, 3))).toBeVisible();
  });

  it('says nothing goes on the shelf when the Dispatch failed, naming only its own shortfall', () => {
    const { log, id } = listedVote();
    scoreBoth(log, id, [4, 0, 1], [4, 4, 4]);
    setup(log.state(), id, 'ben');
    const region = result();
    expect(within(region).getByText(messages.result.failed)).toBeVisible();
    expect(within(region).getByText(shelfLine.dispatchFailed)).toBeVisible();
  });

  it('says the door wasn’t listed when voting closed, when the listing ended first', () => {
    const { log, id } = listedVote();
    log.ballot('Ana', id, { [id]: 4, [`${id}.shelf`]: 4 });
    const unlist = log.rules('Ana', 'frontDoor', DOOR, { title: 'Unlist our door' });
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, unlist, 4);
    log.minute += 1;
    scoreBoth(log, id, [4, 4, 4], [4, 4, 4]);
    setup(log.state(), id, 'ben');
    expect(within(result()).getByText(shelfLine.unlisted)).toBeVisible();
  });
});
