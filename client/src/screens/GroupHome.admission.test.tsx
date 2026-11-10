/**
 * Group home as newcomers earn a vote (#101; ADR-0014, ADR-0021): their
 * progress and vouchers on People, Vouch for <name> and its dialog, and the
 * newcomer's own lines, all from state the engine folds.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatDay } from '../app/format';
import { MINUTE_MS, formatMinute } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import { createEvent, type ParsedEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const [FOLLOWING] = LEVELS;
const KIM = authorOf('kim');
const CHAT = 'https://chat.example.org/riverside';

/** When the newcomers' wait ends: they join at START_MINUTE. */
const WAIT_END = START_MINUTE + DEFAULT_RULES.waitDays * DAY_MINUTES;

type OnVouch = GroupHomeProps['onVouch'];

/**
 * Ana (founder), Ben (Co-Creator) and Cal (a Member) hold rights; Kim and Dee
 * join at START_MINUTE as newcomers, and `vouchers` vouch for Kim.
 */
function newcomers(vouchers: readonly string[] = []) {
  const log = groupLog({
    members: ['Ben', 'Cal'],
    levels: { Cal: FOLLOWING },
    newcomers: ['Kim', 'Dee'],
    chat: CHAT,
  });
  for (const voucher of vouchers) log.vouch(voucher, 'Kim');
  return log;
}

function renderHome(state: GroupState, me: string, props: Partial<GroupHomeProps> = {}) {
  const onVouch = vi.fn<OnVouch>(() => Promise.resolve());
  const all: GroupHomeProps = {
    state,
    me,
    makeInviteLink: () => Promise.resolve(`https://reconcile.example/#join/${'s'.repeat(43)}`),
    copyText: () => Promise.resolve(),
    now: state.at,
    sync: {
      reachable: true,
      lastSyncAt: state.at * MINUTE_MS,
      deviceNow: state.at * MINUTE_MS,
      missingHistory: false,
    },
    pending: [],
    onChooseLevel: () => Promise.resolve(),
    onSuspend: () => Promise.resolve(),
    onVouch,
    onLeave: () => Promise.resolve(),
    ...props,
  };
  const view = render(<GroupHome {...all} />);
  const rerender = (next: Partial<GroupHomeProps>) => {
    view.rerender(<GroupHome {...all} {...next} />);
  };
  return { user: userEvent.setup(), onVouch: props.onVouch ?? onVouch, rerender };
}

/** The People list's row for the person named. */
function row(name: string): HTMLElement {
  const people = within(screen.getByRole('region', { name: 'People' })).getAllByRole('listitem');
  const found = people.find((item) => item.querySelector('.person-name')?.textContent === name);
  if (found === undefined) throw new Error(`Expected a row for ${name}.`);
  return found;
}

/** A `vouch` event as `useGroup` lists it while it waits in the outbox. */
function pendingVouch(author: string, member: string): ParsedEvent {
  const input = { type: 'vouch', group: 'g', author, ts: 0, body: { member } } as const;
  const parsed = parseEvent(createEvent(input).bytes);
  if (parsed === null) throw new Error('Expected an event.');
  return parsed;
}

