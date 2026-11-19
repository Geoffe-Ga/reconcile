/** The steward's console (#488, #489; listed-doors.md §6.4). */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { COVENANT_HASH } from '../shelf/covenant';
import type { ShelfEntry, ShelfListing, StandingHold, WaitingListing } from '../shelf/fold';
import type { NoticeBody } from '../shelf/record';
import { axeViolations } from '../test/axe';
import { Steward, type StewardQueue, type StewardView } from './Steward';

const words = messages.shelfSteward;
const OAK = 'O'.repeat(43);
const ELM = 'E'.repeat(43);
const ID = 'D'.repeat(43);

/** A listing under `name`. */
const listingOf = (name: string, address: string, covenant = COVENANT_HASH): ShelfListing => ({
  address,
  name,
  covenant,
  seq: 1,
  received: 29_000_000,
});

const WAITING: WaitingListing[] = [
  {
    listing: listingOf('EASTSIDE TENANTS UNI0N', OAK),
    holder: listingOf('Eastside Tenants Union', 'B'.repeat(43)),
  },
  { listing: listingOf('Elm Co-op', ELM, 'A'.repeat(43)), holder: null },
];

const ENTRY: ShelfEntry = {
  address: ELM,
  id: ID,
  title: 'Rent strike vote',
  text: 'Thursday.',
  name: 'Elm Co-op',
  seq: 2,
  received: 29_000_000,
  early: false,
  listedSince: 29_000_000,
};

const HOLD: StandingHold = {
  hold: { address: OAK, id: null, clause: 'C3', seq: 3, until: 29_010_080 },
  name: 'Oak St Tenants',
  title: null,
};

/** A view with `waiting`, and nothing else unless given. */
const viewOf = (fields: Partial<StewardView> = {}): StewardView => ({
  waiting: [],
  listings: [],
  entries: [],
  holds: [],
  paused: false,
  ...fields,
});

function setup(
  queue: StewardQueue,
  onNotice = vi.fn<(notice: NoticeBody) => Promise<boolean>>(() => Promise.resolve(true)),
) {
  render(<Steward queue={queue} onNotice={onNotice} />);
  return { user: userEvent.setup(), onNotice };
}

/** The section headed `title`. */
const section = (title: string) => screen.getByRole('region', { name: title });

