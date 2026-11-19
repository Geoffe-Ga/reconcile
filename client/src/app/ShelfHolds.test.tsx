/**
 * Group home's word about a steward's hold (#489; listed-doors.md §6.1): the
 * group's own members see "Held: {clause in words}" while a hold on their
 * listed door, or on one of its entries, stands, with the day it lapses.
 * Nothing shows once it lapses, for another door's hold, for a group that
 * isn't listed, or with no shelf.
 *
 * A removed listing shows "Removed: {clause in words}" (#490), and while a
 * hold stands or the listing is removed, a member who may propose can ask
 * the steward to look again (§6.3): about the held entry, or about the whole
 * listing.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LEVELS } from '../engine/capabilities';
import { describe, expect, it, vi } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf } from '../crypto/door';
import { shelfLineId } from '../engine/dispatches';
import type { ShelfRecord } from '../net/shelf';
import { signNotice } from '../shelf/notices';
import type { ShelfReader } from '../shelf/read';
import type { NoticeDraft } from '../shelf/record';
import { axeViolations } from '../test/axe';
import { DOOR, LISTED } from '../test/door';
import { authorOf } from '../test/keys';
import { STEWARD_ADDRESS, stampAt, TEST_STEWARD } from '../test/steward';
import { groupLog, type LogBuilder } from '../test/votes';
import { formatDate } from './time';
import { messages } from './messages';
import { ShelfHolds } from './ShelfHolds';

/** The level that votes but doesn't propose. */
const [, VOTING] = LEVELS;

const KEYS = doorKeysOf(fromBase64url(LISTED.sign), fromBase64url(LISTED.box)).signing;
const ADDRESS = base64url(KEYS.publicKey);
const NOW = 29_000_000;

