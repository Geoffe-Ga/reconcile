/**
 * Telling affected devices on screen (#491; listed-doors.md §6.5): once the
 * steward suspends a listing, or upholds a report on one of its entries, a
 * device that sent an application or a reconcile card to that door shows
 * one line, with the day it sent it and the clause in words, and Dismiss.
 * A dismissed line stays dismissed across a reload and never shows twice
 * for one tombstone. Nothing shows for another door, while the shelf is
 * paused, or with no shelf.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { signNotice } from '../shelf/notices';
import type { ShelfReader } from '../shelf/read';
import { type NoticeBody, signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { openStore, type Store } from '../store/db';
import { axeViolations } from '../test/axe';
import { freshIndexedDBPerTest } from '../test/idb';
import { STEWARD_ADDRESS, TEST_STEWARD } from '../test/steward';
import { messages } from './messages';
import { ShelfRemovals } from './ShelfRemovals';
import { formatDay } from './time';

freshIndexedDBPerTest();

const DOOR_KEYS = newSigningKeys();
const ADDRESS = base64url(DOOR_KEYS.publicKey);
const OTHER = base64url(newSigningKeys().publicKey);
const ENTRY = base64url(new Uint8Array(32).fill(4));
const RELAY_NOW = 29_000_000;
const NOW = 1_762_650_000_000;
const SENT_AT = NOW - 3 * 86_400_000;
const DAY = formatDay(SENT_AT);

const words = messages.removals;

/** The steward's `notice`, as the relay serves it at `seq`. */
const notice = (body: NoticeBody, seq: number): ShelfRecord => ({
  seq,
  received: RELAY_NOW - 100,
  address: STEWARD_ADDRESS,
  data: signNotice(TEST_STEWARD.signing, body),
});

const RELEASE = notice({ v: 1, kind: 'notice', act: 'release', address: ADDRESS }, 2);
const SUSPEND = notice({ v: 1, kind: 'notice', act: 'suspend', address: ADDRESS, clause: 'C3' }, 5);

/** The door's listing and one entry, the steward's release, and `more`. */
function shelfWith(...more: ShelfRecord[]): ShelfRecord[] {
  const name = 'Oak St Tenants';
  const listing = signShelfBody(DOOR_KEYS, {
    v: 1,
    kind: 'listing',
    open: true,
    name,
    skeleton: nameSkeleton(name),
    covenant: base64url(new Uint8Array(32).fill(9)),
  });
  const entry = signShelfBody(DOOR_KEYS, {
    v: 1,
    kind: 'entry',
    id: ENTRY,
    title: 'Rent strike vote',
    text: 'Thursday.',
  });
  return [
    { seq: 1, received: RELAY_NOW - 3000, address: ADDRESS, data: listing },
    RELEASE,
    { seq: 3, received: RELAY_NOW - 2000, address: ADDRESS, data: entry },
    ...more,
  ];
}

/** A reader that serves `records`, counting each time it's asked. */
function readerOf(records: readonly ShelfRecord[]): ShelfReader & { asked: number } {
  const reader = {
    asked: 0,
    current: () => {
      reader.asked += 1;
      return Promise.resolve({ records, now: RELAY_NOW, since: new Map<string, number>() });
    },
  };
  return reader;
}

const opened: Store[] = [];

