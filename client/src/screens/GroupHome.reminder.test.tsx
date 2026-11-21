/**
 * The mark on a reconcile or coalition vote's row under Needs your vote in
 * its last 3 days (#550; the founder's decision of 2026-11-21): the same
 * window as its reminder (#250), for someone eligible who hasn't scored it.
 * Worked out on this device alone; nothing new goes to the relay.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { MINUTE_MS } from '../app/time';
import { createEvent, type ParsedEvent, parseEvent } from '../engine/event';
import { REMINDER_MINUTES } from '../engine/nudges';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import type { GroupState } from '../engine/fold';
import { GroupHome } from './GroupHome';

afterEach(() => {
  cleanup();
});

const R = 29_375_000;
const DEADLINE = R + 3 + 7 * DAY_MINUTES;
const FROM = DEADLINE - REMINDER_MINUTES;
const { lastDays } = messages.coalitions;

/** Group home for `me`, at relay minute `now`, with `pending` waiting in the outbox. */
function renderHome(state: GroupState, me: string, now: number, pending: ParsedEvent[] = []) {
  render(
    <GroupHome
      state={state}
      me={authorOf(me)}
      makeInviteLink={() => Promise.resolve(`https://reconcile.example/#join/${'s'.repeat(43)}`)}
      copyText={() => Promise.resolve()}
      now={now}
      sync={{
        reachable: true,
        lastSyncAt: now * MINUTE_MS,
        deviceNow: now * MINUTE_MS,
        missingHistory: false,
      }}
      pending={pending}
      onChooseLevel={() => Promise.resolve()}
      onSuspend={() => Promise.resolve()}
      onVouch={() => Promise.resolve()}
      onLeave={() => Promise.resolve()}
    />,
  );
}

/** Riverside (Ana, Ben, Cal) and Ana's reconcile Proposal, which Ben has scored, folded at `now`. */
function reconciling(now: number) {
  const logs = new Logs();
  logs.group('A', R, ['ana', 'ben', 'cal']);
  const proposal = logs.reconcile('A', R + 3, 'ana', 'A', { title: 'Reconcile with Oak St' });
  logs.vote('A', R + 4, 'ben', proposal, 4);
  return { state: folded(foldLogs(logs.logs, now), 'A').state, proposal };
}

/** `me`'s vote on `proposal`, as the outbox lists it while it waits for the relay. */
function pendingVote(me: string, proposal: string): ParsedEvent {
  const body = { proposal, scores: { [proposal]: 4 as const } };
  const input = { type: 'vote', group: 'g', author: authorOf(me), ts: 0, body } as const;
  const parsed = parseEvent(createEvent(input).bytes);
  if (parsed === null) throw new Error('Expected an event.');
  return parsed;
}

const card = () =>
  within(screen.getByRole('region', { name: messages.home.needsYourVote })).getByRole('link', {
    name: /Reconcile with Oak St/,
  });

describe('Needs your vote in a reconcile vote’s last 3 days (#550)', () => {
  it('marks the row, under its countdown, in the reminder’s words without its date', async () => {
    const { state } = reconciling(FROM);
    renderHome(state, 'ana', FROM);

    expect(lastDays).toBe('If you don’t vote, you won’t be counted.');
    const mark = within(card()).getByText(lastDays);
    expect(mark).toHaveClass('card-link-reminder');
    expect(card()).toHaveTextContent(
      /Closes in 3 days.+If you don’t vote, you won’t be counted\.$/,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('marks it until its deadline, for each eligible member who hasn’t scored it', () => {
    const { state } = reconciling(DEADLINE - 1);
    renderHome(state, 'cal', DEADLINE - 1);
    expect(within(card()).getByText(lastDays)).toBeVisible();
  });

  it('doesn’t mark it a minute earlier', () => {
    const { state } = reconciling(FROM - 1);
    renderHome(state, 'ana', FROM - 1);
    expect(card()).toBeVisible();
    expect(screen.queryByText(lastDays)).toBeNull();
  });

  it('doesn’t mark it while this person’s vote waits in the outbox', () => {
    const { state, proposal } = reconciling(FROM);
    renderHome(state, 'ana', FROM, [pendingVote('ana', proposal)]);
    expect(card()).toBeVisible();
    expect(screen.queryByText(lastDays)).toBeNull();
  });

  it('never marks an ordinary Proposal, however close it is to closing', () => {
    const log = groupLog({ members: ['Ben'] });
    log.propose('ana', { title: 'Later quiet hours' });
    const at = deadlineOf(log.minute) - 1;
    renderHome(log.state(at), 'ben', at);
    expect(
      within(screen.getByRole('region', { name: messages.home.needsYourVote })).getByRole('link'),
    ).toHaveTextContent('Later quiet hours');
    expect(screen.queryByText(lastDays)).toBeNull();
  });
});
