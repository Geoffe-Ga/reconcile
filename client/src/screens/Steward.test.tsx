/** The steward's console (#488; listed-doors.md §6.4). */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { COVENANT_HASH } from '../shelf/covenant';
import type { ShelfListing, WaitingListing } from '../shelf/fold';
import { axeViolations } from '../test/axe';
import { Steward, type StewardQueue } from './Steward';

const words = messages.shelfSteward;

/** A listing under `name`. */
const listingOf = (name: string, address: string, covenant = COVENANT_HASH): ShelfListing => ({
  address,
  name,
  covenant,
  seq: 1,
  received: 29_000_000,
});

const QUEUE: WaitingListing[] = [
  {
    listing: listingOf('EASTSIDE TENANTS UNI0N', 'O'.repeat(43)),
    holder: listingOf('Eastside Tenants Union', 'B'.repeat(43)),
  },
  { listing: listingOf('Elm Co-op', 'E'.repeat(43), 'A'.repeat(43)), holder: null },
];

function setup(queue: StewardQueue, onRelease = vi.fn(() => Promise.resolve(true))) {
  render(<Steward queue={queue} onRelease={onRelease} />);
  return { user: userEvent.setup(), onRelease };
}

describe('Steward', () => {
  it('lists each waiting listing with what readers will see and any look-alike, and passes axe', async () => {
    setup(QUEUE);

    expect(screen.getByRole('heading', { level: 1, name: words.title })).toBeVisible();
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '#/settings');
    const [first, second] = screen.getAllByRole('listitem');
    if (first === undefined || second === undefined) throw new Error('two listings');
    expect(within(first).getByRole('heading', { name: 'EASTSIDE TENANTS UNI0N' })).toBeVisible();
    expect(within(first).getByText(words.covenantCurrent)).toBeVisible();
    expect(within(first).getByText('Eastside Tenants Union')).toBeVisible();
    expect(within(first).getByText(words.lookalikeHint)).toBeVisible();
    expect(within(first).getByText(words.willSee('EASTSIDE TENANTS UNI0N'))).toBeVisible();
    expect(within(second).getByText(words.covenantOther)).toBeVisible();
    expect(within(second).queryByText(words.lookalikeHint)).toBeNull();
    expect(within(second).getByText(/^Waiting since /)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('releases one listing, then says so in its place', async () => {
    const { user, onRelease } = setup(QUEUE);
    const [first] = screen.getAllByRole('listitem');
    if (first === undefined) throw new Error('a listing');

    await user.click(within(first).getByRole('button', { name: words.release }));

    expect(onRelease).toHaveBeenCalledWith('O'.repeat(43));
    expect(await within(first).findByText(words.released)).toBeVisible();
    expect(within(first).queryByRole('button', { name: words.release })).toBeNull();
  });

  it('says a release that didn’t reach the relay failed, and offers it again', async () => {
    const { user } = setup(
      QUEUE,
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const [first] = screen.getAllByRole('listitem');
    if (first === undefined) throw new Error('a listing');

    await user.click(within(first).getByRole('button', { name: words.release }));

    expect(await within(first).findByText(words.releaseFailed)).toBeVisible();
    expect(within(first).getByRole('button', { name: words.release })).toBeEnabled();
  });

  it.each([
    [[], words.none],
    ['unavailable', words.unavailable],
    ['failed', words.readFailed],
  ] as const)('says why the queue is empty: %s', (queue, line) => {
    setup(queue);

    expect(screen.getByText(line)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
