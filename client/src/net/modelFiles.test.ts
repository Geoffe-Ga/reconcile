import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../crypto/hash';
import { fetchPinned, MODEL_DOWNLOAD_BYTES, modelUrl, PinMismatchError } from './modelFiles';
import { MODEL_FILES, type PinnedFile } from './modelPins';

const BYTES = new TextEncoder().encode('a tiny stand-in for a model file');

/** `bytes`' SHA-256 in lowercase hex. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PIN: PinnedFile = { file: 'tiny-0123abcd.onnx', sha256: hexOf(BYTES), bytes: BYTES.length };

/** A fetch that answers every request with `body` and `status`, recording each. */
function answering(body: Uint8Array, status = 200) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(body.slice(), { status })),
  );
}

describe('modelUrl (#476)', () => {
  it('puts a pinned file under /models/ on our own origin', () => {
    expect(modelUrl(PIN)).toBe('/models/tiny-0123abcd.onnx');
    expect(modelUrl(MODEL_FILES.model)).toBe('/models/all-MiniLM-L6-v2-q8-afdb6f1a.onnx');
  });

  it.each(['../secret', 'a/b.onnx', 'https://elsewhere.example/x.onnx', '', '.', '..'])(
    'refuses a name that could reach anything else: %j',
    (file) => {
      expect(() => modelUrl({ ...PIN, file })).toThrow(/not a model file name/);
    },
  );
});

describe('fetchPinned (#476)', () => {
  it('fetches the file from our own origin, follows no redirect, and hands back its bytes', async () => {
    const fetchFile = answering(BYTES);

    const got = await fetchPinned(PIN, fetchFile);

    expect(Array.from(got)).toEqual(Array.from(BYTES));
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith('/models/tiny-0123abcd.onnx', {
      credentials: 'same-origin',
      redirect: 'error',
    });
  });

  it('refuses a file whose hash doesn’t match, though its size does', async () => {
    const tampered = BYTES.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;

    const refused = fetchPinned(PIN, answering(tampered));

    await expect(refused).rejects.toBeInstanceOf(PinMismatchError);
    await expect(refused).rejects.toThrow(
      'The model file tiny-0123abcd.onnx isn’t the one this version pins.',
    );
  });

  it('refuses a file of the wrong size without hashing it', async () => {
    await expect(fetchPinned(PIN, answering(BYTES.subarray(1)))).rejects.toBeInstanceOf(
      PinMismatchError,
    );
  });

  it('fails plainly when the server doesn’t send the file', async () => {
    const refused = fetchPinned(PIN, answering(new Uint8Array(), 404));
    await expect(refused).rejects.toThrow('The model file tiny-0123abcd.onnx couldn’t be fetched.');
    await expect(refused).rejects.not.toBeInstanceOf(PinMismatchError);
  });

  it('uses the browser’s fetch when it is handed none', async () => {
    const fetchFile = answering(BYTES);
    vi.stubGlobal('fetch', fetchFile);
    try {
      expect(Array.from(await fetchPinned(PIN))).toEqual(Array.from(BYTES));
      expect(fetchFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the pinned files (#476)', () => {
  it('pins three files, each named for its hash, with a source and a license that fit ADR-0024', () => {
    for (const pin of Object.values(MODEL_FILES)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.file).toContain(`-${pin.sha256.slice(0, 8)}.`);
      expect(['Apache-2.0', 'MIT']).toContain(pin.license);
      expect(pin.source).toMatch(/^(https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/|npm:)/);
    }
  });

  it('adds up to what the reader is told before the download, inside ADR-0080 §8’s 60 MB', () => {
    expect(MODEL_DOWNLOAD_BYTES).toBe(22_972_370 + 711_661 + 14_848_852);
    expect(MODEL_DOWNLOAD_BYTES).toBeLessThan(60_000_000);
  });
});
