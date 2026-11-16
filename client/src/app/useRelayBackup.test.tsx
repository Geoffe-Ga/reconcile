import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openStore, type RelayBackupState, type Store } from '../store/db';
import { freshIndexedDBPerTest } from '../test/idb';
import { useRelayBackupStatus } from './useRelayBackup';

freshIndexedDBPerTest();

const KEY = new Uint8Array(32).fill(4);
const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

async function store(): Promise<Store> {
  const made = await openStore('relay-backup-status');
  opened.push(made);
  return made;
}

describe('useRelayBackupStatus', () => {
  it('is null until the store answers, then off while the device keeps no key', async () => {
    const empty = await store();
    const hook = renderHook(() => useRelayBackupStatus(empty));

    expect(hook.result.current).toBeNull();
    await waitFor(() => {
      expect(hook.result.current).toEqual({ kind: 'off' });
    });
  });

  it('follows the store: waiting once a key is kept, saved once an upload is recorded', async () => {
    const held = await store();
    const { result } = renderHook(() => useRelayBackupStatus(held));
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'off' });
    });

    await act(() => held.setRelayBackupKey(KEY));
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'waiting' });
    });
    await act(async () => {
      await held.updateRelayBackup(KEY, { uploadedAt: 7 });
    });

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'saved', at: 7 });
    });
  });

  it('reads retired once a later choice on another device retired the key (#272)', async () => {
    const held = await store();
    await held.setRelayBackupKey(KEY);
    const { result } = renderHook(() => useRelayBackupStatus(held));
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'waiting' });
    });

    await act(async () => {
      await held.retireRelayBackup(KEY, 5);
    });

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'retired', at: 5 });
    });
  });

  it('keeps the last status when a read fails, and only the newest read counts', async () => {
    const listeners = new Set<(id: string) => void>();
    const answers: ((state: RelayBackupState | undefined) => void)[] = [];
    const failing = { fail: false };
    const fake = {
      getRelayBackup: vi.fn(
        () =>
          new Promise<RelayBackupState | undefined>((resolve, reject) => {
            if (failing.fail) reject(new Error('IndexedDB refused the read.'));
            else answers.push(resolve);
          }),
      ),
      getRelayBackupRetiredAt: () => Promise.resolve(undefined),
      subscribe: (listener: (id: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const state = { key: KEY, digest: null, checkedDay: null, uploadedAt: null, tooLarge: false };
    const { result, unmount } = renderHook(() => useRelayBackupStatus(fake));
    const notify = () => {
      for (const listener of listeners) listener('relay-backup');
    };

    act(notify);
    await act(async () => {
      answers[1]?.({ ...state, uploadedAt: 9 });
      answers[0]?.(undefined);
      await Promise.resolve();
    });
    expect(result.current).toEqual({ kind: 'saved', at: 9 });
    failing.fail = true;
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(result.current).toEqual({ kind: 'saved', at: 9 });
    unmount();
    expect(listeners.size).toBe(0);
  });
});
