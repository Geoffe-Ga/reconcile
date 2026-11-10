/**
 * Group home's stewards and suspensions (#102): the Steward badge, Suspend,
 * the suspended line everyone reads, and the Stewards section with its seats,
 * the due line and Propose a steward or Propose recall.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute, MINUTE_MS } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import { createEvent, type ParsedEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const [FOLLOWING, VOTING] = LEVELS;
const UNTIL = START_MINUTE + 7 * DAY_MINUTES;
const REASON = 'Posting threats in the chat.';

type OnSuspend = GroupHomeProps['onSuspend'];

function renderHome(state: GroupState, me: string, props: Partial<GroupHomeProps> = {}) {
  const onSuspend = vi.fn<OnSuspend>(() => Promise.resolve());
  const now = state.at;
  render(
    <GroupHome
      state={state}
      me={me}
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
      onSuspend={onSuspend}
      onLeave={() => Promise.resolve()}
      {...props}
    />,
  );
  return { user: userEvent.setup(), onSuspend: props.onSuspend ?? onSuspend };
}

const section = (name: string) => screen.getByRole('region', { name });

/** Each People row's text, without its buttons. */
const rows = () =>
  within(section('People'))
    .getAllByRole('listitem')
    .map((item) => {
      const copy = item.cloneNode(true) as HTMLElement;
      for (const button of copy.querySelectorAll('button')) button.remove();
      return copy.textContent;
    });

/** Ana founds; Ben and Kim join as Co-Creators. */
const threeOf = () => groupLog({ members: ['Ben', 'Kim'] });

/** A `suspend` event as `useGroup` lists it while it waits in the outbox. */
function pendingSuspend(author: string, member: string): ParsedEvent {
  const input = { type: 'suspend', group: 'g', author, ts: 0, body: { member } } as const;
  const parsed = parseEvent(createEvent(input).bytes);
  if (parsed === null) throw new Error('Expected an event.');
  return parsed;
}