/** The device's store, with an application sent to `door` 3 days ago. */
async function storeWithApplication(door = ADDRESS): Promise<Store> {
  const store = await openStore();
  opened.push(store);
  await store.addSent({
    id: 'app-1',
    door,
    groupName: 'Oak St Tenants',
    seed: new Uint8Array(32).fill(1),
    replyKey: new Uint8Array(32).fill(2),
    sentAt: SENT_AT,
  });
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

const now = () => NOW;

describe('ShelfRemovals (#491)', () => {
  it('tells a device that asked to join a suspended group, in words, and passes axe', async () => {
    const store = await storeWithApplication();
    render(
      <main>
        <h1>Start</h1>
        <ShelfRemovals store={store} shelf={readerOf(shelfWith(SUSPEND))} now={now} />
      </main>,
    );

    const card = await screen.findByRole('region', { name: words.heading });
    expect(card.textContent).toContain(
      `A group you asked to join on ${DAY} was removed from the shelf: impersonation of another group or person.`,
    );
    expect(within(card).getByRole('button', { name: 'Dismiss' })).toBeDefined();
    document.title = 'Start';
    expect(await axeViolations()).toEqual([]);
  });

  it('says a reconcile card’s group was removed, and a Dispatch when an entry was upheld', async () => {
    const store = await openStore();
    opened.push(store);
    await store.noteSentCard({ door: ADDRESS, sentAt: SENT_AT });
    const uphold = notice(
      { v: 1, kind: 'notice', act: 'uphold', address: ADDRESS, id: ENTRY, clause: 'C2' },
      4,
    );
    const { unmount } = render(
      <ShelfRemovals store={store} shelf={readerOf(shelfWith(uphold))} now={now} />,
    );
    const card = await screen.findByRole('region', { name: words.heading });
    expect(card.textContent).toContain(words.proposedEntry(DAY, 'spam'));
    unmount();

    render(<ShelfRemovals store={store} shelf={readerOf(shelfWith(SUSPEND))} now={now} />);
    const suspended = await screen.findByRole('region', { name: words.heading });
    expect(suspended.textContent).toContain(
      words.proposed(DAY, 'impersonation of another group or person'),
    );
  });

  it('shows one line for one tombstone, from the earliest thing sent there', async () => {
    const store = await storeWithApplication();
    await store.noteSentCard({ door: ADDRESS, sentAt: SENT_AT + 86_400_000 });
    render(<ShelfRemovals store={store} shelf={readerOf(shelfWith(SUSPEND))} now={now} />);

    const card = await screen.findByRole('region', { name: words.heading });
    expect(within(card).getAllByRole('listitem')).toHaveLength(1);
    expect(card.textContent).toContain(
      words.asked(DAY, 'impersonation of another group or person'),
    );
  });

  it('keeps a dismissed line dismissed across a reload, and never shows it twice', async () => {
    const user = userEvent.setup();
    const store = await storeWithApplication();
    const shelf = readerOf(shelfWith(SUSPEND));
    const first = render(<ShelfRemovals store={store} shelf={shelf} now={now} />);
    const card = await screen.findByRole('region', { name: words.heading });

    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region')).toBeNull();
    first.unmount();
    store.close();

    const reopened = await openStore();
    opened.push(reopened);
    expect((await reopened.removalsAt(NOW)).dismissed).toEqual([ADDRESS]);
    render(<ShelfRemovals store={reopened} shelf={shelf} now={now} />);
    await waitFor(() => {
      expect(shelf.asked).toBe(2);
    });
    // Both reads have answered and the store has too: still nothing.
    await reopened.removalsAt(NOW);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows nothing for another door, while paused, with no tombstone, or with no shelf', async () => {
    const store = await storeWithApplication(OTHER);
    const pause = notice({ v: 1, kind: 'notice', act: 'pause', on: true }, 6);
    const elsewhere = readerOf(shelfWith(SUSPEND));
    const { rerender } = render(<ShelfRemovals store={store} shelf={elsewhere} now={now} />);
    await waitFor(() => {
      expect(elsewhere.asked).toBe(1);
    });
    await store.removalsAt(NOW);
    expect(screen.queryByRole('region')).toBeNull();

    const mine = await storeWithApplication();
    for (const shelf of [readerOf(shelfWith(SUSPEND, pause)), readerOf(shelfWith())]) {
      rerender(<ShelfRemovals store={mine} shelf={shelf} now={now} />);
      await waitFor(() => {
        expect(shelf.asked).toBe(1);
      });
      await mine.removalsAt(NOW);
      expect(screen.queryByRole('region')).toBeNull();
    }
    rerender(<ShelfRemovals store={mine} shelf={undefined} now={now} />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('matches and dismisses without a single request (§6.5: nothing is sent)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    const store = await storeWithApplication();
    const shelf = readerOf(shelfWith(SUSPEND));
    render(<ShelfRemovals store={store} shelf={shelf} now={now} />);
    const card = await screen.findByRole('region', { name: words.heading });
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(async () => {
      expect((await store.removalsAt(NOW)).dismissed).toEqual([ADDRESS]);
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(shelf.asked).toBe(1);
    fetch.mockRestore();
  });
});
