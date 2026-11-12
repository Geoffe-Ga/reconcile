/**
 * Opening a follow link (#124) on a fake relay, from envelopes sealed here:
 * what the link carries must be a formed coalition's log, or it reads as
 * expired or damaged, and nothing is kept before Follow.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { followChannelOf, newFollowSeed } from '../crypto/follow';
import { fromBase64url } from '../crypto/base64url';
import { xchachaSeal } from '../crypto/seal';
import { type Follow, FOLLOW_TTL_DAYS, sealFollow } from '../coalition/follow';
import type { LogRecord } from '../engine/fold';
import { fold } from '../engine/fold';
import { open, closeAll } from '../test/coalitionDevices';
import { Logs, testSecret } from '../test/coalitions';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { lookupFollow, previewOf } from './follow';

freshIndexedDBPerTest();

afterEach(() => {
  closeAll();
});

const SECRET = fromBase64url(testSecret('coalition'));

/** Seals `entries` under a fresh follow seed and PUTs them to the fake relay, as Share would. */
async function posted(fake: FakeRelay, entries: readonly LogRecord[]): Promise<Uint8Array> {
  const seed = newFollowSeed();
  const channel = followChannelOf(seed);
  const follow: Follow = {
    secret: SECRET,
    preview: { name: 'Rivers United', groups: ['A', 'B'], excerpt: 'We keep the river clean.' },
    entries,
  };
  const device = await open(fake, 'sharer');
  for (const blob of sealFollow(xchachaSeal, channel, follow)) {
    await device.services.relay.putBlob(channel.mailbox, blob, FOLLOW_TTL_DAYS);
  }
  return seed;
}

describe('lookupFollow (#124)', () => {
  it('finds a formed coalition, keeping nothing until Follow', async () => {
    const fake = createFakeRelay({ minute: 29_375_000 });
    const logs = new Logs();
    logs.formed(29_375_010, ['A', 'B'], ['kim', 'zed']);
    const entries = logs.logs.coalition ?? [];
    const seed = await posted(fake, entries);
    const fay = await open(fake, 'fay');

    const found = await lookupFollow(fay.services, seed);

    expect(found.kind).toBe('found');
    if (found.kind !== 'found') return;
    expect(found.found.coalitionId).toBe(logs.ids.coalition);
    expect(found.found.page.cursor).toBe(entries.at(-1)?.seq);
    expect(found.found.page.relayNow).toBe(fake.minute);
    expect(Array.from(found.found.secret)).toEqual(Array.from(SECRET));
    expect(await fay.services.store.listCoalitions()).toEqual([]);
  });

  it.each([
    ['a coalition still forming', (logs: Logs) => logs.coalition(29_375_010, ['A', 'B'])],
    ['a group’s log, not a coalition’s', (logs: Logs) => logs.group('G', 29_375_010, ['ana'])],
  ])('reads %s as an expired or damaged link', async (_label, make) => {
    const fake = createFakeRelay({ minute: 29_375_100 });
    const logs = new Logs();
    make(logs);
    const entries = Object.values(logs.logs)[0] ?? [];
    const seed = await posted(fake, entries);
    const fay = await open(fake, 'fay');
    expect(await lookupFollow(fay.services, seed)).toEqual({ kind: 'missing' });
  });

  it('reads an empty mailbox, as an expired link leaves, as expired or damaged', async () => {
    const fake = createFakeRelay();
    const fay = await open(fake, 'fay');
    expect(await lookupFollow(fay.services, newFollowSeed())).toEqual({ kind: 'missing' });
  });

  it('says so when the relay can’t be reached', async () => {
    const fake = createFakeRelay();
    const fay = await open(fake, 'fay');
    fake.offline = true;
    expect(await lookupFollow(fay.services, newFollowSeed())).toEqual({ kind: 'offline' });
  });
});

describe('previewOf (#124)', () => {
  it('names the coalition and its groups, and gives its first section as plain text', () => {
    const logs = new Logs();
    logs.formed(29_375_010, ['Riverside', 'Oak St'], ['kim', 'zed']);
    const state = fold(logs.logs.coalition ?? [], 29_375_100);
    expect(previewOf(state)).toEqual({
      name: 'Rivers United',
      groups: ['Riverside', 'Oak St'],
      excerpt: 'We keep the river clean.',
    });
  });

  it('gives an empty excerpt and no groups before a genesis', () => {
    expect(previewOf(fold([], null))).toEqual({ name: '', groups: [], excerpt: '' });
  });
});
