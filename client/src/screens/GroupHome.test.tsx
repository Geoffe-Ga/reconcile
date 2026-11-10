import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute, formatSyncedAt, MINUTE_MS } from '../app/time';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup, type TestGroupOptions } from '../test/groups';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { authorOf } from '../test/keys';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const LINK = 'https://reconcile.example/#/join/mailbox.secret';
const NOW = START_MINUTE + 60;
const SYNCED = { reachable: true, lastSyncAt: NOW * MINUTE_MS, deviceNow: NOW * MINUTE_MS };

function renderHome(state: GroupState, props: Partial<GroupHomeProps> = {}) {
  const copyText = vi.fn(() => Promise.resolve());
  render(
    <GroupHome
      state={state}
      me={authorOf('ana')}
      inviteLink={LINK}
      copyText={copyText}
      now={NOW}
      sync={SYNCED}
      {...props}
    />,
  );
  return { user: userEvent.setup(), copyText };
}

function setup(options: TestGroupOptions = {}, me?: string) {
  const group = testGroup({ joiners: ['Ben'], ...options });
  const { user, copyText } = renderHome(group.state, { me: me ?? group.founder });
  return { user, copyText, state: group.state };
}

const section = (name: string) => screen.getByRole('region', { name });

describe('GroupHome', () => {
  it('shows the group, its Document, open Proposals, people, the invite and the chat', async () => {
    const { state } = setup({ chat: 'https://chat.example.org/riverside' });

    expect(screen.getByRole('heading', { level: 1, name: 'Riverside Tenants' })).toBeVisible();
    expect(screen.getByText('Your group', { selector: 'p' })).toBeVisible();
    const documentLink = screen.getByRole('link', { name: /House rules/ });
    expect(documentLink).toHaveAttribute('href', `#/g/${state.group ?? ''}/doc`);
    expect(within(section('Open Proposals')).getByText('Nothing to vote on yet.')).toBeVisible();
    const people = within(section('People')).getAllByRole('listitem');
    expect(people.map((item) => item.textContent)).toEqual(['Ana', 'Ben']);
    const field = within(section('Invite people')).getByRole('textbox', { name: 'Invite link' });
    expect(field).toHaveValue(LINK);
    expect(field).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/riverside',
    );
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('copies the invite link, and says so', async () => {
    const { user, copyText } = setup();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(copyText).toHaveBeenCalledWith(LINK);
    expect(within(section('Invite people')).getByRole('status')).toHaveTextContent(
      'Copied. Send it to the people you’re inviting.',
    );
  });

  it('points to the field when the browser blocks copying', async () => {
    const user = userEvent.setup();
    const group = testGroup();
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    renderHome(group.state, { me: group.founder, copyText });
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(within(section('Invite people')).getByRole('status')).toHaveTextContent(
      'Copying is blocked here. Select the link above and copy it yourself.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('selects the whole link when the field takes focus', async () => {
    const { user } = setup();
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Invite link' });
    await user.click(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(LINK.length);
  });

  it('lists the open Proposals by title', () => {
    setup({ proposals: ['Later quiet hours on Fridays'] });
    const open = section('Open Proposals');
    expect(within(open).getByRole('listitem')).toHaveTextContent('Later quiet hours on Fridays');
    expect(within(open).queryByText('Nothing to vote on yet.')).not.toBeInTheDocument();
  });

  it('links each open Proposal to its ballot, with a countdown, and leaves out closed ones', async () => {
    const log = groupLog();
    const decided = log.propose('ana', { title: 'Bins on Monday', atom: 1 });
    log.vote('ana', decided, 4);
    log.vote('ben', decided, 4);
    log.minute += 60;
    const open = log.propose('ben', { title: 'Later quiet hours' });
    renderHome(log.state(NOW), { now: NOW });

    const items = within(section('Open Proposals')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const card = within(section('Open Proposals')).getByRole('link', { name: /Later quiet hours/ });
    expect(card).toHaveAttribute('href', `#/g/${log.group}/p/${open}`);
    expect(card).toHaveTextContent('Closes in 7 days');
    expect(within(card).getByText(formatMinute(deadlineOf(START_MINUTE + 60))).tagName).toBe(
      'TIME',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('points Join discussion at the latest Proposal’s link, in its own row', () => {
    const log = groupLog({ chat: 'https://chat.example.org/riverside' });
    log.propose('ana', { link: 'https://chat.example.org/quiet-hours' });
    renderHome(log.state());
    expect(
      within(section('Discussion')).getByRole('link', { name: /Join discussion/ }),
    ).toHaveAttribute('href', 'https://chat.example.org/quiet-hours');
  });

  it('says when it can’t reach the relay, and when it last synced', async () => {
    const lastSyncAt = (NOW - 90) * MINUTE_MS;
    const sync = { reachable: false, lastSyncAt, deviceNow: NOW * MINUTE_MS };
    renderHome(groupLog().state(), { sync });
    expect(screen.getByText(/^Can’t reach the relay right now/)).toHaveTextContent(
      `Can’t reach the relay right now. Last synced ${formatSyncedAt(lastSyncAt, NOW * MINUTE_MS)}.`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says it can’t reach the relay before any sync has finished', () => {
    const sync = { reachable: false, lastSyncAt: null, deviceNow: NOW * MINUTE_MS };
    renderHome(groupLog().state(), { sync });
    expect(screen.getByText(/^Can’t reach the relay right now/)).toHaveTextContent(
      /^Can’t reach the relay right now\.$/,
    );
  });

  it('says nothing about the relay while it answers', () => {
    renderHome(groupLog().state());
    expect(screen.queryByText(/Can’t reach the relay/)).not.toBeInTheDocument();
  });

  it('tells two people of the same name apart by a key suffix, inside <bdi>', () => {
    setup({ joiners: ['Sam', 'sam ', 'Sammy'] });
    const people = within(section('People')).getAllByRole('listitem');
    const [ana, sam, other, sammy] = people.map((item) => item.textContent);
    expect([ana, sammy]).toEqual(['Ana', 'Sammy']);
    expect(sam).toMatch(/^Sam · [0-9a-f]{4}$/);
    expect(other).toMatch(/^sam {2}· [0-9a-f]{4}$/);
    expect(sam?.slice(-4)).not.toBe(other?.slice(-4));
    for (const item of people) expect(item.firstElementChild?.tagName).toBe('BDI');
  });

  it('shows people and the invite only to someone who may see them', () => {
    setup({}, 'stranger');
    expect(screen.queryByRole('region', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite people' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
  });

  it.each([
    ['no chat link', undefined],
    ['a javascript: chat link', 'javascript:alert(1)'],
  ])('offers no Join discussion for %s', (_label, chat) => {
    setup(chat === undefined ? {} : { chat });
    expect(screen.queryByRole('link', { name: /Join discussion/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Discussion' })).not.toBeInTheDocument();
  });
});
