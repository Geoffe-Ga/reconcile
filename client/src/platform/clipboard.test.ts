import { describe, expect, it, vi } from 'vitest';

import { clipboardReader, isTouch } from './clipboard';

describe('clipboardReader', () => {
  it('reads the clipboard’s text through the browser, once each time it’s called', async () => {
    const readText = vi.fn(() => Promise.resolve('https://reconcile.example/#join/abc'));
    const read = clipboardReader({ readText });

    expect(readText).not.toHaveBeenCalled();
    expect(await read?.()).toBe('https://reconcile.example/#join/abc');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('is null where the browser has no way to read text', () => {
    expect(clipboardReader(undefined)).toBeNull();
    expect(clipboardReader({})).toBeNull();
  });

  it('passes a refusal on, so the caller can stop offering Paste', async () => {
    const read = clipboardReader({ readText: () => Promise.reject(new Error('NotAllowedError')) });

    await expect(read?.()).rejects.toThrow('NotAllowedError');
  });

  it('asks the real browser by default', () => {
    // jsdom has no Clipboard until user-event installs one, so the default reads as none.
    expect(clipboardReader()).toBeNull();
  });
});

describe('isTouch', () => {
  it('says whether the main pointer is coarse, as a touch screen’s is', () => {
    const coarse = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }));
    const fine = vi.fn(() => ({ matches: false }));

    expect(isTouch(coarse)).toBe(true);
    expect(coarse).toHaveBeenCalledWith('(pointer: coarse)');
    expect(isTouch(fine)).toBe(false);
  });

  it('says no where the browser can’t be asked', () => {
    expect(isTouch(undefined)).toBe(false);
  });

  it('asks the real browser by default', () => {
    // jsdom has no matchMedia, so the default reads as no touch screen.
    expect(isTouch()).toBe(false);
  });
});
