/**
 * The steward's inbox on the steward's device (#490; listed-doors.md §6.4):
 * one device-wide record of its cursor and what it opened, kept across a
 * reload, heard by no listener and carried by no backup file or link.
 */
import { describe, expect, it, vi } from 'vitest';

import type { KeptInbox } from '../shelf/inbox';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore } from './db';
import { deviceSnapshot } from './snapshot';

freshIndexedDBPerTest();

const ADDRESS = 'A'.repeat(43);

/** A kept inbox at `cursor`, with one report whose note is a canary, dismissed (#490). */
const kept = (cursor: number): KeptInbox => ({
  inbox: 'I'.repeat(43),
  instance: 'relay-1',
  cursor,
  items: [
    {
      key: 'K'.repeat(43),
      kind: 'report',
      seq: cursor,
      received: 29_000_000,
      address: ADDRESS,
      id: 'E'.repeat(43),
      clause: 'C2',
      note: 'inbox-canary',
    },
  ],
  dismissed: ['K'.repeat(43)],
});

describe('the steward’s inbox in the store (#490)', () => {
  it('holds none on a new device, nor reads another device record as one', async () => {
    const store = await openStore();
    expect(await store.getStewardInbox()).toBeUndefined();
    await store.keepShelfCopy({ instance: 'r', now: 1, records: [], readAt: 1, since: {} });
    expect(await store.getStewardInbox()).toBeUndefined();
    store.close();
  });

  it('keeps the latest across a reload, telling no listener, and drops it for null', async () => {
    const store = await openStore();
    const heard = vi.fn<(changed: string) => void>();
    store.subscribe(heard);
    await store.keepStewardInbox(kept(1));
    await store.keepStewardInbox(kept(2));
    store.close();

    const reopened = await openStore();
    expect(await reopened.getStewardInbox()).toEqual(kept(2));
    expect(await reopened.getShelfCopy()).toBeUndefined();
    await reopened.keepStewardInbox(null);
    expect(await reopened.getStewardInbox()).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
    reopened.close();
  });

  it('never goes in a backup file or a link', async () => {
    const store = await openStore();
    await store.keepStewardInbox(kept(1));
    const snapshot = JSON.stringify(await deviceSnapshot(store));
    expect(snapshot).not.toContain('inbox-canary');
    expect(snapshot).not.toContain(ADDRESS);
    store.close();
  });
});
