/** `usePersonalList` (#93): Personal's list, read once when it opens. */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PersonalDocument } from '../store/personal';
import { usePersonalList } from './usePersonalList';

const STATEMENT: PersonalDocument = {
  id: 'Q2FuYXJ5IHN0YXRlbWVudA',
  title: 'My mission statement',
  text: '',
  createdAt: 1,
  updatedAt: 1,
};

describe('usePersonalList', () => {
  it('is null until the store answers, then the store’s list', async () => {
    const store = { listPersonal: vi.fn(() => Promise.resolve([STATEMENT])) };
    const { result } = renderHook(() => usePersonalList(store));

    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).toEqual([STATEMENT]);
    });
    expect(store.listPersonal).toHaveBeenCalledOnce();
  });

  it('lists none when the read fails, so Personal still offers a new Document', async () => {
    const store = { listPersonal: () => Promise.reject(new Error('IndexedDB refused.')) };
    const { result } = renderHook(() => usePersonalList(store));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('ignores an answer that comes after Personal has closed', async () => {
    let answer: (list: PersonalDocument[]) => void = () => undefined;
    const store = {
      listPersonal: () =>
        new Promise<PersonalDocument[]>((resolve) => {
          answer = resolve;
        }),
    };
    const { result, unmount } = renderHook(() => usePersonalList(store));
    unmount();

    answer([STATEMENT]);
    await Promise.resolve();

    expect(result.current).toBeNull();
  });
});
