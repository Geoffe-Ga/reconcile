/**
 * Dissolving on screen (#108): "Propose dissolving the group" at the bottom
 * of Group home, the dissolve ballot and its result, and a dissolved group's
 * read-only copy: its note, Remove from this device, the Proposals it cut
 * off, the Document with no controls, and, once this device has cleared its
 * ballots, each outcome from the tally it kept.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { formatDate, MINUTE_MS } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import { createEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { clearedArchive } from '../store/archive';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import { DocumentView } from './DocumentView';
import { GroupHome, type GroupHomeProps } from './GroupHome';
import { ProposalView, type ProposalViewProps } from './ProposalView';

const [, VOTING] = LEVELS;
const KEEP_LINE = 'If this passes, your group ends. Every device keeps a read-only copy.';
const WIPE_LINE = 'If this passes, your group ends, and every device erases it 7 days later.';

function renderHome(state: GroupState, me: string, props: Partial<GroupHomeProps> = {}) {
  const now = state.at;
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
      pending={[]}
      onChooseLevel={() => Promise.resolve()}
      onSuspend={() => Promise.resolve()}
      onVouch={() => Promise.resolve()}
      onLeave={() => Promise.resolve()}
      {...props}
    />,
  );
  return userEvent.setup();
}

function renderProposal(
  state: GroupState,
  proposalId: string,
  me: string,
  props: Partial<ProposalViewProps> = {},
) {
  render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={state.at}
      own="none"
      onVote={() => Promise.resolve()}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
      {...props}
    />,
  );
}

/** The Document view as `me` sees it, with `copyText` as its clipboard. */
function renderDocument(state: GroupState, me: string, copyText = () => Promise.resolve()) {
  render(
    <DocumentView
      state={state}
      me={authorOf(me)}
      onPropose={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
      onMove={() => undefined}
      copyText={copyText}
    />,
  );
}

/** Ana founds; Ben joins as a Co-Creator and Cal as a Collaborator. */
function group() {
  return groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
}

/**
 * A group with a decided edit, an edit still open, and a dissolve that passed
 * with three 4s and folded a minute later.
 */
function dissolved(wipe = false) {
  const log = group();
  const decided = log.propose('ana', { atom: 1, title: 'Bins on Monday', text: 'Bins on Monday.' });
  for (const name of ['ana', 'ben', 'cal']) log.vote(name, decided, 4);
  log.minute += 10;
  const open = log.propose('ben', { title: 'Later quiet hours' });
  log.vote('ana', open, 4);
  const motion = log.proposeDissolve('ana', wipe, { title: 'Dissolve Riverside' });
  log.vote('ana', motion, 4);
  log.vote('ben', motion, 3);
  log.vote('cal', motion, 4);
  log.minute += 1;
  log.dissolve('cal', motion);
  return { log, decided, open, motion, state: log.state(log.minute + 50_000) };
}

const main = () => screen.getByRole('main');

describe('Propose dissolving the group on Group home', () => {
  it('sits at the very bottom for someone who may propose, and opens the dissolve composer', async () => {
    const state = group().state();
    renderHome(state, 'ana');
    expect(screen.getByRole('region', { name: 'Rules' })).toBeVisible();
    const link = screen.getByRole('link', { name: 'Propose dissolving the group' });
    expect(link).toHaveAttribute('href', `#/g/${state.group ?? ''}/dissolve`);
    const everything = within(main()).getAllByRole('link');
    expect(everything.at(-1)).toBe(link);
    expect(await axeViolations()).toEqual([]);
  });

  it('is not offered to a Collaborator, to someone leaving, or while a dissolve vote is open', () => {
    const log = group();
    renderHome(log.state(), 'cal');
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    cleanup();
    renderHome(log.state(), 'ana', { leaving: true });
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    cleanup();
    log.proposeDissolve('ana', false, { title: 'Dissolve Riverside' });
    renderHome(log.state(), 'ben');
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    const needs = screen.getByRole('region', { name: 'Needs your vote' });
    expect(within(needs).getByRole('link', { name: /Dissolve Riverside/ })).toBeVisible();
  });
});

describe('a dissolved group on Group home', () => {
  it('says when it dissolved and that this is a read-only copy, and offers no controls', async () => {
    const { state, open, motion } = dissolved();
    renderHome(state, 'ana', {
      sync: { reachable: false, lastSyncAt: null, deviceNow: 0, missingHistory: true },
      onRemove: () => Promise.resolve(),
    });
    const received = state.dissolved?.received ?? 0;
    expect(
      screen.getByText(
        `This group dissolved on ${formatDate(received)}. This is a read-only copy.`,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/It will be erased from this device/)).toBeNull();
    expect(screen.queryByText(/Can’t reach the relay/)).toBeNull();
    expect(screen.queryByText(/Some history may be missing/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Needs your vote' })).toBeNull();
    const unfinished = screen.getByRole('region', { name: 'Not decided' });
    const cut = within(unfinished).getByRole('link', { name: /Later quiet hours/ });
    expect(cut).toHaveTextContent('Closed when the group dissolved');
    expect(cut).toHaveAttribute('href', `#/g/${state.group ?? ''}/p/${open}`);
    const decided = screen.getByRole('region', { name: 'Decided' });
    expect(within(decided).getByRole('link', { name: /Dissolve Riverside/ })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/p/${motion}`,
    );
    expect(screen.queryByRole('region', { name: 'Invite people' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Your involvement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave this group' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Suspend / })).toBeNull();
    expect(screen.queryByRole('link', { name: /Propose a steward/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Stewards' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Rules' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove from this device' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows its archive note, never a line that the group’s key changed (#98)', async () => {
    const { state } = dissolved();
    for (const keyChange of ['left', 'missed'] as const) {
      renderHome(state, 'ana', {
        sync: { reachable: true, lastSyncAt: 0, deviceNow: 0, missingHistory: false, keyChange },
        onRemove: () => Promise.resolve(),
      });
      expect(screen.getByText(/This is a read-only copy\./)).toBeVisible();
      expect(screen.queryByText(messages.home.keyLeft)).toBeNull();
      expect(screen.queryByText(messages.home.keyMissed)).toBeNull();
      expect(screen.queryByRole('region', { name: 'Invite people' })).toBeNull();
      expect(await axeViolations()).toEqual([]);
      cleanup();
    }
  });

  it('suggests no backup (#78), since no backup file carries a read-only copy', () => {
    const { state } = dissolved();
    renderHome(state, 'ana', {
      backupCard: <p>The backup card</p>,
      onRemove: () => Promise.resolve(),
    });

    expect(screen.queryByText('The backup card')).toBeNull();
  });

  it('adds when this device erases it, a week after, when the vote chose to wipe', () => {
    const { state } = dissolved(true);
    renderHome(state, 'ben');
    const received = state.dissolved?.received ?? 0;
    expect(
      screen.getByText(
        `It will be erased from this device on ${formatDate(received + 7 * DAY_MINUTES)}.`,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove from this device' })).toBeNull();
  });

  it('removes the copy only once confirmed, and says so when it can’t', async () => {
    const { state } = dissolved();
    const onRemove = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('blocked')));
    const user = renderHome(state, 'ana', { onRemove });
    await user.click(screen.getByRole('button', { name: 'Remove from this device' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this group from this device?' });
    expect(dialog).toHaveTextContent(
      'This erases your read-only copy of this group from this device. Others keep their own copies.',
    );
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This group couldn’t be removed from this device. Try again.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers no Vouch, and no newcomer’s line on when they can vote (#101)', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING }, newcomers: ['Kim'] });
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    renderHome(log.state(), 'ana');
    expect(screen.getByRole('button', { name: 'Vouch for Kim' })).toBeVisible();
    cleanup();
    renderHome(log.state(), 'kim');
    expect(screen.getByText(/^You can vote on Proposals that open after/)).toBeVisible();
    cleanup();
    log.minute += 1;
    log.dissolve('kim', motion);
    renderHome(log.state(), 'ana', { onRemove: () => Promise.resolve() });
    expect(screen.queryByRole('button', { name: /^Vouch for/ })).toBeNull();
    cleanup();
    renderHome(log.state(), 'kim', { onRemove: () => Promise.resolve() });
    expect(screen.getByText(/This is a read-only copy\./)).toBeVisible();
    expect(screen.queryByText(/^You can vote on Proposals/)).toBeNull();
    expect(screen.queryByText(/^Voting and proposing start/)).toBeNull();
  });

  it('leaves out Not decided when nothing was open', () => {
    const log = group();
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.dissolve('ana', motion);
    renderHome(log.state(), 'ana');
    expect(screen.queryByRole('region', { name: 'Not decided' })).toBeNull();
    expect(screen.queryByText('Nothing to vote on yet.')).toBeNull();
  });
});

describe('a dissolved group’s Document', () => {
  it('only reads: no Propose a change, no section to add or remove, and no note about levels', () => {
    const { state } = dissolved();
    for (const me of ['ana', 'cal']) {
      renderDocument(state, me);
      expect(screen.getByText('Bins on Monday.')).toBeVisible();
      expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Add a section here/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Propose removing this section/ })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Change your involvement' })).toBeNull();
      cleanup();
    }
  });

  it('still copies as Markdown, so the group can start afresh from its archive (#75)', async () => {
    const { state } = dissolved();
    const copyText = vi.fn(() => Promise.resolve());
    renderDocument(state, 'ana', copyText);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(copyText).toHaveBeenCalledWith('Quiet hours start at ten.\nBins on Monday.');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Propose again on a lapsed add or removal once the group has dissolved (#75)', () => {
    const log = group();
    const add = log.addSection('ana', `${log.group}.0`);
    const removal = log.propose('ben', { atom: 1, title: 'No bins rule', text: '' });
    log.minute = deadlineOf(log.minute) + 1;
    for (const id of [add, removal]) {
      renderProposal(log.state(), id, 'ana');
      expect(screen.getByRole('button', { name: 'Propose again' })).toBeVisible();
      cleanup();
    }
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.minute += 1;
    log.dissolve('ben', motion);
    for (const id of [add, removal]) {
      renderProposal(log.state(), id, 'ana');
      expect(screen.getByText(messages.result.lapsed)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
      cleanup();
    }
  });
});

describe('the dissolve ballot', () => {
  it('reads "Dissolve the group" and what passing does, with one score for each voter', async () => {
    const log = group();
    const motion = log.proposeDissolve('ana', true, { title: 'Dissolve Riverside' });
    renderProposal(log.state(), motion, 'cal');
    const ballot = screen.getByRole('region', { name: 'Dissolve the group' });
    expect(ballot).toHaveTextContent(WIPE_LINE);
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add your version' })).toBeNull();
    expect(screen.getByText('Voting runs 14 days')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a kept copy stays on every device, while it waits to be sent too', () => {
    const log = group();
    const body = {
      target: { kind: 'dissolve', wipe: false } as const,
      title: 'Dissolve',
      why: 'Done.',
    };
    const draft = { type: 'proposal' as const, group: log.group, ts: 0, body };
    const parsed = parseEvent(createEvent({ ...draft, author: authorOf('ana') }).bytes);
    if (parsed === null) throw new Error('Expected an event.');
    renderProposal(log.state(), parsed.id, 'ana', { pending: [parsed] });
    expect(screen.getByRole('region', { name: 'Dissolve the group' })).toHaveTextContent(KEEP_LINE);
    expect(screen.getByText('New Proposal')).toBeVisible();
  });

  it('leads its result with "This passed. Your group has dissolved." and names it in the totals', async () => {
    const { state, motion } = dissolved();
    renderProposal(state, motion, 'ben');
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('This passed. Your group has dissolved.')).toBeVisible();
    expect(within(result).getByRole('list', { name: 'Totals' })).toHaveTextContent(
      'Dissolve the group',
    );
    expect(screen.queryByRole('button', { name: /your vote$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tell your group' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('a Proposal the dissolve cut off', () => {
  it('reads closed when the group dissolved, with no outcome and no ballot', async () => {
    const { state, open } = dissolved();
    renderProposal(state, open, 'cal');
    const number = state.proposals.find((proposal) => proposal.id === open)?.number;
    expect(screen.getByText(`Proposal ${String(number)} · Closed`)).toBeVisible();
    expect(screen.getByText('Closed when the group dissolved')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('region', { name: 'Changes to section 1' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('never offers Propose again on a lapse decided before the dissolve', () => {
    const log = group();
    const lapsed = log.propose('ana');
    log.minute += 7 * DAY_MINUTES;
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
    log.dissolve('ana', motion);
    renderProposal(log.state(), lapsed, 'ana');
    expect(screen.getByText('Not enough people weighed in. This isn’t a no.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
  });
});

describe('a dissolved group once its ballots are cleared', () => {
  it('shows each outcome and its totals from the kept tally, and when the ballots were cleared', async () => {
    const { state, decided } = dissolved();
    const at = Date.UTC(2026, 11, 14, 9);
    const kept = clearedArchive(state, at);
    renderProposal(kept.state, decided, 'ana', { cleared: { at, tallies: kept.tallies } });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('This passed. The Document now reads:')).toBeVisible();
    expect(within(result).getByRole('list', { name: 'Totals' })).toHaveTextContent(
      'Scored by 3 · average 4.0 · no zeros',
    );
    expect(
      within(result).getByText(
        `Individual scores and notes were cleared on ${formatDate(Math.floor(at / MINUTE_MS))}.`,
      ),
    ).toBeVisible();
    expect(within(result).queryByRole('button', { name: /Individual ballots/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps the ballots disclosure for a Proposal the archive kept no tally for', () => {
    const { state, decided } = dissolved();
    renderProposal(state, decided, 'ana', { cleared: { at: 0, tallies: {} } });
    expect(screen.getByRole('button', { name: 'Individual ballots (3)' })).toBeVisible();
  });
});
