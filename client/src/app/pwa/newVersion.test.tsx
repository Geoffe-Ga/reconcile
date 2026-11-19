import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createNewVersion, useNewVersionReady } from './newVersion';

describe('createNewVersion', () => {
  it('starts with nothing waiting', () => {
    expect(createNewVersion().ready()).toBe(false);
  });

  it('holds that a new version is waiting once told, and tells each listener once', () => {
    const signal = createNewVersion();
    const listener = vi.fn();
    signal.subscribe(listener);
    signal.markWaiting();
    signal.markWaiting();
    expect(signal.ready()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops telling a listener that unsubscribed', () => {
    const signal = createNewVersion();
    const listener = vi.fn();
    const unsubscribe = signal.subscribe(listener);
    unsubscribe();
    signal.markWaiting();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('useNewVersionReady', () => {
  it('is false without a signal, as in development and most tests', () => {
    const { result } = renderHook(() => useNewVersionReady(undefined));
    expect(result.current).toBe(false);
  });

  it('turns true when the worker reports a new version waiting', () => {
    const signal = createNewVersion();
    const { result } = renderHook(() => useNewVersionReady(signal));
    expect(result.current).toBe(false);
    act(() => {
      signal.markWaiting();
    });
    expect(result.current).toBe(true);
  });

  it('is true at once when a new version was already waiting', () => {
    const signal = createNewVersion();
    signal.markWaiting();
    const { result } = renderHook(() => useNewVersionReady(signal));
    expect(result.current).toBe(true);
  });
});
