import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SENT_CHANGED, type SentApplication } from '../store/applications';
import { useSentApplications } from './useSent';

/** An application this device sent. */
const sent = (id: string): SentApplication => ({
  id,
  door: 'door',
  groupName: 'Riverside Tenants',
  seed: new Uint8Array(32),
  replyKey: new Uint8Array(32),
  sentAt: 1,
});

/** A store whose `listSent` answers from `lists` in turn, and whose listeners a test calls. */
function storeOf(...lists: (SentApplication[] | Error)[]) {
  const listeners = new Set<(changed: string) => void>();
  const listSent = vi.fn(() => {
    const next = lists.shift() ?? [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const subscribe = vi.fn((listener: (changed: string) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const tell = (changed: string) => {
    act(() => {
      for (const listener of listeners) listener(changed);
    });
  };
  return { store: { listSent, subscribe }, listSent, tell, listeners };
}

describe('useSentApplications (#121)', () => {
  it('is null until the store answers, then the list, read again when sent applications change', async () => {
    const { store, listSent, tell } = storeOf([sent('a')], [sent('a'), sent('b')]);
    const { result } = renderHook(() => useSentApplications(store));
    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current?.map((application) => application.id)).toEqual(['a']);
    });
    tell('some-group-id');
    expect(listSent).toHaveBeenCalledTimes(1);
    tell(SENT_CHANGED);
    await waitFor(() => {
      expect(result.current?.map((application) => application.id)).toEqual(['a', 'b']);
    });
  });

  it('keeps the last list when a read fails, and stops listening once gone', async () => {
    const { store, tell, listeners } = storeOf([sent('a')], new Error('closed'));
    const { result, unmount } = renderHook(() => useSentApplications(store));
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    tell(SENT_CHANGED);
    await waitFor(() => {
      expect(store.listSent).toHaveBeenCalledTimes(2);
    });
    expect(result.current).toHaveLength(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
