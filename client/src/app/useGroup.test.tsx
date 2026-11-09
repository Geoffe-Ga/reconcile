import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEvent } from '../engine/event';
import type { EncodedEvent } from '../engine/event';
import { createRelay } from '../net/relay';
import { openStore } from '../store/db';
import type { Group, NewGroup, Store } from '../store/db';
import { createSync } from '../store/sync';
import type { Sync } from '../store/sync';
import { TEST_MAILBOX, createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { GroupServicesContext, useGroup } from './useGroup';
import type { GroupServices } from './useGroup';

freshIndexedDBPerTest();

const GROUP = 'group-1';
const TS = 1_762_650_000_000;
const syncs: Sync[] = [];

afterEach(() => {
  for (const sync of syncs.splice(0)) {
    sync.stop();
  }
});

function genesis(title = 'House rules'): EncodedEvent {
  return createEvent({
    type: 'genesis',
    group: '',
    author: 'author-ana',
    ts: TS,
    body: { name: 'Riverside Tenants', founder: 'Ana', title, atoms: ['Quiet after 10pm.'] },
  });
}

function join(founding: EncodedEvent, name: string): EncodedEvent {
  return createEvent({
    type: 'join',
    group: founding.id,
    author: `author-${name.toLowerCase()}`,
    ts: TS,
    body: { name },
  });
}

/** A store holding one group, and a sync loop through `fake`. */
async function setUp(fake: FakeRelay, name = 'ana'): Promise<{ store: Store; sync: Sync }> {
  const store = await openStore(name);
  if ((await store.getGroup(GROUP)) === undefined) {
    await store.addGroup(newGroup(GROUP));
  }
  const sync = createSync({ store, relay: createRelay({ fetch: fake.fetch }), clock: () => TS });
  syncs.push(sync);
  return { store, sync };
}

function wrapperFor(services: GroupServices): (props: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }) {
    return <GroupServicesContext value={services}>{children}</GroupServicesContext>;
  };
}

