/**
 * A group a restore brought back that hasn't heard from the group yet, on
 * screen (#231; ADR-0051's 2026-11-11 amendment): Group home says why it
 * only reads and how it opens, offers Remove from this device and nothing
 * new, and the Document, a Proposal, the Dispatches and every screen that
 * writes read only, each saying so where it would have asked for something.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { MINUTE_MS } from '../app/time';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import { Dispatches } from './Dispatches';
import { DocumentView } from './DocumentView';
import { GroupHome, type GroupHomeProps } from './GroupHome';
import { GroupUnconfirmed } from './GroupStatus';
import { ProposalView, type ProposalViewProps } from './ProposalView';

const NOTE =
  'This copy came from a backup, and nothing new from your group has reached this device since. If your group dissolved after the backup was made, this copy stays read-only.';
const OPENS =
  'It opens as usual as soon as this device sees anything new from your group. To open it sooner, ask someone in your group for a new invite link and open it here.';

function renderHome(state: GroupState, props: Partial<GroupHomeProps> = {}) {
  const now = state.at;
  render(
    <GroupHome
      state={state}
      me={authorOf('ana')}
      makeInviteLink={() => Promise.resolve(`https://reconcile.example/#join/${'s'.repeat(43)}`)}
      copyText={() => Promise.resolve()}
      now={now}
      sync={{
        reachable: true,
        lastSyncAt: now * MINUTE_MS,
        deviceNow: now * MINUTE_MS,
        missingHistory: true,
      }}
      pending={[]}
      onChooseLevel={() => Promise.resolve()}
      onSuspend={() => Promise.resolve()}
      onVouch={() => Promise.resolve()}
      onLeave={() => Promise.resolve()}
      onRemove={() => Promise.resolve()}
      unconfirmed
      {...props}
    />,
  );
  return userEvent.setup();
}

function renderProposal(state: GroupState, proposalId: string, props: Partial<ProposalViewProps>) {
  render(
    <ProposalView
      state={state}
      me={authorOf('ana')}
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

/** Ana founds; Ben and Kim join as Co-Creators, and Kim is still earning a vote (#101). */
function group() {
  return groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
}

describe('Group home for a copy back from a backup (#231)', () => {
  it('says why it only reads and how it opens, in place of the line on missing history', async () => {
    const log = group();
    log.propose('ben', { title: 'Later quiet hours' });
    renderHome(log.state());

    const note = screen.getByText('Read-only for now').parentElement ?? document.body;
    expect(within(note).getByText(NOTE)).toBeVisible();
    expect(within(note).getByText(OPENS)).toBeVisible();
    expect(within(note).getByRole('button', { name: 'Remove from this device' })).toBeVisible();
    expect(screen.queryByText(/Some history may be missing/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('asks for nothing new: no vote waiting, focus to ask, level, Leave, invite, Vouch or dissolve', () => {
    const log = group();
    log.propose('ben', { title: 'Later quiet hours' });
    log.dispatch('Ana', { title: 'Meet on Sunday', text: 'Bring a chair.' });
    renderHome(log.state(), { applications: <p>The applications</p> });

    expect(screen.queryByRole('region', { name: 'Needs your vote' })).toBeNull();
    const open = screen.getByRole('region', { name: 'Open Proposals' });
    expect(within(open).getByRole('link', { name: /Later quiet hours/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Ask what to focus on/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Your involvement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave this group' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Invite people' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Vouch for/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Decided' })).toBeVisible();
  });

  it('shows no backup or recovery card: no file carries it, and no share held there goes back (#109)', () => {
    renderHome(group().state(), {
      backupCard: <p>The backup card</p>,
      recoveryCard: <p>The recovery card</p>,
    });

    expect(screen.queryByText('The backup card')).toBeNull();
    expect(screen.queryByText('The recovery card')).toBeNull();
  });

  it('removes the copy only once confirmed', async () => {
    const onRemove = vi.fn(() => Promise.resolve());
    const user = renderHome(group().state(), { onRemove });

    await user.click(screen.getByRole('button', { name: 'Remove from this device' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this group from this device?' });
    expect(onRemove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));

    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('shows no note once it has heard from the group', () => {
    renderHome(group().state(), { unconfirmed: false });

    expect(screen.queryByText('Read-only for now')).toBeNull();
    expect(screen.getByText(/Some history may be missing/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Leave this group' })).toBeVisible();
  });
});

describe('a copy back from a backup elsewhere (#231)', () => {
  it('reads its Document with no Propose a change and no note about levels', () => {
    const log = group();
    render(
      <DocumentView
        state={log.state()}
        me={authorOf('kim')}
        onPropose={() => undefined}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onMove={() => undefined}
        onProtect={() => undefined}
        copyText={() => Promise.resolve()}
        unconfirmed
      />,
    );

    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add a section here/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move this section/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Protect this section/ })).toBeNull();
    expect(screen.queryByText(/^You can vote on Proposals that open after/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy as Markdown' })).toBeVisible();
  });

  it('shows an open Proposal with no ballot, version or chat message, and says why', async () => {
    const log = group();
    const open = log.propose('ben', { title: 'Later quiet hours' });
    renderProposal(log.state(), open, { unconfirmed: true });

    expect(
      screen.getByText(
        'This copy came from a backup and hasn’t heard from your group since, so you can’t vote here yet.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send your vote' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tell your group' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Propose again or chat message on a result', () => {
    const log = group();
    const lapsed = log.propose('ben', { title: 'Later quiet hours' });
    log.minute = deadlineOf(log.minute) + 1;
    renderProposal(log.state(), lapsed, { unconfirmed: true });

    expect(screen.getByText(messages.result.lapsed)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tell your group' })).toBeNull();
    cleanup();
    renderProposal(log.state(), lapsed, {});
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeVisible();
  });

  it('lists the Dispatches with no Send a Dispatch', () => {
    const log = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: 'Bring a chair.' });
    render(
      <Dispatches state={log.state()} me={authorOf('ana')} pending={[]} reachable unconfirmed />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Meet on Sunday' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
  });

  it('shows a screen that would write as read-only for now, with the way back to the group', async () => {
    render(<GroupUnconfirmed groupId="group-1" name="Riverside Tenants" />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This group is read-only for now' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This copy came from a backup and hasn’t heard from your group since. Nothing new can be proposed or sent until it does.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Riverside Tenants/ })).toHaveAttribute(
      'href',
      '#/g/group-1',
    );
    expect(await axeViolations()).toEqual([]);
  });
});
