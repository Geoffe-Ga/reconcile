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
import { shelfLineId } from '../engine/dispatches';
import type { FrontDoor } from '../engine/optIns';
import { createShelf, type Shelf } from '../net/shelf';
import { RelayError } from '../net/relay';
import { COVENANT_HASH, DOOR, LISTED, RENEWED, ROTATED, secretOf } from '../test/door';
import { createFakeShelf, type FakeShelf, notify } from '../test/fakeShelf';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { createShelfKeeper, entriesDue, type KeptGroup, listingsDue } from './keeper';
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

/**
 * A fake shelf whose clock reads the log's minute, on which the steward
 * releases each listing as it comes (#488), so what the keeper posts reads
 * back; `held` keeps every first listing waiting, as a held relay does.
 */
function shelfAt(log: LogBuilder, { held = false } = {}): FakeShelf {
  return createFakeShelf({ minute: log.minute, holds: held });
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

  it('on a held relay, posts once a launch while the listing waits, and the relay keeps one held copy (#488)', async () => {
    const log = opened();
    const fake = shelfAt(log, { held: true });
    const ana = device(fake, log);
    await ana.run();
    inStep(fake, log, 60);
    await ana.run();
    expect(puts(fake)).toBe(1);

    await device(fake, log).run();

    expect(puts(fake)).toBe(2);
    expect(fake.records.map((r) => [r.seq, r.heldUntil])).toEqual([[1, Infinity]]);
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
    const shelf: Pick<Shelf, 'read' | 'put'> = {
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
    const shelf: Pick<Shelf, 'read' | 'put'> = {
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

/** Ana's Dispatch put to the vote with a shelf line, which everyone scores 4 on both lines. */
function publish(log: LogBuilder, title = 'Rally Saturday', shelfScore: 0 | 4 = 4): string {
  const id = log.rising('Ana', 0, { title, text: 'Meet at the river at ten.' }, undefined, true);
  log.minute += 1;
  for (const name of ['Ana', 'Ben', 'Cal']) {
    const note = shelfScore === 0 ? 'Not on the shelf.' : undefined;
    log.ballot(name, id, { [id]: 4, [shelfLineId(id)]: shelfScore }, note);
  }
  log.minute += 1;
  return id;
}

/** The entry body the keeper posts for the Dispatch `id` titled `title`. */
const entryOf = (id: string, title = 'Rally Saturday'): ShelfBody => ({
  v: 1,
  kind: 'entry',
  id,
  title,
  text: 'Meet at the river at ten.',
});

/** A stray: an entry signed with the door's key that the group's log never made. */
async function postStray(fake: FakeShelf, label: number): Promise<string> {
  const id = secretOf(label);
  const stray = { v: 1, kind: 'entry', id, title: 'Not ours', text: 'Spam.' } as const;
  await createShelf({ fetch: fake.fetch }).put(
    addressOfDoor(LISTED),
    signShelfBody(keysOf(LISTED), stray),
  );
  return id;
}

describe('entriesDue: the Dispatches a listed group keeps on the shelf (§4.5)', () => {
  it('keeps each Dispatch whose shelf line passed, with its title and text', () => {
    const log = opened();
    const id = publish(log);
    publish(log, 'Not on the shelf', 0);

    expect(entriesDue(log.state())).toEqual([entryOf(id)]);
  });

  it('keeps a Dispatch until 30 days after its vote closed, so its entry is never posted twice', () => {
    const log = opened();
    const id = publish(log);
    const closed = log.minute - 1;

    expect(entriesDue(log.state(closed + 30 * 1440 - 1))).toEqual([entryOf(id)]);
    expect(entriesDue(log.state(closed + 30 * 1440))).toEqual([]);
  });
});

describe('createShelfKeeper: entries (§4.2, §4.5)', () => {
  it('never posts again an entry the steward upheld (#489)', async () => {
    const log = opened();
    const id = publish(log);
    const fake = shelfAt(log);
    await device(fake, log).run();
    const address = addressOfDoor(LISTED);
    await notify(fake, { v: 1, kind: 'notice', act: 'uphold', address, id, clause: 'C2' });
    inStep(fake, log, 1440);
    const before = puts(fake);

    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
    expect(puts(fake)).toBe(before);
  });

  it('posts nothing more under a door the steward suspended, even once its listing comes due (#489)', async () => {
    const log = opened();
    publish(log);
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    const address = addressOfDoor(LISTED);
    await notify(fake, { v: 1, kind: 'notice', act: 'suspend', address, clause: 'C3' });
    inStep(fake, log, REFRESH_MINUTES);
    publish(log, 'Another');
    const before = puts(fake);

    await ana.run();
    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([]);
    expect(puts(fake)).toBe(before);
  });

  it('posts the listing again at the next launch once the steward lifts the suspension (#490)', async () => {
    const log = opened();
    const fake = shelfAt(log, { held: true });
    await device(fake, log).run();
    const address = addressOfDoor(LISTED);
    await notify(fake, { v: 1, kind: 'notice', act: 'release', address });
    await notify(fake, { v: 1, kind: 'notice', act: 'suspend', address, clause: 'C3' });
    const ana = device(fake, log);
    await ana.run();
    expect(bodiesAt(fake, LISTED)).toEqual([]);

    await notify(fake, { v: 1, kind: 'notice', act: 'unsuspend', address });
    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
    const relisted = fake.records.filter((record) => record.address === address);
    expect(relisted.map((record) => record.heldUntil)).toEqual([Infinity]);
  });

  it('stops, without failing, when the relay refuses a suspended door it can’t verify (#489)', async () => {
    const log = opened();
    publish(log);
    const fake = shelfAt(log);
    const real = fake.fetch;
    const refused = {
      ...fake,
      fetch: (async (input, init) =>
        init?.method === 'PUT'
          ? Response.json({ error: 'suspended' }, { status: 403 })
          : real(input, init)) as FakeShelf['fetch'],
    };
    const ana = device(refused, log);

    await expect(ana.run()).resolves.toBeUndefined();
    const before = refused.urls.length;
    await ana.run();

    expect(fake.urls.length).toBe(before);
  });

  it('posts an entry once the shelf line has passed, after the listing', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();
    const id = publish(log);
    fake.minute = log.minute;

    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN, entryOf(id)]);
  });

  it('posts no entry for a Dispatch whose shelf line failed', async () => {
    const log = opened();
    publish(log, 'Not on the shelf', 0);
    const fake = shelfAt(log);

    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN]);
  });

  it('posts an entry once across the group’s devices: one that finds it posts nothing', async () => {
    const log = opened();
    const id = publish(log);
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    inStep(fake, log, 1);

    await ana.run();
    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([OPEN, entryOf(id)]);
    expect(puts(fake)).toBe(2);
  });

  it('waits for the next relay day when the relay has taken one today', async () => {
    const log = opened();
    const first = publish(log, 'First');
    const second = publish(log, 'Second');
    const fake = shelfAt(log);
    const ana = device(fake, log);
    fake.minute = log.minute = 1440 * Math.ceil(log.minute / 1440) - 120;

    await ana.run();
    expect(bodiesAt(fake, LISTED)).toEqual([OPEN, entryOf(first, 'First')]);
    inStep(fake, log, 59);
    await ana.run();
    expect(puts(fake)).toBe(3);

    inStep(fake, log, 61);
    await ana.run();
    expect(bodiesAt(fake, LISTED)).toEqual([
      OPEN,
      entryOf(first, 'First'),
      entryOf(second, 'Second'),
    ]);
  });

  it('posts no entry for a door that isn’t listed', async () => {
    const log = opened(DOOR);
    publish(log);
    const fake = shelfAt(log);

    await device(fake, log).run();

    expect(fake.records).toEqual([]);
  });

  it('lets any other refusal of an entry through, so the next pass tries again', async () => {
    const log = opened();
    publish(log);
    const shelf: Pick<Shelf, 'read' | 'put'> = {
      read: () => Promise.resolve({ records: [], now: log.minute, instance: 'i' }),
      put: (_address, record) => {
        const body = parseShelfBody(record.slice(64));
        return body?.kind === 'entry'
          ? Promise.reject(new RelayError(507, 'shelf_full'))
          : Promise.resolve(1);
      },
    };
    const keeper = createShelfKeeper({
      store: { getGroup: () => Promise.resolve(copyOf(log)) },
      shelf,
    });

    await expect(keeper.run(GROUP)).rejects.toThrow(RelayError);
  });
});

