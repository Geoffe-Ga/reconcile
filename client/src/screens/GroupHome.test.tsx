import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatDay } from '../app/format';
import { formatMinute, formatSyncedAt, MINUTE_MS } from '../app/time';
import { type Level, LEVELS } from '../engine/capabilities';
import { createEvent, type ParsedEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup, type TestGroupOptions } from '../test/groups';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { authorOf } from '../test/keys';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const LINK = 'https://reconcile.example/#/join/group-secret';
const [FOLLOWING, VOTING, CREATING] = LEVELS;
const NOW = START_MINUTE + 60;
const SYNCED = { reachable: true, lastSyncAt: NOW * MINUTE_MS, deviceNow: NOW * MINUTE_MS };

type OnChooseLevel = (level: Level) => Promise<void>;

function renderHome(state: GroupState, props: Partial<GroupHomeProps> = {}) {
  const copyText = vi.fn(() => Promise.resolve());
  const onChooseLevel = vi.fn<OnChooseLevel>(() => Promise.resolve());
  const all: GroupHomeProps = {
    state,
    me: authorOf('ana'),
    inviteLink: LINK,
    copyText,
    now: NOW,
    sync: SYNCED,
    pending: [],
    onChooseLevel,
    onSuspend: vi.fn(() => Promise.resolve()),
    ...props,
  };
  const view = render(<GroupHome {...all} />);
  const rerender = (next: Partial<GroupHomeProps>) => {
    view.rerender(<GroupHome {...all} {...next} />);
  };
  return { user: userEvent.setup(), copyText, onChooseLevel: all.onChooseLevel, rerender };
}

/** A `level` event as `useGroup` lists it while it waits in the outbox. */
function pendingLevel(author: string, level: string): ParsedEvent {
  const input = { type: 'level', group: 'g', author, ts: 0, body: { level } } as const;
  const parsed = parseEvent(createEvent(input).bytes);
  if (parsed === null) throw new Error('Expected an event.');
  return parsed;
}

/** The text of each row of the People list, leaving out its buttons (Suspend, #102). */
const rows = () =>
  within(section('People'))
    .getAllByRole('listitem')
    .map((item) => {
      const copy = item.cloneNode(true) as HTMLElement;
      for (const button of copy.querySelectorAll('button')) button.remove();
      return copy.textContent;
    });

