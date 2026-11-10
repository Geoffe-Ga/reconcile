import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { type Group, openStore, type Store } from '../store/db';
import { createSync } from '../store/sync';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { useGroupList } from './useGroupList';

freshIndexedDBPerTest();

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

async function storeWithGroup(): Promise<{ store: Store; groupId: string }> {
  const store = await openStore('list');
  opened.push(store);
  const genesis = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: 0,
    body: { name: 'Riverside Tenants', founder: 'Ana', title: 'House rules', atoms: ['A'] },
  });
  const me = { author: authorOf('ana'), name: 'Ana' };
  await store.addGroup({
    groupId: genesis.id,
    secret: new Uint8Array(32),
    signingKey: testKeys('ana').secretKey,
    me,
  });
  await store.enqueue(genesis.id, genesis.record);
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
      expect(result.current).toEqual([{ groupId, name: null, title: null, leaving: false }]);
    });

    const relay = createRelay({ fetch: createFakeRelay().fetch });
    const sync = createSync({ store, relay, seal: xchachaSeal });
    await act(() => sync.syncOnce());

    await waitFor(() => {
      expect(result.current).toEqual([
        { groupId, name: 'Riverside Tenants', title: 'House rules', leaving: false },
      ]);
    });
  });

  it('marks a group whose leave waits for the relay as leaving', async () => {
    const { store, groupId } = await storeWithGroup();
    const { result } = renderHook(() => useGroupList(store));
    const leave = signedAs('ana', { type: 'leave', group: groupId, ts: 0, body: {} });

    await act(() => store.markLeaving(groupId, leave.record));

    await waitFor(() => {
      expect(result.current).toEqual([{ groupId, name: null, title: null, leaving: true }]);
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
    secret: new Uint8Array(32),
    signingKey: testKeys('ana').secretKey,
    me: { author: authorOf('ana'), name: 'Ana' },
    log: [],
    cursor: 0,
    relayNow: null,
    instance: null,
    outbox: [],
    lastSyncAt: null,
  };
}