describe('useGroup', () => {
  it('folds relay records only, and lists outbox events as pending', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const founding = genesis();
    const benJoins = join(founding, 'Ben');
    await store.enqueue(GROUP, founding.bytes);
    await sync.syncOnce();
    await store.enqueue(GROUP, benJoins.bytes);

    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });

    await waitFor(() => {
      expect(result.current.state?.title).toBe('House rules');
    });
    expect(result.current.state?.members.map((member) => member.name)).toEqual(['Ana']);
    expect(result.current.pending.map((parsed) => parsed.id)).toEqual([benJoins.id]);
    expect(result.current.pending[0]?.event.type).toBe('join');
  });

  it('moves an event from pending into the folded state once the relay has it', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const founding = genesis();
    await store.enqueue(GROUP, founding.bytes);
    await sync.syncOnce();
    await store.enqueue(GROUP, join(founding, 'Ben').bytes);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1);
    });

    await act(() => sync.syncOnce());

    await waitFor(() => {
      expect(result.current.state?.members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
    });
    expect(result.current.pending).toEqual([]);
  });

  it('leaves bytes that are not an event out of pending', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    await store.enqueue(GROUP, new Uint8Array([1, 2, 3]));

    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });

    await waitFor(() => {
      expect(result.current.state).not.toBeNull();
    });
    expect(result.current.pending).toEqual([]);
  });

  it('reports when the last sync succeeded, and whether the relay is reachable', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.state).not.toBeNull();
    });
    const before = { ...result.current };

    await act(() => sync.syncOnce());
    await waitFor(() => {
      expect(result.current.lastSyncAt).toBe(TS);
    });
    fake.offline = true;
    await act(() => sync.syncOnce());
    const offline = result.current.reachable;
    fake.offline = false;
    await act(() => sync.syncOnce());

    expect(before).toMatchObject({ lastSyncAt: null, reachable: true });
    expect(offline).toBe(false);
    expect(result.current.reachable).toBe(true);
  });

  it('brings the group and its Document back after a reload with the network off', async () => {
    const fake = createFakeRelay();
    const first = await setUp(fake);
    await first.store.enqueue(GROUP, genesis().bytes);
    await first.sync.syncOnce();
    first.store.close();
    fake.offline = true;

    const { store, sync } = await setUp(fake);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await act(() => sync.syncOnce());

    await waitFor(() => {
      expect(result.current.state?.atoms.map((atom) => atom.text)).toEqual(['Quiet after 10pm.']);
    });
    expect(result.current).toMatchObject({ lastSyncAt: TS, reachable: false });
  });

  it('has no state for a group the device is not in', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const getGroup = vi.spyOn(store, 'getGroup');

    const { result } = renderHook(() => useGroup('elsewhere'), {
      wrapper: wrapperFor({ store, sync }),
    });

    await waitFor(() => {
      expect(getGroup).toHaveBeenCalledWith('elsewhere');
    });
    expect(result.current).toEqual({ state: null, pending: [], lastSyncAt: null, reachable: true });
  });

  it('reloads only when its own group changes', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    await store.addGroup(newGroup('other'));
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.state).not.toBeNull();
    });
    const getGroup = vi.spyOn(store, 'getGroup');

    await store.enqueue('other', genesis().bytes);
    const afterOther = getGroup.mock.calls.length;
    await store.enqueue(GROUP, genesis().bytes);

    expect(afterOther).toBe(0);
    expect(getGroup).toHaveBeenCalledTimes(1);
  });

  it('shows nothing of the previous group while the next one loads', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    await store.enqueue(GROUP, genesis().bytes);
    await sync.syncOnce();
    await store.addGroup(newGroup('other'));
    const { result, rerender } = renderHook(({ id }) => useGroup(id), {
      initialProps: { id: GROUP },
      wrapper: wrapperFor({ store, sync }),
    });
    await waitFor(() => {
      expect(result.current.state?.title).toBe('House rules');
    });

    rerender({ id: 'other' });
    const whileLoading = result.current.state;

    expect(whileLoading).toBeNull();
    await waitFor(() => {
      expect(result.current.state?.title).toBe('');
    });
  });

  it('keeps the newest read when an older one answers late', async () => {
    const reads: ((group: Group | undefined) => void)[] = [];
    let notify: (groupId: string) => void = () => undefined;
    const store: GroupServices['store'] = {
      getGroup: () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    const sync = { isReachable: () => true, subscribe: () => () => undefined };
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    act(() => {
      notify(GROUP);
    });

    await act(async () => {
      reads[1]?.(groupWith(genesis('Newer')));
      await Promise.resolve();
      reads[0]?.(groupWith(genesis('Older')));
      await Promise.resolve();
    });

    expect(result.current.state?.title).toBe('Newer');
  });

  it('keeps its last state when a read fails, and stops reading once unmounted', async () => {
    let fail = false;
    const getGroup = vi.fn(() =>
      fail ? Promise.reject(new Error('closed')) : Promise.resolve(groupWith(genesis())),
    );
    let notify: (groupId: string) => void = () => undefined;
    const unsubscribe = vi.fn();
    const store: GroupServices['store'] = {
      getGroup,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    };
    const sync = { isReachable: () => true, subscribe: () => () => undefined };
    const { result, unmount } = renderHook(() => useGroup(GROUP), {
      wrapper: wrapperFor({ store, sync }),
    });
    await waitFor(() => {
      expect(result.current.state?.title).toBe('House rules');
    });

    fail = true;
    await act(async () => {
      notify(GROUP);
      await Promise.resolve();
    });
    const afterFailure = result.current.state?.title;
    fail = false;
    notify(GROUP);
    unmount();
    await Promise.resolve();

    expect(afterFailure).toBe('House rules');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('needs a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => renderHook(() => useGroup(GROUP))).toThrow('GroupServicesContext');
  });
});

/** A group as Create group or Join would add it. */
function newGroup(groupId: string): NewGroup {
  return {
    groupId,
    mailbox: TEST_MAILBOX,
    secret: new Uint8Array(32),
    me: { author: 'author-ana', name: 'Ana' },
  };
}

/** A stored group whose log holds `event` at seq 1. */
function groupWith(event: EncodedEvent): Group {
  return {
    ...newGroup(GROUP),
    log: [{ seq: 1, received: 29_000_000, bytes: event.bytes }],
    cursor: 1,
    relayNow: 29_000_000,
    instance: 'relay',
    outbox: [],
    lastSyncAt: TS,
  };
}
