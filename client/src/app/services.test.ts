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

  it('hands text still on its way to the clipboard as a promise, so the write starts at the tap', async () => {
    const write = vi.fn((items: ClipboardItem[]) =>
      Promise.all(items.map((item) => item.getType('text/plain'))).then(() => undefined),
    );
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { write, writeText } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Promise<Blob>>) {}
        getType(type: string): Promise<Blob> {
          return this.items[type] ?? Promise.reject(new Error(type));
        }
      },
    );
    let ready: (link: string) => void = () => undefined;
    const link = new Promise<string>((resolve) => {
      ready = resolve;
    });

    const copying = copyToClipboard(link);
    expect(write).toHaveBeenCalledTimes(1);
    ready('https://reconcile.example/#join/seed');
    await copying;

    const [items] = write.mock.calls[0] ?? [[]];
    const blob = await items[0]?.getType('text/plain');
    expect(await blob?.text()).toBe('https://reconcile.example/#join/seed');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies nothing when text on its way never arrives', async () => {
    const write = vi.fn((items: ClipboardItem[]) =>
      Promise.all(items.map((item) => item.getType('text/plain'))).then(() => undefined),
    );
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Promise<Blob>>) {}
        getType(type: string): Promise<Blob> {
          return this.items[type] ?? Promise.reject(new Error(type));
        }
      },
    );

    await expect(copyToClipboard(Promise.reject(new Error('offline')))).rejects.toThrow('offline');
  });

  it('waits for the text, then writes it, where the browser has no ClipboardItem', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('ClipboardItem', undefined);
    await copyToClipboard(Promise.resolve('later'));
    expect(writeText).toHaveBeenCalledWith('later');
  });

  it('rejects, rather than throwing, where the browser has no clipboard', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyToClipboard('text')).rejects.toThrow(TypeError);
  });
});