/** Ana, Ben and Cal, whose front door everyone votes to `door`. */
function opened(door: unknown = LISTED): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposal = log.rules('Ana', 'frontDoor', door, { title: 'The front door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
  return log;
}

/** A Dispatch titled `title` the group publishes with a shelf line everyone scores 4. */
function publish(log: LogBuilder, title: string): string {
  const id = log.rising('Ana', 0, { title, text: '' }, undefined, true);
  for (const name of ['Ana', 'Ben', 'Cal']) {
    log.ballot(name, id, { [id]: 4, [shelfLineId(id)]: 4 });
  }
  log.minute += 1;
  return id;
}

/** The steward's `notices`, as the relay serves them, each arriving at `received`. */
function served(notices: readonly NoticeDraft[], received = NOW - 100): ShelfRecord[] {
  return notices.map((body, i) => ({
    seq: i + 1,
    received,
    address: STEWARD_ADDRESS,
    data: signNotice(TEST_STEWARD.signing, body, stampAt(received)),
  }));
}

/** A reader that serves `records` at relay minute `now`. */
const readerOf = (records: readonly ShelfRecord[], now = NOW): ShelfReader => ({
  current: () => Promise.resolve({ records, now, since: new Map() }),
});

const HOLD: NoticeDraft = { v: 1, kind: 'notice', act: 'hold', address: ADDRESS, clause: 'C2' };

describe('ShelfHolds', () => {
  it('shows a hold on the group’s listing, its clause in words and when it lapses, and passes axe', async () => {
    render(
      <main>
        <h1>Riverside Tenants</h1>
        <ShelfHolds state={opened().state()} shelf={readerOf(served([HOLD]))} />
      </main>,
    );

    const card = await screen.findByRole('region', { name: 'Held off the public shelf' });
    expect(card.textContent).toContain('Held: spam');
    expect(card.textContent).toContain('Your group’s listing and everything it published.');
    expect(card.textContent).toContain(
      `Reconcile’s steward is looking at this. Unless they remove it, it shows again on ${formatDate(NOW - 100 + 10_080)}.`,
    );
    // Alone, the card has no page around it to title.
    document.title = 'Riverside Tenants';
    expect(await axeViolations()).toEqual([]);
  });

  it('names a held entry by its Dispatch’s title, in <bdi>', async () => {
    const log = opened();
    const id = publish(log, 'Rally Saturday');
    const hold: NoticeDraft = { ...HOLD, id, clause: 'C3' };

    render(<ShelfHolds state={log.state()} shelf={readerOf(served([hold]))} />);

    const card = await screen.findByRole('region', { name: 'Held off the public shelf' });
    expect(card.textContent).toContain('Held: impersonation of another group or person');
    expect(card.querySelector('bdi')?.textContent).toBe('Rally Saturday');
  });

  it('shows nothing once the hold lapses at 10,080 relay minutes', async () => {
    const reader = readerOf(served([HOLD], NOW - 10_080));
    render(<ShelfHolds state={opened().state()} shelf={reader} />);

    await expect(reader.current()).resolves.not.toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows nothing for another door’s hold, an unlisted group, or no shelf', async () => {
    const other: NoticeDraft = { ...HOLD, address: base64url(new Uint8Array(32).fill(1)) };
    const { rerender } = render(
      <ShelfHolds state={opened().state()} shelf={readerOf(served([other]))} />,
    );
    await Promise.resolve();
    expect(screen.queryByRole('region')).toBeNull();

    rerender(<ShelfHolds state={opened(DOOR).state()} shelf={readerOf(served([HOLD]))} />);
    await Promise.resolve();
    expect(screen.queryByRole('region')).toBeNull();

    rerender(<ShelfHolds state={opened().state()} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('ShelfHolds: Ask the steward to look again (#490)', () => {
  const words = messages.shelfEntry;
  const SUSPEND: NoticeDraft = {
    v: 1,
    kind: 'notice',
    act: 'suspend',
    address: ADDRESS,
    clause: 'C3',
  };

  it('lets a member who may propose appeal a held entry, naming it, and passes axe', async () => {
    const user = userEvent.setup();
    const log = opened();
    const id = publish(log, 'Rally Saturday');
    const onAppeal = vi.fn(() => Promise.resolve('sent' as const));
    render(
      <main>
        <h1>Riverside Tenants</h1>
        <ShelfHolds
          state={log.state()}
          shelf={readerOf(served([{ ...HOLD, id }]))}
          me={authorOf('ana')}
          onAppeal={onAppeal}
        />
      </main>,
    );

    const card = await screen.findByRole('region', { name: words.heldHeading });
    await user.click(within(card).getByRole('button', { name: words.appeal }));
    const dialog = await screen.findByRole('dialog', { name: words.appealTitle });
    document.title = 'Riverside Tenants';
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: words.send }));
    expect(onAppeal).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('textbox', { name: words.appealLabel }));
    await user.paste('It was our own rally.');
    await user.click(within(dialog).getByRole('button', { name: words.send }));

    expect(await within(card).findByText(words.appealSent)).toBeVisible();
    expect(onAppeal).toHaveBeenCalledWith(id, 'It was our own rally.');
  });

  it('shows a removed listing’s clause, and an appeal about the whole listing', async () => {
    const user = userEvent.setup();
    const onAppeal = vi.fn(() => Promise.resolve('sent' as const));
    render(
      <ShelfHolds
        state={opened().state()}
        shelf={readerOf(served([SUSPEND]))}
        me={authorOf('ana')}
        onAppeal={onAppeal}
      />,
    );

    const card = await screen.findByRole('region', { name: words.removedHeading });
    expect(card.textContent).toContain('Removed: impersonation of another group or person');
    expect(card.textContent).toContain(words.removedListing);
    await user.click(within(card).getByRole('button', { name: words.appeal }));
    const dialog = await screen.findByRole('dialog', { name: words.appealTitle });
    await user.click(within(dialog).getByRole('textbox', { name: words.appealLabel }));
    await user.paste('We are the union.');
    await user.click(within(dialog).getByRole('button', { name: words.send }));

    await within(card).findByText(words.appealSent);
    expect(onAppeal).toHaveBeenCalledWith(null, 'We are the union.');
  });

  it('offers no appeal to a member who can’t propose, or without a steward to send to', async () => {
    const log = opened();
    log.level('Ben', VOTING);
    const { rerender } = render(
      <ShelfHolds
        state={log.state()}
        shelf={readerOf(served([HOLD]))}
        me={authorOf('ben')}
        onAppeal={() => Promise.resolve('sent')}
      />,
    );
    await screen.findByRole('region', { name: words.heldHeading });
    expect(screen.queryByRole('button', { name: words.appeal })).toBeNull();

    rerender(
      <ShelfHolds state={log.state()} shelf={readerOf(served([HOLD]))} me={authorOf('ana')} />,
    );
    await screen.findByRole('region', { name: words.heldHeading });
    expect(screen.queryByRole('button', { name: words.appeal })).toBeNull();
  });
});
