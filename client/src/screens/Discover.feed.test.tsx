/**
 * Discover's feed (#429; ADR-0077 §7, DESIGN.md "Discover" and "Dispatch
 * card"): every Dispatch the device holds, from its groups and coalitions,
 * newest first, each a Dispatch card under an eyebrow naming where it's from
 * and linking there. A dissolved group's say so; a follower of a coalition
 * reads only the coalition's; nothing counts.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { discoverFeed, type FeedPlace } from '../app/discoverFeed';
import { messages } from '../app/messages';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { fold, type GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { Logs, seatKey } from '../test/coalitions';
import { groupLog } from '../test/votes';
import { Discover } from './Discover';

const OPEN = {
  onOpenInvite: vi.fn(),
  onOpenCard: vi.fn(),
  onOpenFollow: vi.fn(),
  onOpenDoor: vi.fn(),
};

/** A group named `name` whose Ana sent one Dispatch at `minute`. */
function group(name: string, minute: number, words: { title: string; text: string }): GroupState {
  const log = groupLog();
  log.minute = minute;
  log.dispatch('Ana', words);
  return { ...log.state(minute + 1), name };
}

/** A place in the feed for `state`, under `id`. */
function placeOf(kind: FeedPlace['kind'], id: string, state: GroupState, ended = false): FeedPlace {
  return { kind, id, state, ended };
}

/**
 * A coalition of Riverside Tenants and Oak St Co-op that passed Riverside's
 * Dispatch as it rose (#126), folded once that pass is final.
 */
function coalitionWithRisen(): GroupState {
  const logs = new Logs();
  const at = logs.formed(29_375_010, ['Riverside Tenants', 'Oak St Co-op'], ['kim', 'zed']);
  const words = { title: 'Rally Saturday', text: 'Meet at the river at ten.\nBring water.' };
  const target = {
    kind: 'promote',
    dispatch: { id: 'riverside-dispatch', ...words },
    ceiling: 'coalitions',
    level: 1,
    from: seatKey('Riverside Tenants'),
  } as const;
  const risen = logs.promoteIn('coalition', at, 'kim', { target, title: words.title, why: '' });
  logs.result(at + 1, 'kim', risen, 'Riverside Tenants', 'pass');
  logs.result(at + 2, 'zed', risen, 'Oak St Co-op', 'pass');
  return fold(logs.logs.coalition ?? [], at + 7 * DAY_MINUTES + RESULT_GRACE_MINUTES);
}

/** Each card on screen, in order: its eyebrow's words and its title. */
function cards() {
  return screen.getAllByRole('article').map((card) => ({
    from: card.querySelector('.dispatch-from')?.textContent,
    title: within(card).getByRole('heading', { level: 2 }).textContent,
  }));
}

describe('Discover’s feed (#429)', () => {
  it('lists Dispatches from several groups and a coalition, newest first, each from where it’s shown', async () => {
    const riverside = group('Riverside Tenants', 1_000, {
      title: 'Meet on Sunday',
      text: 'Bring a chair.\n\n  We start at 10.',
    });
    const oak = group('Oak St Co-op', 2_000, { title: 'Bins on Tuesday', text: '' });
    const coalition = coalitionWithRisen();
    const feed = discoverFeed(
      [placeOf('group', 'riverside', riverside), placeOf('group', 'oak', oak)],
      [placeOf('coalition', 'valley', coalition)],
    );
    render(<Discover feed={feed} {...OPEN} />);

    const list = screen.getByRole('list', { name: messages.discover.feedLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(cards()).toEqual([
      { from: coalition.name, title: 'Rally Saturday' },
      { from: 'Oak St Co-op', title: 'Bins on Tuesday' },
      { from: 'Riverside Tenants', title: 'Meet on Sunday' },
    ]);
    // The eyebrow goes home: the coalition's, or the group's.
    const [risen, , sunday] = screen.getAllByRole('article');
    if (risen === undefined || sunday === undefined) throw new Error('Expected the cards.');
    expect(within(risen).getByRole('link', { name: coalition.name })).toHaveAttribute(
      'href',
      '#/c/valley',
    );
    expect(within(sunday).getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      '#/g/riverside',
    );
    // The risen one names the seat it rose from, and its text stays plain and pre-wrapped.
    expect(risen).toHaveTextContent('From Riverside Tenants');
    expect(within(sunday).getByText(/Bring a chair/).textContent).toBe(
      'Bring a chair.\n\n  We start at 10.',
    );
    // The empty state's sentence goes once there's something to read; the field stays.
    expect(screen.queryByText(messages.discover.empty)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: messages.discover.openHeading })).toBeVisible();
    // No counts and no badges.
    expect(document.querySelector('.badge, .count')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('marks a dissolved group’s Dispatches as from a group that has ended', async () => {
    const ended = group('Allotment Society', 500, { title: 'Last seeds', text: 'Thanks, all.' });
    render(
      <Discover feed={discoverFeed([placeOf('group', 'allot', ended, true)], [])} {...OPEN} />,
    );

    const [card] = screen.getAllByRole('article');
    if (card === undefined) throw new Error('Expected the card.');
    expect(card.querySelector('.dispatch-from')?.textContent).toBe('Allotment Society · Ended');
    expect(within(card).getByRole('link', { name: 'Allotment Society' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a follower of a coalition its Dispatches, and nothing from inside its member groups', async () => {
    const coalition = coalitionWithRisen();
    // A follower holds the coalition's log and none of its member groups' (#124).
    render(
      <Discover feed={discoverFeed([], [placeOf('coalition', 'valley', coalition)])} {...OPEN} />,
    );

    const all = screen.getAllByRole('article');
    expect(all).toHaveLength(1);
    const [card] = all;
    if (card === undefined) throw new Error('Expected the card.');
    expect(card).toHaveTextContent('From Riverside Tenants');
    // Only the coalition's home is a link: the seat it rose from is plain text.
    expect(
      within(card)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['#/c/valley']);
    expect(await axeViolations()).toEqual([]);
  });

  it('says in one sentence what shows here while there’s nothing, beside Open a card or link', async () => {
    render(<Discover feed={[]} {...OPEN} />);

    expect(screen.getByText(messages.discover.empty)).toBeVisible();
    expect(screen.queryByRole('list', { name: messages.discover.feedLabel })).toBeNull();
    expect(screen.getByRole('button', { name: messages.discover.open })).toHaveClass(
      'button-primary',
    );
    expect(await axeViolations()).toEqual([]);
  });
});
