/**
 * The device's copy of its last read of the public shelf (#431;
 * docs/spec/listed-doors.md §5.2): one device-wide record in no group, so
 * Discover reads the relay at most once an hour across reloads. It is the
 * public shelf, the same for every device: no listener hears of it, and no
 * backup file or link carries it.
 */
import { describe, expect, it, vi } from 'vitest';

import type { KeptShelf } from '../shelf/read';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore } from './db';
import { deviceSnapshot } from './snapshot';

freshIndexedDBPerTest();

const ADDRESS = 'A'.repeat(43);

/** A copy of a read holding one record whose bytes are a canary. */
const copy = (readAt: number): KeptShelf => ({
  instance: 'relay-1',
  now: 29_000_000,
  records: [
    {
      seq: 1,
      received: 28_999_000,
      address: ADDRESS,
      data: new TextEncoder().encode('shelf-canary'),
    },
  ],
  readAt,
  since: { [ADDRESS]: 28_999_000 },
});

describe('the shelf’s copy (#431)', () => {
  it('holds none on a new device', async () => {
    const store = await openStore();
    expect(await store.getShelfCopy()).toBeUndefined();
    store.close();
  });

  it('keeps the latest copy across a reload, telling no listener', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);

    await store.keepShelfCopy(copy(1));
    await store.keepShelfCopy(copy(2));
    store.close();

    const reopened = await openStore();
    expect(await reopened.getShelfCopy()).toEqual(copy(2));
    expect(heard).not.toHaveBeenCalled();
    reopened.close();
  });

  it('drops the copy for null', async () => {
    const store = await openStore();
    await store.keepShelfCopy(copy(1));

    await store.keepShelfCopy(null);

    expect(await store.getShelfCopy()).toBeUndefined();
    store.close();
  });

  it('reads no other device record as a copy', async () => {
    const store = await openStore();
    await store.updatePushForgets(() => [
      { endpoint: 'https://push.example/x', mailbox: 'm', due: 1 },
    ]);

    expect(await store.getShelfCopy()).toBeUndefined();
    store.close();
  });

  it('never goes in a backup file or a link', async () => {
    const store = await openStore();
    await store.keepShelfCopy(copy(1));

    const snapshot = JSON.stringify(await deviceSnapshot(store));

    expect(snapshot).not.toContain(ADDRESS);
    expect(snapshot).not.toContain('relay-1');
    store.close();
  });
});
