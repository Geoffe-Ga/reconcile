/**
 * Discover (#423; ADR-0077 §6, DESIGN.md "Discover"): the eyebrow and
 * heading, the empty state's one sentence, and one line pointing to the
 * link bar, where a card or link opens (#444). It has no field of its own.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ShelfEntry, ShelfState } from '../shelf/fold';
import { axeViolations } from '../test/axe';
import { Discover } from './Discover';

/** 2026-11-16 14:05 UTC, in relay minutes. */
const NOV = Date.UTC(2026, 10, 16, 14, 5) / 60_000;

/** An entry on the shelf, as the fold shows it. */
const entry = (over: Partial<ShelfEntry> = {}): ShelfEntry => ({
  address: 'A'.repeat(43),
  id: 'd'.repeat(43),
  title: 'Rent strike vote',
  text: 'Thursday at the hall.',
  name: 'Oak St Tenants',
  seq: 2,
  received: NOV,
  early: false,
  listedSince: NOV - 60 * 24 * 40,
  ...over,
});

/** A shelf holding `entries`. */
const shelfOf = (...entries: ShelfEntry[]): ShelfState => ({
  listings: [],
  entries,
  withdrawn: [],
  tombstones: [],
  holds: [],
  paused: false,
});

describe('Discover', () => {
  it('with no Dispatch, shows the eyebrow, the heading, the empty state’s sentence and where a card or link opens', async () => {
    render(<Discover feed={[]} />);

    expect(screen.getByText('Reconcile', { selector: '.eyebrow' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Discover' })).toHaveFocus();
    expect(document.title).toBe('Discover · Reconcile');
    expect(
      screen.getByText(
        'Dispatches from your groups, and from the coalitions you’re in or follow, show up here.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('To open a card or link, paste it into the bar at the top.'),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows each shelf entry with its listing’s name, Listed since, and a link to its own page (#431)', async () => {
    render(<Discover feed={[]} shelf={shelfOf(entry())} />);

    const section = screen.getByRole('region', { name: 'On the public shelf' });
    expect(section.querySelector('.dispatch-from > bdi')).toHaveTextContent('Oak St Tenants');
    expect(screen.getByRole('heading', { level: 3, name: 'Rent strike vote' })).toBeVisible();
    expect(screen.getByText('Thursday at the hall.')).toBeVisible();
    expect(screen.getByText('Listed since October 2026')).toBeVisible();
    expect(screen.queryByText('Shows publicly tomorrow')).toBeNull();
    expect(screen.getByRole('link', { name: 'Share or copy its link' })).toHaveAttribute(
      'href',
      `#/discover/${'A'.repeat(43)}/${'d'.repeat(43)}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('marks an entry its own group sees before the day’s wait ends (#431)', async () => {
    render(<Discover feed={[]} shelf={shelfOf(entry({ early: true }))} />);

    expect(screen.getByText('Shows publicly tomorrow')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no shelf section while the shelf shows no entry', () => {
    render(<Discover feed={[]} shelf={shelfOf()} />);

    expect(screen.queryByRole('region', { name: 'On the public shelf' })).toBeNull();
  });
});
