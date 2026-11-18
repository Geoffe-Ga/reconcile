/**
 * The shelf keeper (#486; docs/spec/listed-doors.md §4.5): a listed group's
 * devices keep its listing on the public shelf, and a closed door takes it
 * off. Every test runs on the fake shelf's minute clock and the group's relay
 * minute, moved together, never on real time.
 */
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf } from '../crypto/door';
import { verifyShelfRecord } from '../crypto/shelf';
import { addressOf, REFRESH_MINUTES } from '../door/page';
import type { FrontDoor } from '../engine/optIns';
import { createShelf, type Shelf } from '../net/shelf';
import { RelayError } from '../net/relay';
import { COVENANT_HASH, DOOR, LISTED, RENEWED, ROTATED, secretOf } from '../test/door';
import { createFakeShelf, type FakeShelf } from '../test/fakeShelf';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { createShelfKeeper, type KeptGroup, listingsDue } from './keeper';
import { parseShelfBody, type ShelfBody, signShelfBody } from './record';

const GROUP = 'group-1';
const NAME = 'Riverside Tenants';
const OPEN: ShelfBody = {
  v: 1,
  kind: 'listing',
  open: true,
  name: NAME,
  skeleton: 'riversidetenants',
  covenant: COVENANT_HASH,
};
const FINAL: ShelfBody = { v: 1, kind: 'listing', open: false, final: true };

/** The door's address on the shelf. */
const addressOfDoor = (door: FrontDoor): string => base64url(addressOf(door));

/** Ana, Ben and Cal, then everyone votes the front door to `door`. */
function opened(door: unknown = LISTED): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  passes(log, door);
  return log;
}

/** Everyone votes `value` into the front door, and a minute passes. */
function passes(log: LogBuilder, value: unknown): void {
  const proposal = log.rules('Ana', 'frontDoor', value, { title: 'The front door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
}

/** Ana's copy of the group in `log`, synced at its current minute. */
function copyOf(log: LogBuilder, extra: Partial<KeptGroup> = {}): KeptGroup {
  return {
    log: [...log.records],
    relayNow: log.minute,
    cleared: [],
    me: { author: authorOf('ana') },
    ...extra,
  };
}

/** One device: a keeper over a store holding `log`'s group, posting to `fake`. */
function device(fake: FakeShelf, log: LogBuilder, extra: Partial<KeptGroup> = {}) {
  const keeper = createShelfKeeper({
    store: { getGroup: (id) => Promise.resolve(id === GROUP ? copyOf(log, extra) : undefined) },
    shelf: createShelf({ fetch: fake.fetch }),
  });
  return { run: () => keeper.run(GROUP) };
}

/** The fake shelf and the log at one minute: the shelf's clock follows the group's. */
function inStep(fake: FakeShelf, log: LogBuilder, minutes: number): void {
  log.minute += minutes;
  fake.minute = log.minute;
}

/** The body of each record the fake holds under `door`'s address. */
function bodiesAt(fake: FakeShelf, door: FrontDoor): (ShelfBody | null)[] {
  const address = addressOfDoor(door);
  return fake.records
    .filter((record) => record.address === address)
    .map((record) => {
      const message = verifyShelfRecord(record.data, address);
      return message === null ? null : parseShelfBody(message);
    });
}

/** How many PUTs the fake has answered. */
const puts = (fake: FakeShelf): number => fake.urls.filter((url) => !url.includes('?')).length;

/** A fake shelf whose clock reads the log's minute. */
function shelfAt(log: LogBuilder): FakeShelf {
  return createFakeShelf({ minute: log.minute });
}

/** The door's signing keys, as the keeper signs with them. */
const keysOf = (door: FrontDoor) =>
  doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box)).signing;

