import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../crypto/hash';
import { fetchPinned, MODEL_DOWNLOAD_BYTES, modelUrl, PinMismatchError } from './modelFiles';
import {
  BEDFELLOWS_FILES,
  MINILM_TOXIC_JIGSAW,
  MODEL_FILES,
  type PinnedFile,
  SERVED_FILES,
  servedFiles,
  SHELF_CLASSIFIER,
  STANCE_MODEL,
  type StanceModel,
} from './modelPins';

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

describe('the stance model’s files (#478)', () => {
  it('pins none: no candidate met ADR-0080 §8 on tune, so the judge is off and no device downloads one', () => {
    expect(STANCE_MODEL).toBeNull();
    expect(SERVED_FILES).toEqual(Object.values(MODEL_FILES));
  });

  it('serves a pinned stance model’s files beside the embedder’s, each file once', () => {
    const network = {
      file: 'nli-q8-00000000.onnx',
      sha256: '0'.repeat(64),
      bytes: 1,
      source: 'https://example.invalid/nli.onnx',
      license: 'MIT',
    };
    const stance: StanceModel = {
      files: { model: network, tokenizer: MODEL_FILES.tokenizer, runtime: MODEL_FILES.runtime },
      labels: { entailment: 0, contradiction: 2 },
    };

    expect(servedFiles(stance)).toEqual([...Object.values(MODEL_FILES), network]);
    expect(servedFiles(null)).toEqual(Object.values(MODEL_FILES));
  });
});

describe('the shelf classifier’s files (#493; ADR-0082)', () => {
  it('pins none: the classifier is built behind a flag that stays off until the re-measure, so no device downloads it', () => {
    expect(SHELF_CLASSIFIER).toBeNull();
    expect(SERVED_FILES).toEqual(Object.values(MODEL_FILES));
  });

  it('records the measured model: MiniLMv2-toxic-jigsaw, 8-bit, about 23.6 MB, Apache-2.0, at the spike’s revision', () => {
    const { model, tokenizer, runtime } = MINILM_TOXIC_JIGSAW.files;

    expect(model.sha256.slice(0, 8)).toBe('bcd9dfb4');
    expect(model.sha256.slice(-4)).toBe('69a0');
    expect(model.bytes).toBe(22_864_978);
    expect(tokenizer.bytes).toBe(711_649);
    expect(model.bytes + tokenizer.bytes).toBe(23_576_627);
    expect(runtime).toBe(MODEL_FILES.runtime);
    for (const pin of [model, tokenizer]) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.file).toContain(`-${pin.sha256.slice(0, 8)}.`);
      expect(pin.license).toBe('Apache-2.0');
      expect(pin.source).toMatch(
        /^https:\/\/huggingface\.co\/minuva\/MiniLMv2-toxic-jigsaw-onnx\/resolve\/c035f27b6a6d68770f8069a4829f1715a48b8d51\//,
      );
    }
  });

  it('reads the narrow rule’s two labels where the model’s config puts them: threat 3, identity_hate 5', () => {
    expect(MINILM_TOXIC_JIGSAW.labels).toEqual({ threat: 3, identityHate: 5 });
  });

  it('serves a pinned classifier’s files after Bedfellows’, each once, the shared runtime included', () => {
    expect(servedFiles(null, MINILM_TOXIC_JIGSAW)).toEqual([
      ...Object.values(MODEL_FILES),
      MINILM_TOXIC_JIGSAW.files.model,
      MINILM_TOXIC_JIGSAW.files.tokenizer,
    ]);
  });

  it('never counts the classifier in what a reader is told Bedfellows downloads', () => {
    expect(BEDFELLOWS_FILES).toEqual(servedFiles(STANCE_MODEL));
    expect(MODEL_DOWNLOAD_BYTES).toBe(BEDFELLOWS_FILES.reduce((sum, pin) => sum + pin.bytes, 0));
  });
});
