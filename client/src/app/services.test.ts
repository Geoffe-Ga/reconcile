import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from './services';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyToClipboard', () => {
  it('writes the text to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyToClipboard('https://reconcile.example/#/join/a.b');
    expect(writeText).toHaveBeenCalledWith('https://reconcile.example/#/join/a.b');
  });

  it('rejects, rather than throwing, where the browser has no clipboard', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyToClipboard('text')).rejects.toThrow(TypeError);
  });
});
