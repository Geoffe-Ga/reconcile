import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { formatMinute, formatSyncedAt, MINUTE_MS } from '../app/time';
import { type Level, LEVELS } from '../engine/capabilities';
import { createEvent, type ParsedEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup, type TestGroupOptions } from '../test/groups';
import { DOOR } from '../test/door';
import { held, pastPressFallback } from '../test/press';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { authorOf } from '../test/keys';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const LINK = `https://reconcile.example/#join/${'s'.repeat(43)}`;
const [FOLLOWING, VOTING, CREATING] = LEVELS;
const NOW = START_MINUTE + 60;
const SYNCED = {
  reachable: true,
  lastSyncAt: NOW * MINUTE_MS,
  deviceNow: NOW * MINUTE_MS,
  missingHistory: false,
};

type OnChooseLevel = (level: Level) => Promise<void>;
type CopyText = GroupHomeProps['copyText'];
type OnLeave = () => Promise<void>;

function renderHome(state: GroupState, props: Partial<GroupHomeProps> = {}) {
  const copied: string[] = [];
  const copyText = vi.fn<CopyText>(async (text) => {
    copied.push(await text);
  });
  const makeInviteLink = vi.fn(() => Promise.resolve(LINK));
  const onChooseLevel = vi.fn<OnChooseLevel>(() => Promise.resolve());
  const onLeave = vi.fn<OnLeave>(() => Promise.resolve());
  const all: GroupHomeProps = {
    state,
    me: authorOf('ana'),
    makeInviteLink,
    copyText,
    now: NOW,
    sync: SYNCED,
    pending: [],
    onChooseLevel,
    onLeave,
    onSuspend: vi.fn(() => Promise.resolve()),
    onVouch: vi.fn(() => Promise.resolve()),
    ...props,
  };
  const view = render(<GroupHome {...all} />);
  const rerender = (next: Partial<GroupHomeProps>) => {
    view.rerender(<GroupHome {...all} {...next} />);
  };
  return {
    user: userEvent.setup(),
    copied,
    copyText: all.copyText,
    makeInviteLink: all.makeInviteLink,
    onChooseLevel: all.onChooseLevel,
    onLeave: all.onLeave,
    rerender,
  };
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
  const home = renderHome(group.state, { me: me ?? group.founder });
  return { ...home, state: group.state };
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
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/riverside',
    );
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('says beside Copy invite link what a leaked link opens, and makes no link until pressed', async () => {
    const { makeInviteLink } = setup();
    const invite = section('Invite people');
    const button = within(invite).getByRole('button', { name: 'Copy invite link' });
    const warning = within(invite).getByText(messages.home.inviteWarning);
    expect(warning).toHaveTextContent(
      'Anyone who opens this link in the next 2 days can read everything this group has written and voted on, and what comes next. Send it directly to the people you’re inviting.',
    );
    expect(button).toHaveAccessibleDescription(messages.home.inviteWarning);
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(invite).queryByRole('textbox')).not.toBeInTheDocument();
    expect(makeInviteLink).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('makes a link, copies it once the relay has it, shows it, and says so', async () => {
    const { user, copied, copyText, makeInviteLink } = setup();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    const invite = section('Invite people');
    expect(await within(invite).findByRole('textbox', { name: 'Invite link' })).toHaveValue(LINK);
    expect(within(invite).getByRole('textbox')).toHaveAttribute('readonly');
    expect(makeInviteLink).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copied).toEqual([LINK]);
    expect(within(invite).getByRole('status')).toHaveTextContent(
      'Copied. Send it to the people you’re inviting.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says “Making…” while the relay takes the envelope, and makes one link per press', async () => {
    const user = userEvent.setup();
    let finish: (link: string) => void = () => undefined;
    const makeInviteLink = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    renderHome(testGroup().state, { me: authorOf('ana'), makeInviteLink });
    const button = screen.getByRole('button', { name: 'Copy invite link' });
    await user.click(button);
    await user.click(button);
    const invite = section('Invite people');
    expect(within(invite).getByRole('status')).toHaveTextContent('Making your invite link…');
    finish(LINK);
    expect(await within(invite).findByRole('textbox', { name: 'Invite link' })).toHaveValue(LINK);
    expect(makeInviteLink).toHaveBeenCalledTimes(1);
  });

  it('copies nothing and says so when the link can’t be made', async () => {
    const user = userEvent.setup();
    const makeInviteLink = vi.fn(() => Promise.reject(new Error('offline')));
    const { copied } = renderHome(testGroup().state, { me: authorOf('ana'), makeInviteLink });
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    const invite = section('Invite people');
    await waitFor(() => {
      expect(within(invite).getByRole('status')).toHaveTextContent(messages.home.makeFailed);
    });
    expect(messages.home.makeFailed).toBe(
      'The invite link couldn’t be made, so nothing was copied. Making one needs the relay. Check your connection, then try again.',
    );
    expect(copied).toEqual([]);
    expect(within(invite).queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('points to the link when the browser blocks copying', async () => {
    const user = userEvent.setup();
    const group = testGroup();
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    renderHome(group.state, { me: group.founder, copyText });
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    const invite = section('Invite people');
    expect(await within(invite).findByRole('textbox', { name: 'Invite link' })).toHaveValue(LINK);
    expect(within(invite).getByRole('status')).toHaveTextContent(
      'Copying is blocked here. Select the link above and copy it yourself.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('selects the whole link when the field takes focus', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Invite link' });
    await user.click(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(LINK.length);
  });

  it('says some history may be missing while the flag is set, and nothing otherwise', async () => {
    const group = testGroup();
    const { rerender } = renderHome(group.state, { sync: { ...SYNCED, missingHistory: true } });
    expect(screen.getByText(messages.home.missingHistory)).toHaveTextContent(
      'Some history may be missing on this device. Open a new invite link from your group to catch up.',
    );
    expect(await axeViolations()).toEqual([]);
    rerender({ sync: SYNCED });
    expect(screen.queryByText(messages.home.missingHistory)).not.toBeInTheDocument();
  });

  it.each([
    ['left', 'You left this group on another device.'],
    [
      'missed',
      'This group’s key changed and this device didn’t get the new one. Ask someone in the group for a new invite link.',
    ],
  ] as const)(
    'says why this device can’t read on once the key changed (%s), and offers no invite link (#98)',
    async (keyChange, line) => {
      const group = testGroup();
      const { rerender } = renderHome(group.state, { sync: { ...SYNCED, keyChange } });
      const said = keyChange === 'left' ? messages.home.keyLeft : messages.home.keyMissed;
      expect(said).toBe(line);
      expect(screen.getByText(line)).toHaveClass('notice');
      expect(screen.getByText(line).closest('[role="status"]')).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
      expect(await axeViolations()).toEqual([]);
      rerender({ sync: { ...SYNCED, keyChange: null } });
      expect(screen.queryByText(line)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    },
  );

  it('says who invited each person, once a verified token names them', async () => {
    const group = testGroup({
      joiners: ['Ben', 'Cal', 'Dee'],
      invitedBy: { Ben: 'Ana', Cal: 'Ben' },
    });
    renderHome(group.state, { me: group.founder });
    expect(rows()).toEqual([
      'Ana, Co-Creator, Steward',
      'Ben, invited by Ana, Co-Creator',
      'Cal, invited by Ben, Co-Creator',
      'Dee, Co-Creator',
    ]);
    const ben = within(section('People')).getAllByRole('listitem')[1];
    expect(ben?.querySelectorAll('bdi')).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);
  });

  it('lists the open Proposals waiting on this person by title, under Needs your vote', () => {
    setup({ proposals: ['Later quiet hours on Fridays'] });
    const open = section('Needs your vote');
    expect(within(open).getByRole('listitem')).toHaveTextContent('Later quiet hours on Fridays');
    expect(screen.queryByText('Nothing to vote on yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Open Proposals/ })).not.toBeInTheDocument();
  });

  it('links each open Proposal to its ballot, with a countdown, and leaves out closed ones', async () => {
    const log = groupLog();
    const decided = log.propose('ana', { title: 'Bins on Monday', atom: 1 });
    log.vote('ana', decided, 4);
    log.vote('ben', decided, 4);
    log.minute += 60;
    const open = log.propose('ben', { title: 'Later quiet hours' });
    renderHome(log.state(NOW), { now: NOW });

    const items = within(section('Needs your vote')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const card = within(section('Needs your vote')).getByRole('link', {
      name: /Later quiet hours/,
    });
    expect(card).toHaveAttribute('href', `#/g/${log.group}/p/${open}`);
    expect(card).toHaveTextContent('Closes in 7 days');
    expect(within(card).getByText(formatMinute(deadlineOf(START_MINUTE + 60))).tagName).toBe(
      'TIME',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows, in order: Needs your vote, Focus, the other open Proposals, Dispatches (#112), the Document, Decided, People', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const scored = log.propose('ben', { title: 'Bins on Monday', atom: 1 });
    log.vote('ana', scored, 3);
    log.minute += 60;
    const waiting = log.propose('ben', { title: 'Later quiet hours' });
    const now = log.minute + 1;
    renderHome(log.state(now), { now });

    const regions = screen
      .getAllByRole('region')
      .map((region) => region.querySelector('h2')?.textContent);
    expect(regions.slice(0, 7)).toEqual([
      'Needs your vote',
      'Focus',
      'Other open Proposals',
      'Dispatches',
      'Document',
      'Decided',
      'People',
    ]);
    expect(within(section('Needs your vote')).getByRole('link')).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${waiting}`,
    );
    expect(within(section('Other open Proposals')).getByRole('link')).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${scored}`,
    );
    expect(within(section('Document')).getByRole('link', { name: /House rules/ })).toHaveAttribute(
      'href',
      `#/g/${log.group}/doc`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('moves a Proposal out of Needs your vote once the relay returns this person’s ballot', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ben', { title: 'Later quiet hours' });
    const { rerender } = renderHome(log.state(), { now: log.minute });
    expect(within(section('Needs your vote')).getByRole('link')).toHaveTextContent(
      'Later quiet hours',
    );

    log.vote('ana', p, 4);
    rerender({ state: log.state() });

    expect(screen.queryByRole('region', { name: 'Needs your vote' })).not.toBeInTheDocument();
    expect(within(section('Open Proposals')).getByRole('link')).toHaveTextContent(
      'Later quiet hours',
    );
  });

  it('keeps a Proposal in Needs your vote while a new version waits for this person’s score', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ben', { title: 'Later quiet hours' });
    log.vote('ana', p, 4);
    log.version('cal', p, 'Quiet after midnight.');
    renderHome(log.state(), { now: log.minute });
    expect(within(section('Needs your vote')).getByRole('link')).toHaveTextContent(
      'Later quiet hours',
    );
  });

  it('never lists under Needs your vote a Proposal this person can’t vote on', () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: FOLLOWING } });
    log.propose('ana', { title: 'Later quiet hours' });
    log.join('Cal');
    renderHome(log.state(), { now: log.minute, me: authorOf('ben') });
    expect(screen.queryByRole('region', { name: 'Needs your vote' })).not.toBeInTheDocument();
    expect(within(section('Open Proposals')).getByRole('link')).toHaveTextContent(
      'Later quiet hours',
    );
    cleanup();
    renderHome(log.state(), { now: log.minute, me: authorOf('cal') });
    expect(screen.queryByRole('region', { name: 'Needs your vote' })).not.toBeInTheDocument();
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

  it('adds “Scores cleared” to a decided entry once this device has cleared its ballots (#111)', async () => {
    const log = groupLog({ members: ['Ben'] });
    const cleared = log.propose('ana', { title: 'Later quiet hours' });
    const kept = log.propose('ana', { title: 'Paint the hall', atom: 1 });
    log.minute += 2;
    log.result('ana', {
      proposal: cleared,
      closedAt: START_MINUTE + 1,
      eligible: 2,
      versions: [{ id: cleared, counts: [0, 0, 0, 1, 1] }],
      outcome: { kind: 'pass', version: cleared },
      commit: 'kept',
    });
    const now = deadlineOf(START_MINUTE) + 5;
    renderHome(log.state(now, [cleared]), { now });

    const cards = within(section('Decided')).getAllByRole('link');
    expect(cards.map((card) => card.getAttribute('href'))).toEqual([
      `#/g/${log.group}/p/${kept}`,
      `#/g/${log.group}/p/${cleared}`,
    ]);
    expect(cards.map((card) => card.textContent)).toEqual([
      `Paint the hall→Lapsed${formatDay(deadlineOf(START_MINUTE))}`,
      `Later quiet hours→Passed${formatDay(START_MINUTE + 1)}${messages.decided.cleared}`,
    ]);
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
    const sync = { ...SYNCED, reachable: false, lastSyncAt };
    renderHome(groupLog().state(), { sync });
    expect(screen.getByText(/^Can’t reach the relay right now/)).toHaveTextContent(
      `Can’t reach the relay right now. Last synced ${formatSyncedAt(lastSyncAt, NOW * MINUTE_MS)}.`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says it can’t reach the relay before any sync has finished', () => {
    const sync = { ...SYNCED, reachable: false, lastSyncAt: null };
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
    const [ana, sam, other, sammy] = people.map((item) => item.querySelector('bdi')?.textContent);
    expect([ana, sammy]).toEqual(['Ana', 'Sammy']);
    expect(sam).toMatch(/^Sam · [0-9a-f]{4}$/);
    expect(other).toMatch(/^sam {2}· [0-9a-f]{4}$/);
    expect(sam?.slice(-4)).not.toBe(other?.slice(-4));
    for (const item of people) {
      expect(item.querySelector('.person-name')).toBe(item.querySelector('bdi'));
    }
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

  it('keeps the choice when another level is tapped while it saves and saving fails (#193)', async () => {
    const saving = held<undefined>();
    const onChooseLevel = vi.fn<OnChooseLevel>(() => saving.promise);
    const { user } = renderHome(testGroup({ joiners: ['Ben'] }).state, {
      me: authorOf('ben'),
      onChooseLevel,
    });
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    await user.click(screen.getByRole('button', { name: 'Save your choice' }));
    const collaborator = screen.getByRole('radio', { name: 'Collaborator' });
    expect(collaborator).toBeDisabled();
    await user.click(collaborator);
    saving.reject();
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(collaborator).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Member' })).toBeChecked();
    expect(onChooseLevel).toHaveBeenCalledTimes(1);
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

  it('shows the current focus after a pass, linking to its result, under Needs your vote', async () => {
    const { log, id } = focused();
    renderHome(log.state());
    const focus = section('Focus');
    const card = within(focus).getByRole('link', { name: /Current focus/ });
    expect(card).toHaveTextContent('Current focusFix the website');
    expect(card).toHaveAttribute('href', `#/g/${log.group}/p/${id}`);
    const order = [...document.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(order.slice(0, 5)).toEqual([
      'Focus',
      'Open Proposals',
      'Dispatches',
      'Document',
      'Decided',
    ]);
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
    expect(within(section('Needs your vote')).getByText('What should we focus on?')).toBeVisible();
    const order = [...document.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(order.slice(0, 2)).toEqual(['Needs your vote', 'Focus']);
  });

  it('offers no Ask what to focus on while this member is leaving', () => {
    renderHome(testGroup({ joiners: ['Ben'] }).state, { leaving: true });
    expect(within(section('Focus')).queryByRole('link')).toBeNull();
  });

  it('keeps the focus a dissolved group had, after its Proposals that never closed, with no Ask (#108)', async () => {
    const { log, id } = focused();
    log.minute += 5;
    const open = log.ask('ben', ['New bylaws', 'Rent strike']);
    const end = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben', 'cal']) log.vote(name, end, 4);
    log.minute += 1;
    log.dissolve('ana', end);
    renderHome(log.state(log.minute + 50_000));

    const focus = section('Focus');
    expect(within(focus).getByRole('link', { name: /Current focus/ })).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${id}`,
    );
    expect(within(focus).queryByRole('link', { name: 'Ask what to focus on' })).toBeNull();
    const order = [...document.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(order.slice(0, 2)).toEqual(['Not decided', 'Focus']);
    expect(within(section('Not decided')).getByRole('link')).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${open}`,
    );
    expect(await axeViolations()).toEqual([]);
  });
});

describe('Leave this group', () => {
  const dialog = () => screen.getByRole('alertdialog', { name: 'Leave this group?' });

  it('sits in People and opens an alert dialog that says what leaving does and doesn’t do', async () => {
    const { user, onLeave } = setup();
    const open = within(section('People')).getByRole('button', { name: 'Leave this group' });
    await user.click(open);

    expect(dialog()).toHaveTextContent(
      'Leaving removes this group from this device. Others keep what they already have. When you leave, the group gets a new key, so this device and any backup can’t read what comes next.',
    );
    expect(dialog()).toHaveTextContent(messages.leave.body);
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    // Everything behind the dialog is hidden from assistive technology while it's open.
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps focus inside the dialog, and Cancel closes it with nothing queued', async () => {
    const { user, onLeave } = setup();
    const open = within(section('People')).getByRole('button', { name: 'Leave this group' });
    await user.click(open);
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    }
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(open).toHaveFocus();
    });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('closes on Escape with nothing queued', async () => {
    const { user, onLeave } = setup();
    await user.click(within(section('People')).getByRole('button', { name: 'Leave this group' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('leaves once, however often the confirm is pressed, then closes', async () => {
    let finish: () => void = () => undefined;
    const onLeave = vi.fn<OnLeave>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderHome(testGroup({ joiners: ['Ben'] }).state, { onLeave });
    await user.click(within(section('People')).getByRole('button', { name: 'Leave this group' }));
    const confirm = within(dialog()).getByRole('button', { name: 'Leave this group' });
    await user.click(confirm);
    await user.click(confirm);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    finish();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('says so in the dialog when the leave couldn’t be saved, and lets them try again', async () => {
    const onLeave = vi.fn<OnLeave>(() => Promise.reject(new Error('full')));
    const { user } = renderHome(testGroup({ joiners: ['Ben'] }).state, { onLeave });
    await user.click(within(section('People')).getByRole('button', { name: 'Leave this group' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Leave this group' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Leaving couldn’t be saved on this device. Try again.',
    );
    expect(within(dialog()).getByRole('button', { name: 'Leave this group' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('reads Leaving… while the leave waits, with no voting list, level choice, invite or Leave', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.propose('ben', { title: 'Later quiet hours' });
    renderHome(log.state(), { now: log.minute, leaving: true });

    expect(screen.getByText('Leaving…', { selector: '.leaving-note *' })).toBeVisible();
    expect(
      screen.getByText(
        'This group leaves this device as soon as the relay has your leave. Until then, you can read it but not propose or vote.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Needs your vote' })).not.toBeInTheDocument();
    expect(within(section('Open Proposals')).getByRole('link')).toHaveTextContent(
      'Later quiet hours',
    );
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite people' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave this group' })).not.toBeInTheDocument();
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Co-Creator', 'Cal, Co-Creator']);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers a steward no Suspend and no steward Proposal while the leave waits (#102)', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const { rerender } = renderHome(log.state(), { now: log.minute });
    // Staying, Ana, the founding steward, may suspend Ben and propose an election.
    expect(screen.getByRole('button', { name: 'Suspend Ben' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Propose a steward for seat 1' })).toBeVisible();

    rerender({ leaving: true });

    expect(screen.queryByRole('button', { name: /^Suspend/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Propose a steward|^Propose recall/ })).toBeNull();
    expect(within(section('Stewards')).getByText('Ana')).toBeVisible();
  });

  it('lists current members only: someone who left is gone from People', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.leave('Ben');
    renderHome(log.state());
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Cal, Co-Creator']);
  });
});

describe('GroupHome: the group’s rules (#117)', () => {
  it('links to the rules, saying where the chat bot and the front door stand', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const door = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, door, 4);
    renderHome(log.state(), { me: authorOf('ben') });
    const rules = section('Rules');
    const link = within(rules).getByRole('link', { name: /Chat bot and front door/ });
    expect(link).toHaveAttribute('href', `#/g/${log.group}/rules`);
    expect(link).toHaveTextContent('Chat bot: Off · Front door: Open');
    expect(await axeViolations()).toEqual([]);
  });
});

describe('GroupHome: the front door’s Applications (#121)', () => {
  it('shows them under their own heading, before Invite people', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    renderHome(log.state(), { applications: <p>Kim’s card</p> });
    const applications = section('Applications');
    expect(within(applications).getByText('Kim’s card')).toBeVisible();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Applications')).toBe(headings.indexOf('Invite people') - 1);
  });

  it('shows none while this member’s leave waits for the relay, nor when none are given', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const { rerender } = renderHome(log.state(), {
      applications: <p>Kim’s card</p>,
      leaving: true,
    });
    expect(screen.queryByRole('region', { name: 'Applications' })).toBeNull();
    rerender({ applications: undefined, leaving: false });
    expect(screen.queryByRole('region', { name: 'Applications' })).toBeNull();
  });
});

describe('GroupHome: the front door beside Dispatches (#112, #121)', () => {
  it('keeps Dispatches and Applications each in its own section, Applications before Invite people', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.dispatch('Ana', { title: 'Our front door is open', text: 'Share the link.' });
    renderHome(log.state(), { applications: <p>Kim’s card</p> });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toContain('Dispatches');
    expect(headings.indexOf('Applications')).toBe(headings.indexOf('Invite people') - 1);
    expect(within(section('Dispatches')).getByText('Our front door is open')).toBeVisible();
    expect(within(section('Applications')).getByText('Kim’s card')).toBeVisible();
  });
});
