/**
 * The card's actions at their edges (#114): what's refused before anything
 * is kept, and what a device that can't reach the relay is told.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { newCardSeed } from '../crypto/card';
import { MAX_PLAINTEXT_BYTES } from '../crypto/seal';
import { fold } from '../engine/fold';
import { closeAll, found, open, SLOW, twoGroups } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { newEntry } from '../store/coalitions';
import { parseCardLink } from '../coalition/card';
import { NestedLogs, threeLevels } from '../test/coalitions';
import { authorOf } from '../test/keys';
import {
  admitCard,
  bringCard,
  bringsInto,
  type FoundCard,
  lookupCard,
  makeCard,
  postCard,
} from './reconcile';

freshIndexedDBPerTest();

afterEach(closeAll);

const VALUES = { name: 'Eastside', statement: 'One.', why: 'Why.', yourName: 'Ana' };

describe('makeCard', () => {
  it('refuses a statement too large to send, keeping nothing', async () => {
    const fake = createFakeRelay();
    const ana = await open(fake, 'ana');
    const riverside = await found(ana, 'Riverside Tenants', 'Ana');
    const statement = 'x'.repeat(MAX_PLAINTEXT_BYTES);

    expect(await makeCard(ana.services, riverside, { ...VALUES, statement })).toEqual({
      outcome: 'too-large',
    });
    expect((await ana.services.store.getGroup(riverside))?.outbox).toEqual([]);
    expect(await ana.services.store.listCoalitions()).toEqual([]);
  });

  it('refuses a group the device isn’t in', async () => {
    const ana = await open(createFakeRelay(), 'ana');
    await expect(makeCard(ana.services, 'nowhere', VALUES)).rejects.toThrow('No such group');
  });

  it('cuts a long group name on the card, so the card still opens', async () => {
    const fake = createFakeRelay();
    const ana = await open(fake, 'ana');
    const ben = await open(fake, 'ben');
    const riverside = await found(ana, 'R'.repeat(200), 'Ana');
    const made = await makeCard(ana.services, riverside, VALUES);
    if (made.outcome !== 'queued') throw new Error('Expected a card.');
    expect(made.card.seat.name).toBe(`${'R'.repeat(120)}…`);

    const seed = parseCardLink(await postCard(ana.services, made.card, ana.services.origin));
    const lookup = await lookupCard(ben.services, seed ?? new Uint8Array());
    expect(lookup.kind === 'found' && lookup.found.card.seat.name).toBe(`${'R'.repeat(120)}…`);
  });
});

describe('lookupCard', () => {
  it('reads as offline when the relay can’t be reached', async () => {
    const fake = createFakeRelay();
    const ben = await open(fake, 'ben');
    fake.offline = true;
    expect(await lookupCard(ben.services, newCardSeed())).toEqual({ kind: 'offline' });
  });

  it('reads a card that would found a coalition without inner as damaged (#313)', async () => {
    const fake = createFakeRelay();
    const ana = await open(fake, 'ana');
    const ben = await open(fake, 'ben');
    const riverside = await found(ana, 'Riverside Tenants', 'Ana');
    const made = await makeCard(ana.services, riverside, VALUES);
    if (made.outcome !== 'queued') throw new Error('Expected a card.');
    const { secret, seat, name, title, atoms, entries } = made.card;
    const bare = { secret, seat, name, title, atoms, entries };

    const seed = parseCardLink(await postCard(ana.services, bare, ana.services.origin));
    expect(await lookupCard(ben.services, seed ?? new Uint8Array())).toEqual({ kind: 'missing' });
    const whole = parseCardLink(await postCard(ana.services, made.card, ana.services.origin));
    expect((await lookupCard(ben.services, whole ?? new Uint8Array())).kind).toBe('found');
  });
});

describe('bringCard', () => {
  it('refuses a group the device isn’t in', async () => {
    const ben = await open(createFakeRelay(), 'ben');
    const card = { mode: 'found' } as unknown as FoundCard;
    await expect(bringCard(ben.services, card, 'nowhere', 'Ben')).rejects.toThrow('No such group');
  });
});

describe('admitCard', SLOW, () => {
  it('refuses a coalition or group the device doesn’t hold', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await twoGroups(fake);
    await expect(admitCard(ana.services, 'nowhere', riverside)).rejects.toThrow(
      'No such coalition',
    );
    const entry = await ana.services.store.addGroup(newEntry(new Uint8Array(32).fill(5)));
    await expect(admitCard(ana.services, entry.groupId, 'nowhere')).rejects.toThrow(
      'No such coalition',
    );
  });

  it('refuses a group that holds no seat in the coalition', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await twoGroups(fake);
    const entry = await ana.services.store.addGroup(newEntry(new Uint8Array(32).fill(5)));
    expect(fold(entry.log, null).coalition).toBeNull();
    await expect(admitCard(ana.services, entry.groupId, riverside)).rejects.toThrow(
      'holds no seat',
    );
  });
});

describe('bringsInto (#122)', () => {
  it('lets a participant bring a card into a formed coalition below level 3, and no one else', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const at = 29_375_100;
    const d = fold(logs.logs.D ?? [], at);
    const f = fold(logs.logs.F ?? [], at);
    expect(d.coalition?.level).toBe(2);
    expect(bringsInto(d, authorOf('fay'))).toBe(true);
    expect(bringsInto(d, authorOf('ana'))).toBe(false);
    expect(f.coalition?.level).toBe(3);
    expect(bringsInto(f, authorOf('ivy'))).toBe(false);
    const forming = new NestedLogs();
    forming.coalitionIn('X', at, [['A'], ['B']]);
    forming.joinIn('X', at + 1, 'cal', 'A');
    expect(bringsInto(fold(forming.logs.X ?? [], at + 2), authorOf('cal'))).toBe(false);
  });
});