describe('GroupHome: the People list (#102)', () => {
  it('shows the founder’s Steward badge to everyone, and Suspend only to the steward', () => {
    renderHome(threeOf().state(), authorOf('ben'));
    expect(rows()).toEqual(['Ana, Co-Creator, Steward', 'Ben, Co-Creator', 'Kim, Co-Creator']);
    expect(screen.queryByRole('button', { name: /^Suspend/ })).toBeNull();
  });

  it('gives the steward Suspend on each other person, and none on themselves', async () => {
    renderHome(threeOf().state(), authorOf('ana'));
    const people = within(section('People'));
    expect(people.getByRole('button', { name: 'Suspend Ben' })).toBeVisible();
    expect(people.getByRole('button', { name: 'Suspend Kim' })).toBeVisible();
    expect(people.queryByRole('button', { name: 'Suspend Ana' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('queues one suspend for that person, with the reason, from the dialog', async () => {
    const { user, onSuspend } = renderHome(threeOf().state(), authorOf('ana'));
    await user.click(screen.getByRole('button', { name: 'Suspend Kim' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend Kim?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onSuspend).toHaveBeenCalledWith(authorOf('kim'), REASON);
  });

  it.each(['ana', 'ben', 'kim'])(
    'shows %s the suspended person’s "Suspended until <date>." line and reason, as plain text',
    async (me) => {
      const log = threeOf();
      log.suspend('Ana', 'Kim', '<b>Threats</b> **in** chat');
      renderHome(log.state(), authorOf(me));
      const kim = within(section('People')).getAllByRole('listitem')[2];
      if (kim === undefined) throw new Error('Expected Kim’s row.');
      expect(kim).toHaveTextContent(`Suspended until ${formatMinute(UNTIL)}.`);
      expect(within(kim).getByText('<b>Threats</b> **in** chat')).toBeVisible();
      expect(kim.querySelector('b, strong')).toBeNull();
      expect(await axeViolations()).toEqual([]);
    },
  );

  it('offers no Suspend while the steward’s one suspension runs', () => {
    const log = threeOf();
    log.suspend('Ana', 'Kim', REASON);
    renderHome(log.state(), authorOf('ana'));
    expect(screen.queryByRole('button', { name: /^Suspend/ })).toBeNull();
  });

  it('offers Suspend again after the suspension ends, but not on Kim within 30 days', () => {
    const log = threeOf();
    log.suspend('Ana', 'Kim', REASON);
    renderHome(log.state(UNTIL), authorOf('ana'));
    expect(screen.getByRole('button', { name: 'Suspend Ben' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Suspend Kim' })).toBeNull();
    expect(rows()[2]).toBe('Kim, Co-Creator');
  });

  it('hides Suspend while one waits in the outbox, and says so on that person’s row', () => {
    const state = threeOf().state();
    renderHome(state, authorOf('ana'), {
      pending: [pendingSuspend(authorOf('ana'), authorOf('kim'))],
    });
    expect(screen.queryByRole('button', { name: /^Suspend/ })).toBeNull();
    const kim = within(section('People')).getAllByRole('listitem')[2];
    expect(kim).toHaveTextContent('Sending…');
  });

  it('tells the suspended person until when, and disables their involvement choice', () => {
    const log = threeOf();
    log.suspend('Ana', 'Kim', REASON);
    renderHome(log.state(), authorOf('kim'));
    const line = `A steward suspended you until ${formatMinute(UNTIL)}. You can read, but not post, propose or vote.`;
    expect(screen.getByText(line)).toBeVisible();
    for (const radio of within(section('People')).getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
    expect(screen.queryByRole('region', { name: 'Invite people' })).toBeNull();
  });
});

describe('GroupHome: the Stewards section (#102)', () => {
  it('shows the founder in seat 1 and when seat 2 opens, with no election due at 2 voting members', async () => {
    renderHome(groupLog({ members: ['Ben'] }).state(), authorOf('ana'));
    const stewards = section('Stewards');
    expect(stewards).toHaveTextContent('Seat 1');
    expect(stewards).toHaveTextContent('Ana');
    expect(stewards).toHaveTextContent('Holds this seat until your group elects a steward.');
    expect(stewards).toHaveTextContent('A second seat opens once 6 people in your group vote.');
    expect(stewards).not.toHaveTextContent('election is due');
    expect(within(stewards).queryByRole('link', { name: /Propose a steward/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says an election is due for seat 1 at 3 voting members, with Propose a steward', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    renderHome(log.state(), authorOf('ben'));
    const stewards = within(section('Stewards'));
    expect(stewards.getByText('A steward election is due for seat 1.')).toBeVisible();
    expect(stewards.getByRole('link', { name: 'Propose a steward for seat 1' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/steward/1`,
    );
    expect(stewards.getByRole('link', { name: 'Propose recall of Ana' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/recall/1`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the due line but no Propose links to someone who can’t propose', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    renderHome(log.state(), authorOf('cal'));
    const stewards = within(section('Stewards'));
    expect(stewards.getByText('A steward election is due for seat 1.')).toBeVisible();
    expect(stewards.queryByRole('link')).toBeNull();
  });

  it('shows an elected steward’s term end, then the due line once it has passed', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposal = log.steward('Ben', 1, 'Ben');
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    const termEnd = START_MINUTE + 182 * DAY_MINUTES;
    renderHome(log.state(), authorOf('cal'));
    expect(section('Stewards')).toHaveTextContent(`Term ends ${formatMinute(termEnd)}.`);
    expect(section('Stewards')).not.toHaveTextContent('election is due');
    expect(rows()).toEqual(['Ana, Co-Creator', 'Ben, Co-Creator, Steward', 'Cal, Co-Creator']);
  });

  it('says a past-term steward stays until a successor, and that the election is due', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposal = log.steward('Ben', 1, 'Ben');
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    const termEnd = START_MINUTE + 182 * DAY_MINUTES;
    renderHome(log.state(termEnd), authorOf('cal'));
    const stewards = section('Stewards');
    expect(stewards).toHaveTextContent(
      `Term ended ${formatMinute(termEnd)}. They stay steward until your group elects someone.`,
    );
    expect(within(stewards).getByText('A steward election is due for seat 1.')).toBeVisible();
  });

  it('shows two due seats at 6 voting members, each with its own Propose link', () => {
    const log = groupLog({ members: ['Ben', 'Cal', 'Dee', 'Eve', 'Fay'] });
    renderHome(log.state(), authorOf('ben'));
    const stewards = within(section('Stewards'));
    expect(stewards.getByText('A steward election is due for seat 2.')).toBeVisible();
    expect(stewards.getByRole('link', { name: 'Propose a steward for seat 2' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/steward/2`,
    );
    expect(section('Stewards')).toHaveTextContent('Seat 2Empty');
  });

  it('shows a Member the stewards too, with no links', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    renderHome(log.state(), authorOf('kim'));
    expect(section('Stewards')).toHaveTextContent('Ana');
    expect(within(section('Stewards')).queryByRole('link')).toBeNull();
  });
});
