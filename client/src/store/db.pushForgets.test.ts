/**
 * The push DELETEs a device still owes the relay (#356): one device-wide
 * record beside the relay backup's, in no group, so a DELETE survives the
 * Leave that purges its group, and a reload. No listener hears of it: no
 * screen shows it, and no backup file or link carries it.
 */
import { describe, expect, it, vi } from 'vitest';

import { freshIndexedDBPerTest } from '../test/idb';
import { openStore, type PushForget } from './db';
import { deviceSnapshot } from './snapshot';

freshIndexedDBPerTest();

const ENDPOINT = 'https://push.example/send/canary-endpoint';

/** A DELETE of `ENDPOINT` under `mailbox`, due at `due`. */
const owed = (mailbox: string, due = 1_762_650_060_000): PushForget => ({
  endpoint: ENDPOINT,
  mailbox,
  due,
});

describe('the push DELETEs a device owes (#356)', () => {
  it('holds none on a new device', async () => {
    const store = await openStore();
    expect(await store.listPushForgets()).toEqual([]);
  });

  it('keeps what an edit returns, in its order, across a reload, telling no listener', async () => {
    const store = await openStore();
    const heard = vi.fn<(groupId: string) => void>();
    store.subscribe(heard);

    await store.updatePushForgets((held) => [...held, owed('box-a'), owed('box-b')]);
    await store.updatePushForgets((held) => [...held, owed('box-c', 7)]);
    store.close();

    const reopened = await openStore();
    expect(await reopened.listPushForgets()).toEqual([
      owed('box-a'),
      owed('box-b'),
      owed('box-c', 7),
    ]);
    expect(heard).not.toHaveBeenCalled();
    reopened.close();
  });

  it('hands each edit what the last one kept, and drops the record once none is left', async () => {
    const store = await openStore();
    await store.updatePushForgets(() => [owed('box-a'), owed('box-b')]);
    const seen: PushForget[][] = [];

    await store.updatePushForgets((held) => {
      seen.push([...held]);
      return held.filter((forget) => forget.mailbox !== 'box-a');
    });
    await store.updatePushForgets((held) => {
      seen.push([...held]);
      return [];
    });

    expect(seen).toEqual([[owed('box-a'), owed('box-b')], [owed('box-b')]]);
    expect(await store.listPushForgets()).toEqual([]);
  });

  it('never goes in a backup file or a link', async () => {
    const store = await openStore();
    await store.updatePushForgets(() => [owed('box-a')]);

    const snapshot = JSON.stringify(await deviceSnapshot(store));

    expect(snapshot).not.toContain('canary-endpoint');
    expect(snapshot).not.toContain('box-a');
  });
});
