import { describe, expect, it, vi } from 'vitest';

import { requestPersistence } from './persist';

describe('requestPersistence', () => {
  it('asks the browser to keep this site’s data, and says granted when it agrees', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    expect(await requestPersistence({ persist })).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('says denied when the browser may still clear it', async () => {
    expect(await requestPersistence({ persist: () => Promise.resolve(false) })).toBe('denied');
  });

  it('says unavailable, and never throws, when the browser can’t be asked', async () => {
    expect(await requestPersistence(undefined)).toBe('unavailable');
    expect(await requestPersistence({})).toBe('unavailable');
    expect(await requestPersistence({ persist: () => Promise.reject(new Error('no')) })).toBe(
      'unavailable',
    );
    const throws = () => {
      throw new Error('blocked');
    };
    expect(await requestPersistence({ persist: throws })).toBe('unavailable');
  });

  it('asks the real browser by default', async () => {
    // jsdom has no StorageManager, so the default reads as unavailable.
    expect(await requestPersistence()).toBe('unavailable');
  });
});
