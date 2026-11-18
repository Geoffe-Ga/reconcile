/**
 * A shelf entry's own page (#431, #432; listed-doors.md §5.2): Ask to join
 * opens the listing's front door, and Propose reconciling does too, only on
 * a device with a group that may propose reconciling with it (#426's rule).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import type { ShelfEntry as Entry } from '../shelf/fold';
import { axeViolations } from '../test/axe';
import { ShelfEntry } from './ShelfEntry';

const ADDRESS = 'A'.repeat(43);
const ENTRY: Entry = {
  address: ADDRESS,
  id: 'B'.repeat(43),
  title: 'Rent strike vote',
  text: 'Thursday.',
  name: 'Oak St Tenants',
  seq: 2,
  received: 29_000_000,
  early: false,
  listedSince: 29_000_000,
};

const words = messages.shelfEntry;

/** The page for `entry`, with or without a group that may propose reconciling. */
function setup(entry: Entry | null, mayReconcile: boolean) {
  render(
    <ShelfEntry
      entry={entry}
      link={`https://app.test/#/discover/${ADDRESS}/${ENTRY.id}`}
      copyText={() => Promise.resolve()}
      mayReconcile={mayReconcile}
    />,
  );
}

describe('ShelfEntry: Ask to join and Propose reconciling (#432)', () => {
  it('offers Ask to join, which opens the listing’s door, and passes axe', async () => {
    setup(ENTRY, false);
    expect(screen.getByRole('link', { name: words.askToJoin })).toHaveAttribute(
      'href',
      `#door/${ADDRESS}`,
    );
    expect(screen.queryByRole('link', { name: words.proposeReconciling })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Propose reconciling, to the same door, to a device with a group that may', async () => {
    setup(ENTRY, true);
    expect(screen.getByRole('link', { name: words.proposeReconciling })).toHaveAttribute(
      'href',
      `#door/${ADDRESS}`,
    );
    expect(screen.getByRole('link', { name: words.askToJoin })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers neither while the shelf doesn’t show the entry', () => {
    setup(null, true);
    expect(screen.queryByRole('link', { name: words.askToJoin })).toBeNull();
    expect(screen.queryByRole('link', { name: words.proposeReconciling })).toBeNull();
  });
});
