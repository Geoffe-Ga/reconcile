/**
 * A Dispatch that may rise, on its ballot (#126; ADR-0037): the group's own
 * vote on it, with how far it can go, and a promotion motion in another
 * group, which says who passed it and what passing there does. Where this
 * person's device holds their score from another group, the ballot says it
 * will be cast at a random minute, with Change and Don't cast, and a carried
 * 0 asks for a fresh reason, refusing one written elsewhere.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Scores } from '../app/Ballot';
import { withMotionWords } from '../app/coalitionLines';
import { messages } from '../app/messages';
import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { fold, type GroupState } from '../engine/fold';
import type { HeldCoalition } from '../store/coalitions';
import { foldWithCoalitions } from '../store/coalitions';
import type { CarryPlan, Group } from '../store/db';
import { axeViolations } from '../test/axe';
import { Logs, seatKey, testSecret } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { ProposalView, type ProposalViewProps } from './ProposalView';

afterEach(() => {
  cleanup();
});

const R = 29_375_000;
const WORDS = { title: 'Rally Saturday', text: 'Meet at the river at ten.\nBring water.' };
const { rising } = messages;

/** Renders the ballot of `proposalId` in `state` for `me`, with `extra` props. */
function setup(
  state: GroupState,
  proposalId: string,
  me: string,
  extra: Partial<ProposalViewProps> = {},
) {
  const onVote = vi.fn<(scores: Scores, note: string) => Promise<void>>(() => Promise.resolve());
  const onSkipCarry = vi.fn<() => Promise<void>>(() => Promise.resolve());
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
      onSkipCarry={onSkipCarry}
      {...extra}
    />,
  );
  return { user: userEvent.setup(), onVote, onSkipCarry };
}

const block = () => screen.getByRole('region', { name: rising.heading });

describe('ProposalView: a Dispatch put to the group’s vote (#126)', () => {
  it('shows the Dispatch, how far it can go and what passing does, with one card to score', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.rising('Ana', 'coalitions', WORDS);
    setup(log.state(), id, 'ben');

    expect(screen.getByRole('heading', { level: 1, name: WORDS.title })).toBeVisible();
    const words = block();
    expect(within(words).getByText(WORDS.title)).toBeVisible();
    expect(within(words).getByText(/Meet at the river at ten\./).textContent).toBe(WORDS.text);
    expect(within(words).getByText(rising.ceiling('As far as the coalitions go'))).toBeVisible();
    // What passing does sits once, on the ballot's one card.
    expect(screen.getAllByText(rising.groupLine.coalitions)).toHaveLength(1);
    expect(within(words).queryByText(rising.groupLine.coalitions)).toBeNull();
    // No second "If this passes" block for the same words.
    expect(screen.queryByRole('region', { name: messages.proposal.dispatchHeading })).toBeNull();
    expect(screen.getByText(rising.ballotTitle)).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: messages.stewards.score })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    [1, 'One level up'],
    [2, 'Two levels up'],
  ] as const)('says a ceiling of %s is %s', (ceiling, label) => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.rising('Ana', ceiling, WORDS);
    setup(log.state(), id, 'ben');
    expect(within(block()).getByText(rising.ceiling(label))).toBeVisible();
    expect(screen.getByText(rising.groupLine[ceiling])).toBeVisible();
  });

  it('says what its pass did once it passed', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.rising('Ana', 1, WORDS);
    for (const who of ['Ana', 'Ben', 'Cal']) log.vote(who, id, 4);
    setup(log.state(), id, 'ben');
    expect(screen.getByText(rising.passed)).toBeVisible();
  });
});

/** The coalition's entry as a device keeps it, folded at `relayNow`. */
function heldCoalition(logs: Logs, relayNow: number): HeldCoalition {
  const entry = {
    kind: 'coalition',
    groupId: deriveCoalitionEntryId(fromBase64url(testSecret('coalition'))),
    me: { author: authorOf('jon'), name: '' },
    outbox: [],
    log: logs.logs.coalition ?? [],
    relayNow,
  } as unknown as Group;
  return { entry, state: fold(entry.log, relayNow) };
}

/**
 * Riverside (A: ana, ben) passes a Dispatch with `ceiling`, and kim, bound to
 * its seat, sends it to Rivers United, where it opens in Oak St (B: eve, fay).
 * Returns Oak St's state as group home shows it, the coalitions, and the
 * motion's id.
 */
function promotedToOakSt(ceiling: 1 | 'coalitions' = 1) {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'ben'], 'Riverside');
  const intoA = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ana', intoA, 4);
  logs.vote('A', R + 4, 'ben', intoA, 4);
  logs.group('B', R, ['eve', 'fay'], 'Oak St');
  const intoB = logs.reconcile('B', R + 3, 'eve', 'B');
  logs.vote('B', R + 4, 'eve', intoB, 4);
  logs.vote('B', R + 4, 'fay', intoB, 4);
  logs.formed(R + 10, ['A', 'B'], ['kim', 'dee']);
  const dispatch = logs.dispatchVote('A', R + 20, 'ana', ceiling, WORDS);
  logs.vote('A', R + 21, 'ana', dispatch, 4);
  logs.vote('A', R + 21, 'ben', dispatch, 4);
  const target = {
    kind: 'promote',
    dispatch: { id: dispatch, ...WORDS },
    ceiling,
    level: 1,
    from: seatKey('A'),
  } as const;
  const motion = logs.promoteIn('coalition', R + 30, 'kim', {
    target,
    title: WORDS.title,
    why: '',
  });
  const held = heldCoalition(logs, R + 40);
  const own = foldWithCoalitions({ log: logs.logs.B ?? [], relayNow: R + 40 }, [held]);
  return { state: withMotionWords(own, [held]), coalitions: [held], motion, dispatch };
}

