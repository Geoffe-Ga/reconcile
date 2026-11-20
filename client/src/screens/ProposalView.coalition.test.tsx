/**
 * A reconcile vote's ballot as #250 leaves it (the founder's decisions of
 * 2026-11-14 and 2026-11-19): withdrawn once another founding group's fail
 * has declined the coalition, and, from 3 days before it closes, a reminder
 * for whoever hasn't scored it that a group that doesn't vote isn't counted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { minuteIso } from '../app/time';
import { fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { fold, type GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import type { HeldCoalition } from '../store/coalitions';
import { foldWithCoalitions } from '../store/coalitions';
import type { Group } from '../store/db';
import { axeViolations } from '../test/axe';
import { Logs, testSecret } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { ProposalView } from './ProposalView';

afterEach(() => {
  cleanup();
});

const R = 29_375_000;
const { coalitions } = messages;

/** The coalition's entry as a device keeps it, folded at `relayNow`. */
function heldCoalition(logs: Logs, relayNow: number): HeldCoalition {
  const entry = {
    kind: 'coalition',
    groupId: deriveCoalitionEntryId(fromBase64url(testSecret('coalition'))),
    me: { author: authorOf('cal'), name: '' },
    outbox: [],
    log: logs.logs.coalition ?? [],
    relayNow,
  } as unknown as Group;
  return { entry, state: fold(entry.log, relayNow) };
}

/** Riverside (Ana, Ben, Cal)'s reconcile Proposal under seat A, which Ben scores, and a genesis naming A and B. */
function reconciling() {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'ben', 'cal'], 'Riverside');
  const proposal = logs.reconcile('A', R + 3, 'ana', 'A');
  logs.vote('A', R + 4, 'ben', proposal, 4);
  logs.coalition(R + 10, ['A', 'B']);
  logs.join(R + 11, 'zed', 'B');
  return { logs, proposal };
}

/** Group A and its coalition as this device folds them at `at`. */
function folded(logs: Logs, at: number): { state: GroupState; held: HeldCoalition } {
  const held = heldCoalition(logs, at);
  return { state: foldWithCoalitions({ log: logs.logs.A ?? [], relayNow: at }, [held]), held };
}

/** Renders `proposal`'s page in group A for `me` at relay minute `at`. */
function show(logs: Logs, proposal: string, me: string, at: number) {
  const { state, held } = folded(logs, at);
  render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposal}
      pending={[]}
      reachable
      now={at}
      own="none"
      onVote={vi.fn(() => Promise.resolve())}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
      coalitions={[held]}
    />,
  );
  return state.proposals.find((p) => p.id === proposal);
}

const ballot = () => screen.queryByRole('button', { name: messages.ballot.submit });
const reminder = () => screen.queryByText(new RegExp(coalitions.reminderBefore));

describe('a reconcile ballot once its coalition is declined (#250)', () => {
  it('is replaced by who didn’t pass it, their name in a <bdi>, while this group’s vote is still open', async () => {
    const { logs, proposal } = reconciling();
    logs.result(R + 12, 'zed', logs.ids.coalition ?? '', 'B', 'fail');
    show(logs, proposal, 'ana', R + 20);

    const line = screen.getByText(coalitions.withdrawnAfter, { exact: false });
    expect(line).toHaveTextContent('B didn’t pass this, so the coalition won’t form.');
    expect(line.querySelector('bdi')).toHaveTextContent('B');
    expect(ballot()).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('takes no reminder once withdrawn, though no one in the group has scored it since', () => {
    const { logs, proposal } = reconciling();
    logs.result(R + 12, 'zed', logs.ids.coalition ?? '', 'B', 'fail');
    show(logs, proposal, 'ana', R + 3 + 4 * DAY_MINUTES);
    expect(screen.getByText(coalitions.withdrawnAfter, { exact: false })).toBeVisible();
    expect(reminder()).toBeNull();
  });

  it('stays while the coalition still forms', () => {
    const { logs, proposal } = reconciling();
    show(logs, proposal, 'ana', R + 20);
    expect(ballot()).toBeVisible();
    expect(screen.queryByText(coalitions.withdrawnAfter, { exact: false })).toBeNull();
  });
});

describe('the reminder on a reconcile vote (#250)', () => {
  it('says, from 3 days before it closes, that someone who hasn’t scored it won’t be counted unless they vote by its deadline', async () => {
    const { logs, proposal } = reconciling();
    const deadline = R + 3 + 7 * DAY_MINUTES;
    const shown = show(logs, proposal, 'ana', deadline - 3 * DAY_MINUTES);

    expect(shown?.deadline).toBe(deadline);
    const line = reminder();
    expect(line).toHaveTextContent(/^If you don’t vote by .+, you won’t be counted\.$/);
    expect(line?.querySelector('time')).toHaveAttribute('dateTime', minuteIso(deadline));
    expect(ballot()).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing a minute earlier, to someone who has scored it, or once it has closed', () => {
    const { logs, proposal } = reconciling();
    const from = R + 3 + 4 * DAY_MINUTES;
    show(logs, proposal, 'ana', from - 1);
    expect(reminder()).toBeNull();
    cleanup();
    show(logs, proposal, 'ben', from);
    expect(reminder()).toBeNull();
    cleanup();
    show(logs, proposal, 'ana', R + 3 + 7 * DAY_MINUTES);
    expect(reminder()).toBeNull();
  });
});