describe('GroupHome: newcomers on People (#101)', () => {
  it('shows each newcomer’s progress and who vouched for them, and nothing for anyone with a vote', async () => {
    renderHome(newcomers(['Ana']).state(), authorOf('ana'));
    expect(row('Kim')).toHaveTextContent(`New · 1 of 2 vouches · wait ends ${formatDay(WAIT_END)}`);
    expect(within(row('Kim')).getByText('Vouched for by', { exact: false })).toHaveTextContent(
      'Vouched for by Ana',
    );
    expect(row('Dee')).toHaveTextContent(`New · 0 of 2 vouches · wait ends ${formatDay(WAIT_END)}`);
    expect(row('Dee')).not.toHaveTextContent('Vouched for by');
    for (const name of ['Ana', 'Ben', 'Cal']) expect(row(name)).not.toHaveTextContent('New ·');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Vouch beside each newcomer to a member who may vouch and hasn’t', () => {
    const state = newcomers(['Ana']).state();
    renderHome(state, authorOf('ana'));
    expect(within(row('Dee')).getByRole('button', { name: 'Vouch for Dee' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Vouch for Kim' })).toBeNull();
    for (const name of ['Ana', 'Ben', 'Cal']) {
      expect(screen.queryByRole('button', { name: `Vouch for ${name}` })).toBeNull();
    }
  });

  it.each(['Cal', 'Kim', 'Dee'])('offers %s, who may not vouch yet, no Vouch at all', (name) => {
    renderHome(newcomers().state(), authorOf(name.toLowerCase()));
    expect(screen.queryByRole('button', { name: /^Vouch for/ })).toBeNull();
  });

  it('queues one vouch for the newcomer from the dialog, which links the group’s chat', async () => {
    const { user, onVouch } = renderHome(newcomers(['Ana']).state(), authorOf('ben'));
    await user.click(within(row('Kim')).getByRole('button', { name: 'Vouch for Kim' }));
    const dialog = screen.getByRole('dialog', { name: 'Vouch for Kim?' });
    expect(within(dialog).getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      CHAT,
    );
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Vouch' }));
    expect(onVouch).toHaveBeenCalledTimes(1);
    expect(onVouch).toHaveBeenCalledWith(KIM);
  });

  it('shows the vouch waiting to send, then the progress the fold gives, with no button for the voucher', () => {
    const before = newcomers(['Ana']);
    const { rerender } = renderHome(before.state(), authorOf('ben'), {
      pending: [pendingVouch(authorOf('ben'), KIM)],
    });
    expect(within(row('Kim')).queryByRole('button', { name: 'Vouch for Kim' })).toBeNull();
    expect(within(row('Kim')).getByRole('status')).toHaveTextContent('Sending…');
    rerender({ state: newcomers(['Ana', 'Ben']).state(), pending: [] });
    expect(row('Kim')).toHaveTextContent(
      `New · 2 of 2 vouches · can vote from ${formatDay(WAIT_END)}`,
    );
    expect(row('Kim')).toHaveTextContent('Vouched for by Ana and Ben');
    expect(within(row('Kim')).queryByRole('button', { name: 'Vouch for Kim' })).toBeNull();
    expect(within(row('Dee')).getByRole('button', { name: 'Vouch for Dee' })).toBeVisible();
  });

  it('asks nobody for a vouch once the newcomer has every one they need', () => {
    renderHome(newcomers(['Ana', 'Ben']).state(), authorOf('ana'));
    expect(screen.queryByRole('button', { name: 'Vouch for Kim' })).toBeNull();
  });

  it('drops the progress once a newcomer’s rights arrive', () => {
    renderHome(newcomers(['Ana', 'Ben']).state(WAIT_END), authorOf('ana'));
    expect(row('Kim')).not.toHaveTextContent('New ·');
    expect(row('Kim')).not.toHaveTextContent('Vouched for by');
  });

  it('offers no Vouch while this member’s leave waits for the relay (#77)', () => {
    renderHome(newcomers().state(), authorOf('ana'), { leaving: true });
    expect(screen.queryByRole('button', { name: /^Vouch for/ })).toBeNull();
  });
});

describe('GroupHome: the newcomer’s own lines (#101)', () => {
  it('tells a newcomer when they can vote, and that every level reads until then', async () => {
    renderHome(newcomers().state(), KIM);
    expect(
      screen.getByText(
        `You can vote on Proposals that open after ${formatMinute(WAIT_END)}, once 2 people vouch for you.`,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Voting and proposing start once you have a vote. Until then, you read and follow.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('gives the date alone once they’re vouched for', () => {
    renderHome(newcomers(['Ana', 'Ben']).state(), KIM);
    expect(
      screen.getByText(`You can vote on Proposals that open after ${formatMinute(WAIT_END)}.`),
    ).toBeVisible();
  });

  it('says none of it to someone who holds rights, or while the newcomer’s leave waits', () => {
    renderHome(newcomers().state(), authorOf('ben'));
    expect(screen.queryByText(/^You can vote on Proposals/)).toBeNull();
    expect(screen.queryByText(/^Voting and proposing start/)).toBeNull();
    renderHome(newcomers().state(), KIM, { leaving: true });
    expect(screen.queryByText(/^You can vote on Proposals/)).toBeNull();
  });
});
