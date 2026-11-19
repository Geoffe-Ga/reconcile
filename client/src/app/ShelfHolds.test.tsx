/**
 * Group home's word about a steward's hold (#489; listed-doors.md §6.1): the
 * group's own members see "Held: {clause in words}" while a hold on their
 * listed door, or on one of its entries, stands, with the day it lapses.
 * Nothing shows once it lapses, for another door's hold, for a group that
 * isn't listed, or with no shelf.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf } from '../crypto/door';
import { shelfLineId } from '../engine/dispatches';
import type { ShelfRecord } from '../net/shelf';
import { signNotice } from '../shelf/notices';
import type { ShelfReader } from '../shelf/read';
import type { NoticeBody } from '../shelf/record';
import { axeViolations } from '../test/axe';
import { DOOR, LISTED } from '../test/door';
import { STEWARD_ADDRESS, TEST_STEWARD } from '../test/steward';
import { groupLog, type LogBuilder } from '../test/votes';
import { formatDate } from './time';
import { ShelfHolds } from './ShelfHolds';

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
function served(notices: readonly NoticeBody[], received = NOW - 100): ShelfRecord[] {
  return notices.map((body, i) => ({
    seq: i + 1,
    received,
    address: STEWARD_ADDRESS,
    data: signNotice(TEST_STEWARD.signing, body),
  }));
}

/** A reader that serves `records` at relay minute `now`. */
const readerOf = (records: readonly ShelfRecord[], now = NOW): ShelfReader => ({
  current: () => Promise.resolve({ records, now, since: new Map() }),
});

const HOLD: NoticeBody = { v: 1, kind: 'notice', act: 'hold', address: ADDRESS, clause: 'C2' };

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
    const hold: NoticeBody = { ...HOLD, id, clause: 'C3' };

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
    const other: NoticeBody = { ...HOLD, address: base64url(new Uint8Array(32).fill(1)) };
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
