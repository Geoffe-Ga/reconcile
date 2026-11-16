/**
 * The recovery alert as Start and group home read it (#118): after the first
 * read, only the group a change names is read again, an older read that
 * answers last is dropped, a change heard before the first read still
 * counts, and nothing re-renders for a change that holds no new alert.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newRecoveryKeys, recoveryCheck, recoveryCode, recoveryNumber } from '../crypto/recovery';
import { approveRecovery } from '../recovery/holder';
import { type Group, RECOVERY_CHANGED, type Store } from '../store/db';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { keyOf, recoveryWorld } from '../test/recovery';
import { type RecoveryAlertServices, useRecoveryAlert } from './useRecoveryAlert';

freshIndexedDBPerTest();

const DEVICES = { timeout: 60_000 };

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Ana's world, with Ben's alert to Ana in Riverside Tenants already on Ana's device. */
async function anaWithAlert() {
  const world = await recoveryWorld(createFakeRelay());
  opened.push(...world.devices);
  const request = newRecoveryKeys();
  const code = recoveryCode(request);
  const person = await keyOf(world.ana, world.groupId);
  await approveRecovery(world.ben.services, {
    code,
    groupId: world.groupId,
    person,
    check: recoveryCheck(code),
    number: recoveryNumber(request.secretKey),
  });
  await world.ana.services.sync.syncOnce();
  return world;
}

/** A promise and the way to settle it, for a read the test answers when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** `store` with its reads and listeners in the test's hands. */
function heldStore(store: Store) {
  const listeners = new Set<(id: string) => void>();
  const reads: { groupId: string; answer: (group: Group | undefined) => void }[] = [];
  const list = deferred<Group[]>();
  const view: RecoveryAlertServices['store'] = {
    enqueueAll: (groupId, records) => store.enqueueAll(groupId, records),
    listGroups: () => list.promise,
    getGroup: (groupId) => {
      const read = deferred<Group | undefined>();
      reads.push({ groupId, answer: read.resolve });
      return read.promise;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const hear = (id: string) => {
    act(() => {
      for (const listener of listeners) listener(id);
    });
  };
  return { view, reads, hear, list: () => store.listGroups(), answerList: list.resolve };
}

describe('useRecoveryAlert', DEVICES, () => {
  it('shows the alert, and reads only the group a change names; other changes read nothing', async () => {
    const world = await anaWithAlert();
    const { store } = world.ana.services;
    const getGroup = vi.spyOn(store, 'getGroup');
    const listGroups = vi.spyOn(store, 'listGroups');
    const services = { ...world.ana.services, store };
    const { result } = renderHook(() => useRecoveryAlert(services));
    await waitFor(() => {
      expect(result.current.summary?.kind).toBe('pending');
    });
    expect(listGroups).toHaveBeenCalledTimes(1);

    await act(() => store.markRecoverySeen(world.groupId, []));
    await waitFor(() => {
      expect(getGroup).toHaveBeenCalledWith(world.groupId);
    });
    await act(() => store.setRecoveryPlan({ ...emptyPlan() }));
    expect(listGroups).toHaveBeenCalledTimes(1);
    expect(getGroup.mock.calls.every(([id]) => id === world.groupId)).toBe(true);

    // Cancelling is a change to the group that shows: the card reads cancelled.
    await act(() => result.current.cancel());
    await waitFor(() => {
      expect(result.current.summary).toEqual({ kind: 'cancelled' });
    });
  });

  it('reads a change heard before the first read, drops an older read that answers last, and forgets a removed group', async () => {
    const world = await anaWithAlert();
    const held = heldStore(world.ana.services.store);
    const services = { ...world.ana.services, store: held.view };
    const { result } = renderHook(() => useRecoveryAlert(services));

    held.hear(world.groupId);
    held.hear(RECOVERY_CHANGED);
    expect(held.reads).toEqual([]);
    const groups = await held.list();
    await act(async () => {
      held.answerList(groups);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.summary?.kind).toBe('pending');
    });
    // The change heard before the first read is read once it has answered.
    expect(held.reads.map(({ groupId }) => groupId)).toEqual([world.groupId]);

    held.hear(world.groupId);
    const [older, newer] = held.reads.slice(-2);
    // The newer read says the group has gone; the older, answering last, is dropped.
    await act(async () => {
      newer?.answer(undefined);
      older?.answer(groups.find(({ groupId }) => groupId === world.groupId));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.summary).toBeNull();
    });
  });
});

/** A recovery plan with no one in it: a change that names no group. */
function emptyPlan() {
  return { split: 'split-of-a-hook-test', t: 2, n: 3, contacts: [], chosenAt: 0, retired: [] };
}