describe('listingsDue: what a listed group keeps on the shelf (§4.5)', () => {
  it('keeps nothing for a group whose door was never listed', () => {
    expect(listingsDue(groupLog({ members: ['Ben'] }).state())).toEqual([]);
    expect(listingsDue(opened(DOOR).state())).toEqual([]);
  });

  it('keeps the open listing of a door listed in effect: the name and the covenant', () => {
    expect(listingsDue(opened().state())).toEqual([[LISTED, OPEN]]);
  });

  it('keeps the covenant the group accepted last', () => {
    const log = opened();
    passes(log, RENEWED);
    expect(listingsDue(log.state())).toEqual([[RENEWED, { ...OPEN, covenant: RENEWED.covenant }]]);
  });

  it('keeps a name of 120 code points whole', () => {
    const state = { ...opened().state(), name: 'x'.repeat(120) };
    expect(listingsDue(state)[0]?.[1]).toMatchObject({ name: 'x'.repeat(120) });
  });

  it('cuts a longer name to 120 code points, the last of them "…"', () => {
    const state = { ...opened().state(), name: 'x'.repeat(130) };
    expect(listingsDue(state)[0]?.[1]).toMatchObject({ name: `${'x'.repeat(119)}…` });
  });

  it('carries the skeleton of the name it lists, cut or not (#487)', () => {
    const state = { ...opened().state(), name: 'RIVERSIDE  Tenants-UNI0N '.repeat(6) };
    expect(listingsDue(state)[0]?.[1]).toMatchObject({
      skeleton: 'riversidetenantsunion'.repeat(4) + 'riversidetenants',
    });
  });

  it.each([
    [
      'a vote closes it',
      (log: LogBuilder) => {
        passes(log, false);
      },
    ],
    [
      'the group unlists it and keeps it open',
      (log: LogBuilder) => {
        passes(log, DOOR);
      },
    ],
    [
      'a rotation replaces it',
      (log: LogBuilder) => {
        passes(log, ROTATED);
      },
    ],
    [
      'a steward’s narrowing holds it shut',
      (log: LogBuilder) => {
        const off = log.rules('Ana', 'frontDoor', false, { title: 'Close the front door' });
        log.narrow('Ana', 'frontDoor', off);
        log.minute += 1;
      },
    ],
    [
      'a membership ends (#288)',
      (log: LogBuilder) => {
        log.leave('Cal');
        log.minute += 1;
      },
    ],
  ])('keeps a final listing once %s', (_reason, close) => {
    const log = opened();
    close(log);
    expect(listingsDue(log.state())).toEqual([
      [expect.objectContaining({ sign: LISTED.sign }), FINAL],
    ]);
  });

  it('keeps the new door’s listing beside the old one’s final when a listed door rotates', () => {
    const log = opened();
    const next = { ...ROTATED, listed: true, covenant: COVENANT_HASH };
    passes(log, next);
    expect(listingsDue(log.state())).toEqual([
      [expect.objectContaining({ sign: LISTED.sign }), FINAL],
      [next, OPEN],
    ]);
  });

  it('keeps a final listing once the group dissolves (#108)', () => {
    const log = opened();
    const proposal = log.proposeDissolve('Ana', false);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    log.minute += 1;
    log.dissolve('Ana', proposal);
    log.minute += 1;
    expect(listingsDue(log.state())).toEqual([
      [expect.objectContaining({ sign: LISTED.sign }), FINAL],
    ]);
  });
});

describe('createShelfKeeper: posting and refreshing the listing (§4.2, §4.5)', () => {
  it('posts the listing once the listing vote has passed', async () => {
    const log = opened();
    const fake = shelfAt(log);

    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
  });

  it('posts nothing for a group whose door isn’t listed, and reads nothing', async () => {
    const log = opened(DOOR);
    const fake = shelfAt(log);

    await device(fake, log).run();

    expect(fake.urls).toEqual([]);
  });

  it('posts nothing while the copy that stands is current, on this device or another', async () => {
    const log = opened();
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    inStep(fake, log, 60);

    await ana.run();
    await device(fake, log).run();

    expect(puts(fake)).toBe(1);
  });

  it('refreshes the listing when its newest copy is 10,080 relay minutes old', async () => {
    const log = opened();
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    const first = fake.records[0]?.received ?? 0;

    inStep(fake, log, REFRESH_MINUTES - 1);
    await ana.run();
    expect(puts(fake)).toBe(1);

    inStep(fake, log, 1);
    await ana.run();
    expect(puts(fake)).toBe(2);
    expect(fake.records.map((r) => [r.seq, r.received])).toEqual([[1, first + REFRESH_MINUTES]]);
  });

  it('lets another device refresh a copy that came due, reading when it was posted', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();

    inStep(fake, log, REFRESH_MINUTES);
    await device(fake, log).run();

    expect(puts(fake)).toBe(2);
  });

  it('posts the listing again after it lapsed 30 days without a post', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();

    inStep(fake, log, 31 * 1440);
    const shown = await createShelf({ fetch: fake.fetch }).read();
    expect(shown?.records).toEqual([]);
    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
  });

  it('posts when the copy that stands says another name or covenant', async () => {
    const log = opened();
    const fake = shelfAt(log);
    const shelf = createShelf({ fetch: fake.fetch });
    await shelf.put(addressOfDoor(LISTED), signShelfBody(keysOf(LISTED), { ...OPEN, name: 'Old' }));

    await device(fake, log).run();
    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);

    passes(log, RENEWED);
    fake.minute = log.minute;
    await device(fake, log).run();
    expect(bodiesAt(fake, LISTED)).toEqual([{ ...OPEN, covenant: RENEWED.covenant }]);
  });

  it('posts nothing, and reads again only after an hour, while the relay has no shelf', async () => {
    const log = opened();
    const fake = shelfAt(log);
    fake.available = false;
    const ana = device(fake, log);

    await ana.run();
    inStep(fake, log, 59);
    await ana.run();
    expect(fake.urls).toHaveLength(1);

    inStep(fake, log, 1);
    fake.available = true;
    await ana.run();
    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
  });

  it('keeps nothing on a device that is leaving, nor one whose member was removed', async () => {
    const log = opened();
    const fake = shelfAt(log);

    await device(fake, log, { leaving: new Uint8Array(1) }).run();
    await device(fake, log, { me: { author: authorOf('zed') } }).run();
    await device(fake, log, { relayNow: null }).run();

    expect(fake.urls).toEqual([]);
  });

  it('keeps nothing for a group it doesn’t hold', async () => {
    const fake = createFakeShelf();
    const keeper = createShelfKeeper({
      store: { getGroup: () => Promise.resolve(undefined) },
      shelf: createShelf({ fetch: fake.fetch }),
    });

    await keeper.run(GROUP);

    expect(fake.urls).toEqual([]);
  });
});

