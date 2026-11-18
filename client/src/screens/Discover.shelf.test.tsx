/**
 * Discover's public shelf section (#484; docs/spec/listed-doors.md §5.2): the
 * entries the shelf's fold shows, below the device's own feed, each under
 * its listing's name in `<bdi>`. With no shelf, as on a relay without the
 * steward's key, nothing of it shows.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ShelfEntry, ShelfState } from '../shelf/fold';
import { axeViolations } from '../test/axe';
import { Discover } from './Discover';

const ADDRESS = 'A'.repeat(43);

/** An entry under `name`. */
function entry(id: string, name: string, title: string, text: string): ShelfEntry {
  return { address: ADDRESS, id, name, title, text, seq: 1, received: 1 };
}

/** A shelf showing `entries`. */
function shelfOf(entries: readonly ShelfEntry[]): ShelfState {
  return { listings: [], entries, tombstones: [], paused: false };
}

const SHELF = shelfOf([
  entry('d2', 'سكان شارع البلوط', 'Garden day', 'Saturday, by the gate.'),
  entry('d1', 'Oak St Tenants', 'Rent strike vote', 'We vote Thursday.\nCome early.'),
]);

describe('Discover’s public shelf', () => {
  it('lists each entry below the feed, its listing’s name in <bdi>, its title and text', async () => {
    render(<Discover feed={[]} shelf={SHELF} />);

    const section = screen.getByRole('region', { name: 'On the public shelf' });
    expect(
      within(section).getByText(
        'Groups that chose to be listed publish these by vote. Anyone with the app can read them.',
      ),
    ).toBeVisible();
    const list = within(section).getByRole('list', { name: 'On the public shelf' });
    const cards = within(list).getAllByRole('article');
    expect(
      cards.map((card) => ({
        name: card.querySelector('.dispatch-from > bdi')?.textContent,
        title: within(card).getByRole('heading', { level: 3 }).textContent,
        text: card.querySelector('.dispatch-text')?.textContent,
      })),
    ).toEqual([
      { name: 'سكان شارع البلوط', title: 'Garden day', text: 'Saturday, by the gate.' },
      { name: 'Oak St Tenants', title: 'Rent strike vote', text: 'We vote Thursday.\nCome early.' },
    ]);
    expect(
      screen.getByText(
        'Dispatches from your groups, and from the coalitions you’re in or follow, show up here.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('gives its section a heading and one body, the two columns `.section` lays out', () => {
    render(<Discover feed={[]} shelf={SHELF} />);

    const section = screen.getByRole('region', { name: 'On the public shelf' });
    const [heading, body, ...rest] = [...section.children];
    expect(heading?.tagName).toBe('H2');
    // The lede and the entries share one column, so the entries never squeeze into the heading's.
    expect(body?.querySelector('ul')).not.toBeNull();
    expect(rest).toEqual([]);
  });

  it('shows nothing of the shelf without one, as on a relay without the steward’s key', () => {
    render(<Discover feed={[]} shelf={null} />);

    expect(screen.queryByRole('region', { name: 'On the public shelf' })).toBeNull();
    expect(screen.queryByText('On the public shelf')).toBeNull();
  });

  it('shows nothing of the shelf while it holds no entry', () => {
    render(<Discover feed={[]} shelf={shelfOf([])} />);

    expect(screen.queryByText('On the public shelf')).toBeNull();
  });

  it('shows nothing of the shelf when none is given', () => {
    render(<Discover feed={[]} />);

    expect(screen.queryByText('On the public shelf')).toBeNull();
  });
});
