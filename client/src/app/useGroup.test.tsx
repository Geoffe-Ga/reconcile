import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import type { SignedEvent } from '../engine/event';
import { createRelay } from '../net/relay';
import { openStore } from '../store/db';
import { eventIdOf } from '../store/eventId';
import type { Group, NewGroup, Store } from '../store/db';
import { createSync } from '../store/sync';
import type { Sync } from '../store/sync';
import { createFakeRelay } from '../test/fakeRelay';
import type { FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
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

function genesis(title = 'House rules'): SignedEvent {
  return signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      title,
      atoms: ['Quiet after 10pm.'],
      kx: testKx('ana').kx,
    },
  });
}

function join(founding: SignedEvent, name: string): SignedEvent {
  return signedAs(name.toLowerCase(), {
    type: 'join',
    group: founding.id,
    ts: TS,
    body: { name, kx: testKx(name.toLowerCase()).kx },
  });
}

/** A store holding one group, and a sync loop through `fake`. */
async function setUp(fake: FakeRelay, name = 'ana'): Promise<{ store: Store; sync: Sync }> {
  const store = await openStore(name);
  if ((await store.getGroup(GROUP)) === undefined) {
    await store.addGroup(newGroup(GROUP));
  }
  const relay = createRelay({ fetch: fake.fetch });
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
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
    await store.enqueue(GROUP, founding.record);
    await sync.syncOnce();
    await store.enqueue(GROUP, benJoins.record);

    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });

    await waitFor(() => {
      expect(result.current.state?.title).toBe('House rules');
    });
    expect(result.current.state?.members.map((member) => member.name)).toEqual(['Ana']);
    expect(result.current.pending.map((parsed) => parsed.id)).toEqual([benJoins.id]);
    expect(result.current.pending[0]?.event.type).toBe('join');
    // The relay records it folded, for what reads the log itself, such as a late ballot's notice.
    expect(result.current.log.map((record) => record.seq)).toEqual([1]);
    expect(Array.from(result.current.log[0]?.bytes ?? [])).toEqual(Array.from(founding.record));
  });

  it('moves an event from pending into the folded state once the relay has it', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const founding = genesis();
    await store.enqueue(GROUP, founding.record);
    await sync.syncOnce();
    await store.enqueue(GROUP, join(founding, 'Ben').record);
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
    expect(result.current.relayNow).toBe(fake.minute);
    fake.offline = true;
    await act(() => sync.syncOnce());
    const offline = result.current.reachable;
    fake.offline = false;
    await act(() => sync.syncOnce());

    expect(before).toMatchObject({ lastSyncAt: null, relayNow: null, reachable: true });
    expect(offline).toBe(false);
    expect(result.current.reachable).toBe(true);
  });

  it('brings the group and its Document back after a reload with the network off', async () => {
    const fake = createFakeRelay();
    const first = await setUp(fake);
    await first.store.enqueue(GROUP, genesis().record);
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
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current).toEqual({
      state: null,
      log: [],
      pending: [],
      keyChange: null,
      lastSyncAt: null,
      relayNow: null,
      reachable: true,
      me: null,
      missingHistory: false,
      leaving: false,
      suggestBackup: false,
      loaded: true,
      cleared: null,
      coalitions: [],
    });
  });

  it('says the group is leaving once its leave is queued, with the leave pending', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.leaving).toBe(false);

    const leave = signedAs('ana', { type: 'leave', group: GROUP, ts: TS, body: {} });
    await act(() => store.markLeaving(GROUP, leave.record));

    await waitFor(() => {
      expect(result.current.leaving).toBe(true);
    });
    expect(result.current.pending.map(({ event }) => event.type)).toEqual(['leave']);
  });

  it('suggests a backup for a group no backup holds, and none once it is a read-only archive (#108)', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    await store.enqueue(GROUP, genesis().record);
    await sync.syncOnce();
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.suggestBackup).toBe(true);
    });

    await act(() => store.markArchived(GROUP, 'dissolved'));

    await waitFor(() => {
      expect(result.current.suggestBackup).toBe(false);
    });
    expect(result.current.state?.title).toBe('House rules');
  });

  it('says this device missed the group’s new key, and nothing of it once the group is a read-only archive (#98, #108)', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const founding = genesis();
    const group = founding.id;
    const leave = signedAs('cal', { type: 'leave', group, ts: TS, body: {} });
    const wraps = { [authorOf('ana')]: 'AA', [authorOf('ben')]: 'AA' };
    const rotate = signedAs('ben', {
      type: 'key-rotate',
      group,
      ts: TS,
      body: { epoch: 1, commit: 'rotation-commit-of-this-testAAAAAAAAAAAAAAA', wraps },
    });
    const events = [founding, join(founding, 'Ben'), join(founding, 'Cal'), leave, rotate];
    const records = events.map(({ record }, i) => ({
      seq: i + 1,
      received: 100 + i,
      bytes: record,
    }));
    const pull = { records, cursor: records.length, relayNow: 200, instance: 'i', lastSyncAt: TS };
    await store.applyPull(GROUP, pull, eventIdOf);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    await waitFor(() => {
      expect(result.current.keyChange).toBe('missed');
    });
    expect(result.current.state?.epoch).toBe(1);

    // #115 archives a removed member's copy so; a dissolved group's home shows its archive instead.
    await act(() => store.markArchived(GROUP, 'dissolved'));

    await waitFor(() => {
      expect(result.current.keyChange).toBeNull();
    });
    expect(result.current.state?.epoch).toBe(1);
  });

  it('says who this device is in the group, and hands the screens no secret', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });
    const atFirst = { ...result.current };

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(atFirst).toMatchObject({ me: null, missingHistory: false, loaded: false });
    expect(result.current.me).toEqual({ author: authorOf('ana'), name: 'Ana' });
    expect(Object.values(result.current).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it('says when some history may be missing, until a merge clears it', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    const pull = { records: [], cursor: 0, relayNow: 1, instance: 'i' };
    await store.applyPull(GROUP, { ...pull, lastSyncAt: TS }, () => null);
    await store.applyPull(GROUP, { ...pull, lastSyncAt: TS + 29 * 86_400_000 }, () => null);
    const { result } = renderHook(() => useGroup(GROUP), { wrapper: wrapperFor({ store, sync }) });

    await waitFor(() => {
      expect(result.current.missingHistory).toBe(true);
    });
    await store.mergeLog(GROUP, [], () => null);
    await waitFor(() => {
      expect(result.current.missingHistory).toBe(false);
    });
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

    await store.enqueue('other', genesis().record);
    const afterOther = getGroup.mock.calls.length;
    await store.enqueue(GROUP, genesis().record);

    expect(afterOther).toBe(0);
    expect(getGroup).toHaveBeenCalledTimes(1);
  });

  it('shows nothing of the previous group while the next one loads', async () => {
    const fake = createFakeRelay();
    const { store, sync } = await setUp(fake);
    await store.enqueue(GROUP, genesis().record);
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
    const whileLoading = result.current;

    expect(whileLoading).toMatchObject({ state: null, me: null, loaded: false });
    await waitFor(() => {
      expect(result.current.state?.title).toBe('');
    });
  });

  it('keeps the newest read when an older one answers late', async () => {
    const reads: ((group: Group | undefined) => void)[] = [];
    const listeners: ((groupId: string) => void)[] = [];
    const notify = (groupId: string) => {
      for (const listener of listeners) listener(groupId);
    };
    const store: GroupServices['store'] = {
      getGroup: () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
      listCoalitions: () => Promise.resolve([]),
      subscribe: (listener) => {
        listeners.push(listener);
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
    const listeners: ((groupId: string) => void)[] = [];
    const notify = (groupId: string) => {
      for (const listener of listeners) listener(groupId);
    };
    const unsubscribe = vi.fn();
    const store: GroupServices['store'] = {
      getGroup,
      listCoalitions: () => Promise.resolve([]),
      subscribe: (listener) => {
        listeners.push(listener);
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
    // Once for the group, once for the coalitions it reads beside it (#114).
    expect(unsubscribe).toHaveBeenCalledTimes(2);
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
    secret: new Uint8Array(32),
    signingKey: testKeys('ana').secretKey,
    kxKey: testKx('ana').kxKey,
    me: { author: authorOf('ana'), name: 'Ana' },
  };
}

/** A stored group whose log holds `event` at seq 1. */
function groupWith(event: SignedEvent): Group {
  return {
    ...newGroup(GROUP),
    log: [{ seq: 1, received: 29_000_000, bytes: event.record }],
    cursor: 1,
    relayNow: 29_000_000,
    instance: 'relay',
    outbox: [],
    lastSyncAt: TS,
  };
}