describe('createShelfKeeper: the final listing (§4.2, §4.5)', () => {
  it('posts the final listing when the door closes, and the relay drops its entries', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();
    const entry = { v: 1, kind: 'entry', id: secretOf(0x0e), title: 'Rent', text: '' } as const;
    await createShelf({ fetch: fake.fetch }).put(
      addressOfDoor(LISTED),
      signShelfBody(keysOf(LISTED), entry),
    );

    passes(log, false);
    fake.minute = log.minute;
    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([FINAL]);
  });

  it('posts the final listing again whenever it is 10,080 relay minutes old', async () => {
    const log = opened();
    passes(log, false);
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();

    inStep(fake, log, REFRESH_MINUTES - 1);
    await ana.run();
    await device(fake, log).run();
    expect(puts(fake)).toBe(1);

    inStep(fake, log, 1);
    await ana.run();
    expect(puts(fake)).toBe(2);
    expect(bodiesAt(fake, LISTED)).toEqual([FINAL]);
  });

  it('never posts an open listing over a final one: relisting takes a new door', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await createShelf({ fetch: fake.fetch }).put(
      addressOfDoor(LISTED),
      signShelfBody(keysOf(LISTED), FINAL),
    );
    const ana = device(fake, log);

    await ana.run();
    inStep(fake, log, 2 * REFRESH_MINUTES);
    await ana.run();

    expect(puts(fake)).toBe(1);
    expect(bodiesAt(fake, LISTED)).toEqual([FINAL]);
  });

  it('stops for good when the relay answers that the listing is final', async () => {
    const log = opened();
    const calls: string[] = [];
    const shelf: Shelf = {
      read: () => Promise.resolve({ records: [], now: log.minute, instance: 'i' }),
      put: () => {
        calls.push('put');
        return Promise.reject(new RelayError(409, 'listing_final'));
      },
    };
    const keeper = createShelfKeeper({
      store: { getGroup: () => Promise.resolve(copyOf(log)) },
      shelf,
    });

    await keeper.run(GROUP);
    log.minute += 2 * REFRESH_MINUTES;
    await keeper.run(GROUP);

    expect(calls).toEqual(['put']);
  });

  it('lets any other refusal through, so the next pass tries again', async () => {
    const log = opened();
    const shelf: Shelf = {
      read: () => Promise.resolve({ records: [], now: log.minute, instance: 'i' }),
      put: () => Promise.reject(new RelayError(507, 'shelf_full')),
    };
    const keeper = createShelfKeeper({
      store: { getGroup: () => Promise.resolve(copyOf(log)) },
      shelf,
    });

    await expect(keeper.run(GROUP)).rejects.toThrow(RelayError);
    await expect(keeper.run(GROUP)).rejects.toThrow(RelayError);
  });
});