describe('ProposalView: a promotion motion in another group (#126)', () => {
  it('shows the Dispatch, who passed it, and that passing it sends it out in the coalition', async () => {
    const { state, coalitions, motion } = promotedToOakSt();
    setup(state, motion, 'eve', { coalitions });

    expect(screen.getByRole('heading', { level: 1, name: WORDS.title })).toBeVisible();
    expect(screen.getByText(/^Coalition vote/)).toHaveTextContent('Coalition vote · Rivers United');
    const words = block();
    expect(within(words).getByText(WORDS.title)).toBeVisible();
    expect(within(words).getByText(/Bring water\./)).toBeVisible();
    // The test coalition names each seat by its test name: Riverside's is A.
    expect(words).toHaveTextContent(`${rising.passedBy.before} A`);
    expect(within(words).getByText(rising.motionLine('Rivers United'))).toBeVisible();
    expect(within(words).queryByText(rising.goesOn)).toBeNull();
    expect(screen.getByText(rising.ballotTitle)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says it goes on up when its ceiling leaves levels above', () => {
    const { state, coalitions, motion } = promotedToOakSt('coalitions');
    setup(state, motion, 'eve', { coalitions });
    expect(within(block()).getByText(rising.goesOn)).toBeVisible();
  });

  /** Eve's plan to cast her score from another group on `motion`. */
  const planned = (motion: string, score: 0 | 3, more: Partial<CarryPlan> = {}): CarryPlan => ({
    motion,
    dispatch: 'd',
    score,
    castAt: R + 50,
    deadline: R + 30 + 7 * 1440,
    ...more,
  });

  it('says a carried 3 will be cast before voting ends, in place of the pills, with Change and Don’t cast', async () => {
    const { state, coalitions, motion } = promotedToOakSt();
    const { user, onSkipCarry, onVote } = setup(state, motion, 'eve', {
      coalitions,
      carry: planned(motion, 3),
    });

    expect(screen.getByText(rising.carried(3))).toBeVisible();
    expect(screen.getByText(messages.ballot.visibility)).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: messages.stewards.score })).toBeNull();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: rising.dontCast }));
    expect(onSkipCarry).toHaveBeenCalledOnce();
    expect(onVote).not.toHaveBeenCalled();
  });

  it('opens the ballot on Change, the carried 3 chosen, to vote by hand', async () => {
    const { state, coalitions, motion } = promotedToOakSt();
    const { user, onVote } = setup(state, motion, 'eve', { coalitions, carry: planned(motion, 3) });

    await user.click(screen.getByRole('button', { name: rising.change }));
    expect(screen.queryByText(rising.carried(3))).toBeNull();
    const pills = screen.getByRole('radiogroup', { name: messages.stewards.score });
    expect(within(pills).getByRole('radio', { name: /^3/ })).toBeChecked();
    await user.click(within(pills).getByRole('radio', { name: /^2/ }));
    await user.click(screen.getByRole('button', { name: messages.ballot.submit }));
    expect(onVote).toHaveBeenCalledExactlyOnceWith({ [motion]: 2 }, '');
  });

  it('shows the ballot as usual once the person chose Don’t cast', () => {
    const { state, coalitions, motion } = promotedToOakSt();
    setup(state, motion, 'eve', { coalitions, carry: planned(motion, 3, { skipped: true }) });
    expect(screen.queryByText(rising.carried(3))).toBeNull();
    expect(screen.getByRole('radiogroup', { name: messages.stewards.score })).toBeVisible();
  });

  it('asks for a fresh reason for a carried 0, refuses one written elsewhere, and sends a fresh one', async () => {
    const { state, coalitions, motion } = promotedToOakSt();
    const original = 'Not with  them, not this year.';
    const { user, onVote } = setup(state, motion, 'eve', {
      coalitions,
      carry: planned(motion, 0),
      notesElsewhere: [original],
    });

    expect(screen.getByText(rising.freshReason)).toBeVisible();
    const pills = screen.getByRole('radiogroup', { name: messages.stewards.score });
    expect(within(pills).getByRole('radio', { name: /^0/ })).toBeChecked();
    const reason = screen.getByRole('textbox', { name: messages.ballot.reasonLabel });
    expect(reason).toHaveValue('');

    await user.click(reason);
    await user.paste('not with them, not this year.');
    await user.click(screen.getByRole('button', { name: messages.ballot.submit }));
    expect(onVote).not.toHaveBeenCalled();
    expect(reason).toHaveAccessibleDescription(messages.ballot.copiedNote);
    expect(await axeViolations()).toEqual([]);

    await user.clear(reason);
    await user.paste('Too soon for our street.');
    await user.click(screen.getByRole('button', { name: messages.ballot.submit }));
    expect(onVote).toHaveBeenCalledExactlyOnceWith({ [motion]: 0 }, 'Too soon for our street.');
  });

  it('says nothing of a plan once this person has voted', () => {
    const { state, coalitions, motion } = promotedToOakSt();
    setup(state, motion, 'eve', {
      coalitions,
      carry: planned(motion, 3),
      pending: [
        {
          id: 'v',
          event: {
            v: 1,
            type: 'vote',
            group: state.group ?? '',
            author: authorOf('eve'),
            ts: 0,
            body: { proposal: motion, scores: { [motion]: 4 } },
          },
        },
      ],
    });
    expect(screen.queryByText(rising.carried(3))).toBeNull();
  });
});
