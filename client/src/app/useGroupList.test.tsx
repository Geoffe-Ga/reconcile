import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEvent } from '../engine/event';
import { createRelay } from '../net/relay';
import { type Group, openStore, type Store } from '../store/db';
import { createSync } from '../store/sync';
import { createFakeRelay, TEST_MAILBOX } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { useGroupList } from './useGroupList';

freshIndexedDBPerTest();

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

async function storeWithGroup(): Promise<{ store: Store; groupId: string }> {
  const store = await openStore('list');
  opened.push(store);
  const genesis = createEvent({
    type: 'genesis',
    group: '',
    author: 'ana',
    ts: 0,
    body: { name: 'Riverside Tenants', founder: 'Ana', title: 'House rules', atoms: ['A'] },
  });
  const me = { author: 'ana', name: 'Ana' };
  await store.addGroup({
    groupId: genesis.id,
    mailbox: TEST_MAILBOX,
    secret: new Uint8Array(32),
    me,
  });
  await store.enqueue(genesis.id, genesis.bytes);
  return { store, groupId: genesis.id };
}

describe('useGroupList', () => {
  it('is null until the store answers', () => {
    const store = {
      listGroups: () => new Promise<never>(() => undefined),
      subscribe: () => () => undefined,
    };
    const { result } = renderHook(() => useGroupList(store));
    expect(result.current).toBeNull();
  });

  it('names each group once its genesis is back from the relay', async () => {
    const { store, groupId } = await storeWithGroup();
    const { result } = renderHook(() => useGroupList(store));

    await waitFor(() => {
      expect(result.current).toEqual([{ groupId, name: null, title: null }]);
    });

    const sync = createSync({ store, relay: createRelay({ fetch: createFakeRelay().fetch }) });
    await act(() => sync.syncOnce());

    await waitFor(() => {
      expect(result.current).toEqual([
        { groupId, name: 'Riverside Tenants', title: 'House rules' },
      ]);
    });
  });

  it('keeps the newest read when an older one answers late', async () => {
    const reads: ((groups: Group[]) => void)[] = [];
    let notify: (groupId: string) => void = () => undefined;
    const store = {
      listGroups: () =>
        new Promise<Group[]>((resolve) => {
          reads.push(resolve);
        }),
      subscribe: (listener: (groupId: string) => void) => {
        notify = listener;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useGroupList(store));
    act(() => {
      notify('g');
    });

    await act(async () => {
      reads[1]?.([]);
      await Promise.resolve();
      reads[0]?.([stored('old')]);
      await Promise.resolve();
    });

    expect(result.current).toEqual([]);
  });

  it('keeps its last list when a read fails, and stops listening once unmounted', async () => {
    let fail = false;
    let notify: (groupId: string) => void = () => undefined;
    const unsubscribe = vi.fn();
    const store = {
      listGroups: vi.fn(() => (fail ? Promise.reject(new Error('closed')) : Promise.resolve([]))),
      subscribe: (listener: (groupId: string) => void) => {
        notify = listener;
        return unsubscribe;
      },
    };
    const { result, unmount } = renderHook(() => useGroupList(store));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });

    fail = true;
    await act(async () => {
      notify('g');
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

/** A stored group with an empty log. */
function stored(groupId: string): Group {
  return {
    groupId,
    mailbox: TEST_MAILBOX,
    secret: new Uint8Array(32),
    me: { author: 'ana', name: 'Ana' },
    log: [],
    cursor: 0,
    relayNow: null,
    instance: null,
    outbox: [],
    lastSyncAt: null,
  };
}
