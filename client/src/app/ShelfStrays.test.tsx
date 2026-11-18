/**
 * Group home's word about a stray entry (#431; listed-doors.md §4.5): an
 * entry under the group's listed door that its log never published, which a
 * member's device withdrew, named by its title. Nothing shows for an entry
 * the group published, another door's, or a group that isn't listed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf } from '../crypto/door';
import { shelfLineId } from '../engine/dispatches';
import type { ShelfRecord } from '../net/shelf';
import type { ShelfReader } from '../shelf/read';
import { type ShelfBody, signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { axeViolations } from '../test/axe';
import { COVENANT_HASH, DOOR, LISTED, secretOf } from '../test/door';
import { groupLog, type LogBuilder } from '../test/votes';
import { messages } from './messages';
import { straysOf } from '../shelf/keeper';
import { ShelfStrays } from './ShelfStrays';

const KEYS = doorKeysOf(fromBase64url(LISTED.sign), fromBase64url(LISTED.box)).signing;
const ADDRESS = base64url(KEYS.publicKey);

/** Ana, Ben and Cal, whose front door everyone votes to `door`. */
function opened(door: unknown = LISTED): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposal = log.rules('Ana', 'frontDoor', door, { title: 'The front door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
  return log;
}

/** A Dispatch the group publishes with a shelf line everyone scores 4. */
function publish(log: LogBuilder): string {
  const id = log.rising('Ana', 0, { title: 'Rally Saturday', text: '' }, undefined, true);
  for (const name of ['Ana', 'Ben', 'Cal']) {
    log.ballot(name, id, { [id]: 4, [shelfLineId(id)]: 4 });
  }
  log.minute += 1;
  return id;
}

/** The door's records, in order, as the relay serves them. */
function served(bodies: readonly ShelfBody[]): ShelfRecord[] {
  return bodies.map((body, i) => ({
    seq: i + 1,
    received: 29_000_000,
    address: ADDRESS,
    data: signShelfBody(KEYS, body),
  }));
}

/** A reader that serves `records`. */
const readerOf = (records: readonly ShelfRecord[]): ShelfReader => ({
  current: () => Promise.resolve({ records, now: 29_000_000, since: new Map() }),
});

const LISTING: ShelfBody = {
  v: 1,
  kind: 'listing',
  open: true,
  name: 'Riverside Tenants',
  skeleton: nameSkeleton('Riverside Tenants'),
  covenant: COVENANT_HASH,
};

/** An entry with `id` and `title`. */
const entry = (id: string, title: string): ShelfBody => ({
  v: 1,
  kind: 'entry',
  id,
  title,
  text: '',
});

describe('straysOf', () => {
  it('keeps what the address withdrew that the group never published', () => {
    const withdrawn = [
      { address: ADDRESS, id: 'a', title: 'Ours' },
      { address: ADDRESS, id: 'b', title: 'Stray' },
      { address: 'other', id: 'c', title: 'Theirs' },
    ];

    expect(straysOf(withdrawn, ADDRESS, ['a'])).toEqual([withdrawn[1]]);
  });
});

describe('ShelfStrays', () => {
  it('names a stray a member’s device withdrew, with one line on what happened', async () => {
    const log = opened();
    const ours = publish(log);
    const stray = secretOf(0x61);
    const reader = readerOf(
      served([
        LISTING,
        entry(ours, 'Rally Saturday'),
        entry(stray, 'Buy cheap watches'),
        { v: 1, kind: 'withdraw', id: stray },
      ]),
    );

    render(<ShelfStrays state={log.state()} shelf={reader} />);

    const card = await screen.findByRole('region', { name: messages.shelfEntry.strayHeading });
    expect(card).toHaveTextContent('Buy cheap watches');
    expect(card).not.toHaveTextContent('Rally Saturday');
    expect(screen.getByText(messages.shelfEntry.stray)).toBeVisible();
    // Alone, the card has no page around it to title.
    document.title = 'Riverside Tenants';
    expect(await axeViolations()).toEqual([]);
  });

  it('shows nothing while nothing was withdrawn', async () => {
    const log = opened();
    const reader = readerOf(served([LISTING, entry(secretOf(0x62), 'Live')]));
    const { container } = render(<ShelfStrays state={log.state()} shelf={reader} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('reads nothing for a group whose door isn’t listed', () => {
    let asked = 0;
    const reader: ShelfReader = {
      current: () => {
        asked += 1;
        return Promise.resolve(null);
      },
    };
    const { container } = render(<ShelfStrays state={opened(DOOR).state()} shelf={reader} />);

    expect(container).toBeEmptyDOMElement();
    expect(asked).toBe(0);
  });
});