describe('createShelfKeeper: a stray entry (§4.5)', () => {
  it('withdraws an entry under the group’s address that its log didn’t make', async () => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();
    const stray = await postStray(fake, 0x51);
    inStep(fake, log, 60);

    await device(fake, log).run();

    expect(bodiesAt(fake, LISTED)).toEqual([
      OPEN,
      { v: 1, kind: 'entry', id: stray, title: 'Not ours', text: 'Spam.' },
      { v: 1, kind: 'withdraw', id: stray },
    ]);
  });

  it('leaves an entry that came after its own log was read, until a later read', async () => {
    const log = opened();
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    inStep(fake, log, 60);
    const stray = await postStray(fake, 0x54);

    // It came in the minute the log was read, maybe after: a vote that closed since may have made it.
    await ana.run();
    expect(fake.urls.filter((url) => url.includes('?'))).toHaveLength(2);
    expect(bodiesAt(fake, LISTED)).not.toContainEqual({ v: 1, kind: 'withdraw', id: stray });

    inStep(fake, log, 60);
    await ana.run();
    expect(bodiesAt(fake, LISTED)).toContainEqual({ v: 1, kind: 'withdraw', id: stray });
  });

  it('withdraws no entry the group published, and a stray only once', async () => {
    const log = opened();
    const id = publish(log);
    const fake = shelfAt(log);
    await device(fake, log).run();
    inStep(fake, log, 1440);
    await postStray(fake, 0x52);
    inStep(fake, log, 1);

    await device(fake, log).run();
    await device(fake, log).run();

    const withdrawn = bodiesAt(fake, LISTED).filter((body) => body?.kind === 'withdraw');
    expect(withdrawn).toEqual([{ v: 1, kind: 'withdraw', id: secretOf(0x52) }]);
    expect(bodiesAt(fake, LISTED)).toContainEqual(entryOf(id));
  });

  it.each([
    [409, 'no_entry', 'resolves'],
    [409, 'not_listed', 'resolves'],
    [507, 'shelf_full', 'rejects'],
  ] as const)('meets %s %s on a withdraw and %s', async (status, code, outcome) => {
    const log = opened();
    const fake = shelfAt(log);
    await device(fake, log).run();
    await postStray(fake, 0x53);
    log.minute += 1;
    const { records } = (await createShelf({ fetch: fake.fetch }).read()) ?? { records: [] };
    const shelf: Pick<Shelf, 'read' | 'put'> = {
      read: () => Promise.resolve({ records, now: log.minute, instance: 'i' }),
      put: (_address, record) =>
        parseShelfBody(record.slice(64))?.kind === 'withdraw'
          ? Promise.reject(new RelayError(status, code))
          : Promise.resolve(1),
    };
    const keeper = createShelfKeeper({
      store: { getGroup: () => Promise.resolve(copyOf(log)) },
      shelf,
    });

    if (outcome === 'resolves') await expect(keeper.run(GROUP)).resolves.toBeUndefined();
    else await expect(keeper.run(GROUP)).rejects.toThrow(RelayError);
  });

  it('looks for strays at most once an hour on one device', async () => {
    const log = opened();
    const fake = shelfAt(log);
    const ana = device(fake, log);
    await ana.run();
    const reads = (): number => fake.urls.filter((url) => url.includes('?')).length;
    expect(reads()).toBe(1);

    inStep(fake, log, 59);
    await ana.run();
    expect(reads()).toBe(1);

    inStep(fake, log, 1);
    await ana.run();
    expect(reads()).toBe(2);
  });
});
