import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { openStore, type RecoveryPlan, type Store } from '../store/db';
import { freshIndexedDBPerTest } from '../test/idb';
import { useRecovery } from './useRecovery';

freshIndexedDBPerTest();

const KEY = new Uint8Array(32).fill(4);
const SPLIT = 'c3BsaXQtb2YtYS10ZXN0LQ';
const PLAN: RecoveryPlan = {
  split: SPLIT,
  t: 2,
  n: 3,
  contacts: [],
  chosenAt: 1_762_650_000_000,
  retired: [],
};

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

async function store(): Promise<Store> {
  const made = await openStore('recovery-view');
  opened.push(made);
  return made;
}

describe('useRecovery', () => {
  it('says the contacts were chosen elsewhere only while the device holds a split key and no list (#272)', async () => {
    const held = await store();
    const { result } = renderHook(() => useRecovery(held));
    await waitFor(() => {
      expect(result.current?.elsewhere).toBe(false);
    });

    // A key with no split, as one made before #272, says nothing of a choice elsewhere.
    await act(() => held.setRelayBackupKey(KEY));
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.elsewhere).toBe(false);

    // A key a link or a backup file brought, with its split, does.
    await act(() => held.setRelayBackupKey(KEY, SPLIT));
    await waitFor(() => {
      expect(result.current?.elsewhere).toBe(true);
    });
    expect(result.current?.status).toBeNull();

    // Once this device keeps a list of its own, its list speaks for itself.
    await act(() => held.setRecoveryPlan(PLAN));
    await waitFor(() => {
      expect(result.current?.elsewhere).toBe(false);
    });
    expect(result.current?.status).not.toBeNull();
  });
});
