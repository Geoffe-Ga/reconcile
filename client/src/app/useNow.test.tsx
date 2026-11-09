import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TICK_MS, useNow } from './useNow';

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('reads the clock at once, then again on every tick until unmounted', () => {
    vi.useFakeTimers();
    let ms = 1_000;
    const clock = vi.fn(() => ms);
    const { result, unmount } = renderHook(() => useNow(clock));
    expect(result.current).toBe(1_000);

    ms = 61_000;
    act(() => {
      vi.advanceTimersByTime(TICK_MS);
    });
    expect(result.current).toBe(61_000);

    unmount();
    const reads = clock.mock.calls.length;
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(clock.mock.calls.length).toBe(reads);
  });
});
