/**
 * Group home's Dispatches (#112): the latest Dispatch with See all, Send a
 * Dispatch for someone who may send one, and, for a viewer without `vote`,
 * Dispatches leading the page ahead of the open Proposals.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { MINUTE_MS } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const [FOLLOWING, VOTING] = LEVELS;

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
}

const dispatches = () => screen.getByRole('region', { name: 'Dispatches' });

/** The heading of each section on the page, in order. */
const order = () =>
  screen.getAllByRole('region').map((region) => region.querySelector('h2')?.textContent);

/** Ana founds; Ben joins as a Collaborator and Kim as a Member; Ana proposes, so a vote is open. */
function group(): { log: LogBuilder; proposal: string } {
  const log = groupLog({ members: ['Ben', 'Kim'], levels: { Ben: VOTING, Kim: FOLLOWING } });
  const proposal = log.propose('Ana', { title: 'Later quiet hours' });
  log.minute += 1;
  return { log, proposal };
}

describe('GroupHome: Dispatches (#112)', () => {
  it('shows the latest Dispatch, with See all, and only the latest', async () => {
    const { log } = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: 'Bring a chair.' });
    log.minute += 1;
    log.dispatch('Ana', { title: 'Read the rules', text: '', doc: log.group });
    renderHome(log.state(), 'ben');

    const latest = within(dispatches()).getByRole('article');
    expect(within(latest).getByRole('heading', { level: 3 })).toHaveTextContent('Read the rules');
    expect(latest).toHaveTextContent('From Ana');
    expect(within(latest).getByRole('link', { name: 'Open House rules' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/doc/${log.group}`,
    );
    expect(within(dispatches()).queryByText('Meet on Sunday')).toBeNull();
    expect(within(dispatches()).getByRole('link', { name: 'See all Dispatches' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/dispatches`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('leads a Member’s page with Dispatches, ahead of the open Proposals', async () => {
    const { log } = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
    renderHome(log.state(), 'kim');
    expect(order().slice(0, 3)).toEqual(['Dispatches', 'Open Proposals', 'Documents']);
    expect(await axeViolations()).toEqual([]);
  });

  it('puts Dispatches after the open Proposals for someone who votes', () => {
    const { log } = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
    renderHome(log.state(), 'ben');
    expect(order().slice(0, 3)).toEqual(['Needs your vote', 'Dispatches', 'Documents']);
  });

  it('keeps the backup card with the open Proposals, ahead of a voter’s Dispatches (#78)', () => {
    const { log } = group();
    renderHome(log.state(), 'ben', { backupCard: <p>Save a backup card</p> });
    const card = screen.getByText('Save a backup card');
    const open = screen.getByRole('region', { name: 'Needs your vote' });
    expect(open.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      card.compareDocumentPosition(dispatches()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leads with Dispatches for a newcomer who can’t vote yet, whatever level they chose (#101)', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Dee'] });
    log.propose('Ana');
    renderHome(log.state(), 'dee');
    expect(order()[0]).toBe('Dispatches');
  });

  it('says when there are none, with no See all', () => {
    const { log } = group();
    renderHome(log.state(), 'kim');
    expect(within(dispatches()).getByText(messages.dispatches.empty)).toBeVisible();
    expect(within(dispatches()).queryByRole('link')).toBeNull();
  });

  it.each([
    ['a Co-Creator', 'ana', true],
    ['a Collaborator', 'ben', false],
    ['a Member', 'kim', false],
  ])('offers Send a Dispatch only to someone who may send one: %s', (_who, me, offered) => {
    const { log } = group();
    renderHome(log.state(), me);
    const send = within(dispatches()).queryByRole('link', { name: 'Send a Dispatch' });
    expect(send !== null).toBe(offered);
    if (send !== null) expect(send).toHaveAttribute('href', `#/g/${log.group}/dispatch/new`);
  });

  it('offers no Send a Dispatch while leaving, and keeps showing the latest', () => {
    const { log } = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
    renderHome(log.state(), 'ana', { leaving: true });
    expect(within(dispatches()).queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
    expect(within(dispatches()).getByRole('article')).toHaveTextContent('Meet on Sunday');
  });

  it('keeps a dissolved group’s Dispatches to read, with nothing to send', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.dispatch('Ana', { title: 'Before we go', text: '' });
    const end = log.proposeDissolve('Ana', false);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, end, 4);
    log.minute += 1;
    log.dissolve('Ana', end);
    renderHome(log.state(), 'ana');
    expect(within(dispatches()).getByRole('article')).toHaveTextContent('Before we go');
    expect(within(dispatches()).queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
    expect(
      within(dispatches()).getByRole('link', { name: 'See all Dispatches' }),
    ).toBeInTheDocument();
  });
});