describe('Steward: waiting listings (#488)', () => {
  it('lists each waiting listing with what readers will see and any look-alike, and passes axe', async () => {
    setup(viewOf({ waiting: WAITING }));

    expect(screen.getByRole('heading', { level: 1, name: words.title })).toBeVisible();
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '#/settings');
    const [first, second] = within(section(words.waitingHeading)).getAllByRole('listitem');
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
    const { user, onNotice } = setup(viewOf({ waiting: WAITING }));
    const [first] = within(section(words.waitingHeading)).getAllByRole('listitem');
    if (first === undefined) throw new Error('a listing');

    await user.click(within(first).getByRole('button', { name: words.release }));

    expect(onNotice).toHaveBeenCalledWith({ v: 1, kind: 'notice', act: 'release', address: OAK });
    expect(await within(first).findByText(words.released)).toBeVisible();
    expect(within(first).queryByRole('button', { name: words.release })).toBeNull();
  });

  it('says a release that didn’t reach the relay failed, and offers it again', async () => {
    const { user } = setup(
      viewOf({ waiting: WAITING }),
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const [first] = within(section(words.waitingHeading)).getAllByRole('listitem');
    if (first === undefined) throw new Error('a listing');

    await user.click(within(first).getByRole('button', { name: words.release }));

    expect(await within(first).findByText(words.releaseFailed)).toBeVisible();
    expect(within(first).getByRole('button', { name: words.release })).toBeEnabled();
  });

  it.each([
    ['unavailable', words.unavailable],
    ['failed', words.readFailed],
  ] as const)('says why it shows nothing: %s', (queue, line) => {
    setup(queue);

    expect(screen.getByText(line)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says nothing waits, nothing is held and nothing is on the shelf', () => {
    setup(viewOf());

    expect(screen.getByText(words.none)).toBeVisible();
    expect(screen.getByText(words.noHolds)).toBeVisible();
    expect(screen.getByText(words.emptyShelf)).toBeVisible();
  });
});

describe('Steward: hold, uphold, suspend and pause (#489)', () => {
  it('offers Hold and Suspend on a listing and Hold and Uphold on an entry, each saying what readers will see, and passes axe', async () => {
    setup(viewOf({ listings: [listingOf('Elm Co-op', ELM)], entries: [ENTRY] }));

    const shelf = section(words.shelfHeading);
    expect(within(shelf).getByRole('heading', { name: 'Elm Co-op' })).toBeVisible();
    expect(within(shelf).getByRole('heading', { name: 'Rent strike vote' })).toBeVisible();
    const clause = 'a call for violence, or speech that denies a group’s humanity';
    expect(within(shelf).getByText(words.willSeeHoldListing(clause))).toBeVisible();
    expect(within(shelf).getByText(words.willSeeSuspend(clause))).toBeVisible();
    expect(within(shelf).getByText(words.willSeeHoldEntry(clause))).toBeVisible();
    expect(within(shelf).getByText(words.willSeeUphold(clause))).toBeVisible();
    expect(words.willSeeUphold('spam')).toBe(
      'Uphold: readers will see “Removed: spam” in its place until its 30 days end.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('holds an entry under the clause chosen, and the line follows the choice', async () => {
    const { user, onNotice } = setup(
      viewOf({ listings: [listingOf('Elm Co-op', ELM)], entries: [ENTRY] }),
    );
    const shelf = section(words.shelfHeading);
    const [, entryItem] = within(shelf).getAllByRole('listitem');
    if (entryItem === undefined) throw new Error('an entry');

    await user.click(within(entryItem).getByRole('radio', { name: /^C2: spam$/ }));
    expect(within(entryItem).getByText(words.willSeeHoldEntry('spam'))).toBeVisible();
    await user.click(within(entryItem).getByRole('button', { name: words.hold }));

    expect(onNotice).toHaveBeenCalledWith({
      v: 1,
      kind: 'notice',
      act: 'hold',
      address: ELM,
      id: ID,
      clause: 'C2',
    });
    expect(await within(entryItem).findByText(words.sent)).toBeVisible();
  });

  it('suspends a listing and upholds an entry, each as one notice', async () => {
    const { user, onNotice } = setup(
      viewOf({ listings: [listingOf('Elm Co-op', ELM)], entries: [ENTRY] }),
    );
    const shelf = section(words.shelfHeading);
    const [, entryItem] = within(shelf).getAllByRole('listitem');
    if (entryItem === undefined) throw new Error('an entry');

    await user.click(within(entryItem).getByRole('button', { name: words.uphold }));
    const [suspend] = within(shelf).getAllByRole('button', { name: words.suspend });
    if (suspend === undefined) throw new Error('Suspend');
    await user.click(suspend);

    expect(onNotice.mock.calls.map(([notice]) => notice)).toEqual([
      { v: 1, kind: 'notice', act: 'uphold', address: ELM, id: ID, clause: 'C1' },
      { v: 1, kind: 'notice', act: 'suspend', address: ELM, clause: 'C1' },
    ]);
  });

  it('lists a standing hold, its clause and when it lapses, with Suspend under its clause, and passes axe', async () => {
    const entryHold: StandingHold = {
      hold: { address: ELM, id: ID, clause: 'C2', seq: 4, until: 29_010_080 },
      name: null,
      title: 'Rent strike vote',
    };
    const unread: StandingHold = { ...entryHold, title: null };
    const { user, onNotice } = setup(viewOf({ holds: [HOLD, entryHold, unread] }));

    const holds = section(words.holdsHeading);
    const [listing, entry, other] = within(holds).getAllByRole('listitem');
    if (listing === undefined || entry === undefined || other === undefined) throw new Error('3');
    expect(within(listing).getByRole('heading')).toHaveTextContent(
      words.heldListing('Oak St Tenants'),
    );
    expect(
      within(listing).getByText(/^Held: impersonation of another group or person\./),
    ).toBeVisible();
    expect(within(entry).getByRole('heading')).toHaveTextContent(
      words.heldEntry('Rent strike vote'),
    );
    expect(within(other).getByRole('heading')).toHaveTextContent(words.heldUnknown);
    expect(within(listing).queryByRole('button', { name: words.hold })).toBeNull();
    expect(within(entry).getByRole('button', { name: words.uphold })).toBeVisible();
    await user.click(within(listing).getByRole('button', { name: words.suspend }));

    expect(onNotice).toHaveBeenCalledWith({
      v: 1,
      kind: 'notice',
      act: 'suspend',
      address: OAK,
      clause: 'C3',
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('pauses the shelf, saying readers will see the paused line, and lifts a pause', async () => {
    const { user, onNotice } = setup(viewOf());
    const pause = section(words.pauseHeading);
    expect(within(pause).getByText(words.showingNow)).toBeVisible();
    expect(within(pause).getByText(words.willSeePause(messages.discover.paused))).toBeVisible();

    await user.click(within(pause).getByRole('button', { name: words.pause }));
    expect(onNotice).toHaveBeenCalledWith({ v: 1, kind: 'notice', act: 'pause', on: true });
  });

  it('lifts a pause that stands', async () => {
    const { user, onNotice } = setup(viewOf({ paused: true }));
    const pause = section(words.pauseHeading);
    expect(within(pause).getByText(words.pausedNow)).toBeVisible();
    expect(within(pause).getByText(words.willSeeResume)).toBeVisible();

    await user.click(within(pause).getByRole('button', { name: words.resume }));
    expect(onNotice).toHaveBeenCalledWith({ v: 1, kind: 'notice', act: 'pause', on: false });
  });
});