function setup(options: TestGroupOptions = {}, me?: string) {
  const group = testGroup({ joiners: ['Ben'], ...options });
  const { user, copyText, onChooseLevel } = renderHome(group.state, { me: me ?? group.founder });
  return { user, copyText, onChooseLevel, state: group.state };
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
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Co-Creator']);
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

  it('says nothing has been decided yet, in its own section', () => {
    setup({ proposals: ['Later quiet hours on Fridays'] });
    const decided = section('Decided');
    expect(within(decided).getByText('Nothing decided yet.')).toBeVisible();
    expect(within(decided).queryByRole('list')).not.toBeInTheDocument();
  });

  it('lists decided Proposals newest first, each with its outcome and close date, opening its result', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    // Lapses at its deadline, a week after the start.
    const lapsed = log.propose('ana', { title: 'Paint the hall', atom: 1 });
    // Passes early, ten minutes in.
    const passed = log.propose('ana', { title: 'Later quiet hours' });
    log.minute += 10;
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, passed, 4);
    // Fails early, a day in, on a section the first pass has left free again.
    log.minute = START_MINUTE + 1_440;
    const failed = log.propose('ben', { title: 'No quiet hours' });
    log.vote('ana', failed, 0, 'We need them.');
    log.vote('ben', failed, 2);
    log.vote('cal', failed, 1);
    const now = deadlineOf(START_MINUTE) + 5;
    renderHome(log.state(now), { now });

    const decided = section('Decided');
    const cards = within(decided).getAllByRole('link');
    expect(cards.map((card) => card.getAttribute('href'))).toEqual([
      `#/g/${log.group}/p/${lapsed}`,
      `#/g/${log.group}/p/${failed}`,
      `#/g/${log.group}/p/${passed}`,
    ]);
    expect(cards.map((card) => card.textContent)).toEqual([
      `Paint the hall→Lapsed${formatDay(deadlineOf(START_MINUTE))}`,
      `No quiet hours→Didn’t pass${formatDay(START_MINUTE + 1_440)}`,
      `Later quiet hours→Passed${formatDay(START_MINUTE + 10)}`,
    ]);
    const [date] = within(cards[0] as HTMLElement).getAllByText(
      formatDay(deadlineOf(START_MINUTE)),
    );
    expect(date?.tagName).toBe('TIME');
    expect(within(section('Open Proposals')).getByText('Nothing to vote on yet.')).toBeVisible();
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
    const [ana, sam, other, sammy] = people.map((item) => item.firstElementChild?.textContent);
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

  it('shows each person’s level beside their name', async () => {
    setup({ joiners: ['Ben', 'Kim'], levels: { Ben: VOTING, Kim: FOLLOWING } });
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Collaborator', 'Kim, Member']);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a Member the People list and their involvement, but no invite', async () => {
    setup({ joiners: ['Kim'], levels: { Kim: FOLLOWING } }, authorOf('kim'));
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Kim, Member']);
    expect(screen.getByRole('radio', { name: 'Member' })).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Invite people' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a Collaborator the invite', () => {
    setup({ joiners: ['Ben'], levels: { Ben: VOTING } }, authorOf('ben'));
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
  });

  it('puts Your involvement under the People list, at this person’s level, with nothing to save', async () => {
    setup({ joiners: ['Ben'], levels: { Ben: VOTING } }, authorOf('ben'));
    const people = section('People');
    const picker = within(people).getByRole('radiogroup', { name: 'Your involvement' });
    expect(
      within(people).getByRole('list').compareDocumentPosition(picker) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(picker).getByRole('radio', { name: 'Collaborator' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save your choice' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('queues one level change when they save a new choice, and says where it has got to', async () => {
    const { user, onChooseLevel, rerender } = renderHome(
      testGroup({ joiners: ['Ben'], levels: { Ben: VOTING } }).state,
      { me: authorOf('ben') },
    );
    await user.click(screen.getByRole('radio', { name: 'Co-Creator' }));
    await user.click(screen.getByRole('button', { name: 'Save your choice' }));
    expect(onChooseLevel).toHaveBeenCalledExactlyOnceWith(CREATING);

    // While it waits in the outbox, the picker shows the new choice and nothing more to save.
    rerender({ pending: [pendingLevel(authorOf('ben'), CREATING)] });
    expect(screen.getByRole('radio', { name: 'Co-Creator' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save your choice' })).not.toBeInTheDocument();
    expect(within(section('People')).getByRole('status')).toHaveTextContent('Sending…');
    // The People list changes only once the relay returns the event.
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Collaborator']);
    expect(await axeViolations()).toEqual([]);
  });

  it('hides Save again when they pick their level back before saving', async () => {
    const { user, onChooseLevel } = setup(
      { joiners: ['Ben'], levels: { Ben: VOTING } },
      authorOf('ben'),
    );
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    expect(screen.getByRole('button', { name: 'Save your choice' })).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Collaborator' }));
    expect(screen.queryByRole('button', { name: 'Save your choice' })).not.toBeInTheDocument();
    expect(onChooseLevel).not.toHaveBeenCalled();
  });

  it('says so when the choice couldn’t be saved, and keeps it to try again', async () => {
    const onChooseLevel = vi.fn<OnChooseLevel>(() => Promise.reject(new Error('full')));
    const { user } = renderHome(testGroup({ joiners: ['Ben'] }).state, {
      me: authorOf('ben'),
      onChooseLevel,
    });
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    await user.click(screen.getByRole('button', { name: 'Save your choice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your choice couldn’t be saved on this device. Try again.',
    );
    expect(screen.getByRole('radio', { name: 'Member' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save your choice' })).toBeVisible();
  });

  it('saves once, however often Save is pressed while it saves', async () => {
    let finish: () => void = () => undefined;
    const onChooseLevel = vi.fn<OnChooseLevel>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderHome(testGroup({ joiners: ['Ben'] }).state, {
      me: authorOf('ben'),
      onChooseLevel,
    });
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    const save = screen.getByRole('button', { name: 'Save your choice' });
    await user.click(save);
    await user.click(save);
    expect(onChooseLevel).toHaveBeenCalledTimes(1);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    finish();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Member' })).toBeEnabled();
    });
  });

  it('reads Sent once the change has left the outbox', async () => {
    const { user, rerender } = renderHome(testGroup({ joiners: ['Ben'] }).state, {
      me: authorOf('ben'),
    });
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    await user.click(screen.getByRole('button', { name: 'Save your choice' }));
    rerender({ pending: [pendingLevel(authorOf('ben'), FOLLOWING)] });
    const log = testGroup({ joiners: ['Ben'], levels: { Ben: FOLLOWING } });
    rerender({ state: log.state, pending: [] });
    expect(within(section('People')).getByRole('status')).toHaveTextContent('Sent');
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Member']);
  });

  it('offers no involvement choice before this device’s join is back from the relay', () => {
    setup({}, authorOf('cy'));
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
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

describe('GroupHome: the current focus (#107)', () => {
  /** Ana asks in a group of Ana, Ben and Cal, and all three score both options, closing it early. */
  function focused() {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.ask('ana', ['Fix the website', 'Plan the picnic']);
    const [a, b] = [`${id}.0`, `${id}.1`];
    log.minute += 5;
    log.ballot('ana', id, { [a]: 4, [b]: 2 });
    log.ballot('ben', id, { [a]: 3, [b]: 3 });
    log.ballot('cal', id, { [a]: 3, [b]: 2 });
    return { log, id };
  }

  it('says there is no focus yet, and offers Ask what to focus on to someone who can propose', async () => {
    const { state } = setup();
    const focus = section('Focus');
    expect(within(focus).getByText('Your group hasn’t chosen a focus yet.')).toBeVisible();
    expect(within(focus).getByRole('link', { name: 'Ask what to focus on' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/priority`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Ask what to focus on to someone who can’t propose', () => {
    setup({ levels: { Ben: VOTING } }, authorOf('ben'));
    expect(within(section('Focus')).queryByRole('link')).toBeNull();
  });

  it('shows the current focus after a pass, linking to its result, under the open Proposals', async () => {
    const { log, id } = focused();
    renderHome(log.state());
    const focus = section('Focus');
    const card = within(focus).getByRole('link', { name: /Current focus/ });
    expect(card).toHaveTextContent('Current focusFix the website');
    expect(card).toHaveAttribute('href', `#/g/${log.group}/p/${id}`);
    const order = [...document.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(order.slice(0, 3)).toEqual(['Open Proposals', 'Focus', 'Decided']);
    expect(within(focus).getByRole('link', { name: 'Ask what to focus on' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('names the top option on the Decided card of a priority vote that passed', () => {
    const { log } = focused();
    renderHome(log.state());
    const card = within(section('Decided')).getByRole('link', { name: /What should we focus on/ });
    expect(card).toHaveTextContent(/^What should we focus on\?→Fix the websitePassed/);
  });

  it('keeps the focus, and offers no Ask, while another priority vote is open', () => {
    const { log } = focused();
    log.minute += 5;
    log.ask('ben', ['New bylaws', 'Rent strike']);
    renderHome(log.state());
    const focus = section('Focus');
    expect(within(focus).getByRole('link', { name: /Current focus/ })).toHaveTextContent(
      'Fix the website',
    );
    expect(within(focus).queryByRole('link', { name: 'Ask what to focus on' })).toBeNull();
    expect(within(section('Open Proposals')).getByText('What should we focus on?')).toBeVisible();
  });
});
