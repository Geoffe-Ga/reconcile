/**
 * The shelf classifier (#493; ADR-0082): the narrow rule, the lazy, pinned
 * load, and the flags it puts in the steward's console.
 *
 * No test here holds hateful text (ADR-0082, Decision 5): the rule is tested
 * on synthetic score vectors, and the model on neutral sentences, with
 * stubbed outputs or the tiny model's meaningless ones.
 */
import { IDBObjectStore } from 'fake-indexeddb';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from '../crypto/hash';
import { fetchPinned, PinMismatchError } from '../net/modelFiles';
import {
  type ModelFileName,
  type PinnedFile,
  type ShelfClassifierModel,
  type SourcedFile,
} from '../net/modelPins';
import type { RuntimeFiles } from '../bedfellows/runtime';
import { ortWasm } from '../test/ortWasm';
import { tinyClassifierOnnx, tinyLogitsOf, TINY_VOCAB, tinyTokenizerJson } from '../test/tinyModel';
import {
  classifierLoader,
  entryText,
  FLAG_BAR,
  flagEntries,
  flags,
  shelfClassifier,
  type TextScorer,
  verdictOf,
} from './classify';

/** The real model's six outputs, in its order. */
const LABELS = ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate'] as const;
type Label = (typeof LABELS)[number];

/** Where the real model puts the narrow rule's two labels. */
const REAL_LABELS = { threat: 3, identityHate: 5 };

/** A synthetic score vector: each of the six labels at 0 but those `scores` names. */
function vector(scores: Partial<Record<Label, number>>): Float32Array {
  return Float32Array.from(LABELS, (label) => scores[label] ?? 0);
}

describe('verdictOf (#493): the narrow rule, threat or identity_hate at 0.5 or more', () => {
  it('flags at the bar and not below it', () => {
    expect(FLAG_BAR).toBe(0.5);
    expect(flags(verdictOf(vector({ threat: 0.5 }), REAL_LABELS))).toBe(true);
    expect(flags(verdictOf(vector({ threat: 0.4999 }), REAL_LABELS))).toBe(false);
    expect(flags(verdictOf(vector({ identity_hate: 0.5 }), REAL_LABELS))).toBe(true);
    expect(flags(verdictOf(vector({ identity_hate: 0.4999 }), REAL_LABELS))).toBe(false);
  });

  it('answers the higher of the two labels’ scores, the rule that gave it, and the clause it suggests', () => {
    expect(verdictOf(vector({ threat: 0.8, identity_hate: 0.6 }), REAL_LABELS)).toEqual({
      score: expect.closeTo(0.8, 6) as number,
      rule: 'threat',
      clause: 'C1',
    });
    expect(verdictOf(vector({ threat: 0.2, identity_hate: 0.9 }), REAL_LABELS)).toEqual({
      score: expect.closeTo(0.9, 6) as number,
      rule: 'identity-hate',
      clause: 'C1',
    });
  });

  it('never flags on the broad labels alone: rudeness and swearing aren’t the rule', () => {
    const broad = vector({ toxic: 0.99, severe_toxic: 0.99, obscene: 0.99, insult: 0.99 });
    expect(flags(verdictOf(broad, REAL_LABELS))).toBe(false);
  });

  it('reads a missing output as 0', () => {
    expect(verdictOf(new Float32Array(0), REAL_LABELS)).toEqual({
      score: 0,
      rule: 'threat',
      clause: 'C1',
    });
  });

  it('flags exactly when threat or identity_hate reaches the bar, whatever the other four say', () => {
    const score = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(fc.array(score, { minLength: 6, maxLength: 6 }), (scores) => {
        const verdict = verdictOf(Float32Array.from(scores), REAL_LABELS);
        const [threat, hate] = [Math.fround(scores[3] ?? 0), Math.fround(scores[5] ?? 0)];
        expect(flags(verdict)).toBe(threat >= FLAG_BAR || hate >= FLAG_BAR);
        expect(verdict.score).toBe(Math.max(threat, hate));
      }),
    );
  });
});

describe('entryText (#493)', () => {
  it('reads an entry’s title, then its text on the next line', () => {
    expect(entryText({ title: 'Potluck', text: 'Sunday at noon' })).toBe('Potluck\nSunday at noon');
  });

  it('reads the title alone when there is no text', () => {
    expect(entryText({ title: 'Potluck', text: '' })).toBe('Potluck');
  });
});

/** `bytes`' SHA-256 in lowercase hex. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The tiny classifier's three files (`src/test/tinyModel.ts`), by name. */
const TINY: Readonly<Record<ModelFileName, Uint8Array>> = {
  model: tinyClassifierOnnx(),
  tokenizer: new TextEncoder().encode(tinyTokenizerJson()),
  runtime: ortWasm(),
};

/** A pin for `files[name]`, named as real ones are. */
function pinOf(files: Readonly<Record<ModelFileName, Uint8Array>>, name: ModelFileName) {
  const sha = hexOf(files[name]);
  const pin: SourcedFile = {
    file: `tiny-${name}-${sha.slice(0, 8)}.bin`,
    sha256: sha,
    bytes: files[name].length,
    source: 'https://example.invalid/tiny',
    license: 'MIT',
  };
  return pin;
}

/** The tiny classifier as a shelf classifier, its first two outputs read as the rule's labels. */
const TINY_MODEL: ShelfClassifierModel = {
  files: {
    model: pinOf(TINY, 'model'),
    tokenizer: pinOf(TINY, 'tokenizer'),
    runtime: pinOf(TINY, 'runtime'),
  },
  labels: { threat: 0, identityHate: 1 },
};

/** The tiny model's files, with stubbed outputs read as the real model's are. */
const STUBBED: ShelfClassifierModel = { ...TINY_MODEL, labels: REAL_LABELS };

/** Every URL the tiny model's files are served at. */
const MODEL_URLS = Object.values(TINY_MODEL.files)
  .map((pin) => `/models/${pin.file}`)
  .sort();

/** A server holding `files` under the tiny pins' names, recording each request. */
function serving(files: Readonly<Record<ModelFileName, Uint8Array>> = TINY) {
  const byUrl = new Map(
    (Object.keys(files) as ModelFileName[]).map((name) => [
      `/models/${TINY_MODEL.files[name].file}`,
      files[name],
    ]),
  );
  const fetchFile = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url) => {
    const body = byUrl.get(url);
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body.slice()),
    );
  });
  return { fetchFile, fetchPin: (pin: PinnedFile) => fetchPinned(pin, fetchFile) };
}

/** A scorer that answers `table`'s vector for each text, else all zeros, recording each text. */
function scorerOf(table: Record<string, Partial<Record<Label, number>>>) {
  const read: string[] = [];
  const scorer: TextScorer = {
    scores: (text) => {
      read.push(text);
      return Promise.resolve(vector(table[text] ?? {}));
    },
  };
  return { scorer, read };
}

describe('classifierLoader (#493)', () => {
  it('is null while no classifier is pinned, and the app’s is: the flag is off, and nothing is fetched', () => {
    const { fetchFile, fetchPin } = serving();

    expect(classifierLoader(null, fetchPin)).toBeNull();
    expect(shelfClassifier).toBeNull();
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('fetches nothing until it is first asked', () => {
    const { fetchFile, fetchPin } = serving();
    const start = vi.fn();

    classifierLoader(TINY_MODEL, fetchPin, start);

    expect(fetchFile).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('fetches and checks the three files once, starts the model once, and classifies with it', async () => {
    const { fetchFile, fetchPin } = serving();
    const { scorer, read } = scorerOf({ 'Potluck on Sunday': { identity_hate: 0.7 } });
    const start = vi.fn<(files: RuntimeFiles) => Promise<TextScorer>>(() =>
      Promise.resolve(scorer),
    );
    const classifier = classifierLoader(STUBBED, fetchPin, start);

    const first = await classifier?.classify('Potluck on Sunday');
    const second = await classifier?.classify('Chess club needs new boards');

    expect(first).toEqual({
      score: expect.closeTo(0.7, 6) as number,
      rule: 'identity-hate',
      clause: 'C1',
    });
    expect(second).toEqual({ score: 0, rule: 'threat', clause: 'C1' });
    expect(read).toEqual(['Potluck on Sunday', 'Chess club needs new boards']);
    expect(start).toHaveBeenCalledTimes(1);
    const [files] = start.mock.calls[0] ?? [];
    expect(
      files === undefined ? [] : [files.model, files.tokenizer, files.runtime].map(hexOf),
    ).toEqual([TINY.model, TINY.tokenizer, TINY.runtime].map(hexOf));
    expect(fetchFile.mock.calls.map(([url]) => url).sort()).toEqual(MODEL_URLS);
  });

  it('refuses a file that doesn’t match its pin, and never starts the model', async () => {
    const tampered = TINY.model.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    const { fetchPin } = serving({ ...TINY, model: tampered });
    const start = vi.fn();

    await expect(
      classifierLoader(TINY_MODEL, fetchPin, start)?.classify('Potluck on Sunday'),
    ).rejects.toBeInstanceOf(PinMismatchError);
    expect(start).not.toHaveBeenCalled();
  });

  it('tries again on the next ask after a load fails', async () => {
    const { fetchFile, fetchPin } = serving();
    fetchFile.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })));
    const { scorer } = scorerOf({});
    const classifier = classifierLoader(TINY_MODEL, fetchPin, () => Promise.resolve(scorer));

    await expect(classifier?.classify('Potluck')).rejects.toThrow(/couldn’t be fetched/);
    await expect(classifier?.classify('Potluck')).resolves.toMatchObject({ score: 0 });
  });

  it('runs the real runtime on the pinned files, loaded only when first asked', async () => {
    const { fetchPin } = serving();
    const classifier = classifierLoader(TINY_MODEL, fetchPin);
    const tokens = ['[CLS]', 'our', 'chess', 'club', '[SEP]'];
    const logit = (i: number) =>
      tokens.reduce((sum, token) => sum + (tinyLogitsOf(TINY_VOCAB.indexOf(token))[i] ?? 0), 0) /
      tokens.length;
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

    const verdict = await classifier?.classify('Our chess club');

    expect(verdict?.score).toBeCloseTo(Math.max(sigmoid(logit(0)), sigmoid(logit(1))), 5);
  });
});

/** A shelf entry, as the console's view holds it. */
function entry(id: string, title: string, text = '') {
  return Object.freeze({ address: `addr-${id}`, id, title, text });
}

describe('flagEntries (#493)', () => {
  it('flags an entry over the bar and leaves the entries as they were, in their order', async () => {
    const { scorer } = scorerOf({ 'Stand-in for a flagged entry': { threat: 0.9 } });
    const classifier = classifierLoader(STUBBED, serving().fetchPin, () => Promise.resolve(scorer));
    const entries = Object.freeze([
      entry('d1', 'Stand-in for a flagged entry'),
      entry('d2', 'Potluck on Sunday'),
    ]);
    const before = structuredClone(entries);

    const flagged = classifier === null ? [] : await flagEntries(entries, classifier);

    expect(flagged).toEqual([{ address: 'addr-d1', id: 'd1', rule: 'threat', clause: 'C1' }]);
    expect(entries).toEqual(before);
  });

  it('names only the rule and the clause, never the score, and keeps the entries’ order', async () => {
    const { scorer, read } = scorerOf({
      'First\nfrom the Sunday group': { identity_hate: 0.6 },
      Second: { threat: 0.95 },
    });
    const classifier = {
      classify: (text: string) => scorer.scores(text).then((p) => verdictOf(p, REAL_LABELS)),
    };

    const flagged = await flagEntries(
      [entry('d1', 'First', 'from the Sunday group'), entry('d2', 'Second'), entry('d3', 'Third')],
      classifier,
    );

    expect(flagged).toEqual([
      { address: 'addr-d1', id: 'd1', rule: 'identity-hate', clause: 'C1' },
      { address: 'addr-d2', id: 'd2', rule: 'threat', clause: 'C1' },
    ]);
    expect(flagged.every((flag) => !('score' in flag))).toBe(true);
    expect(read).toEqual(['First\nfrom the Sunday group', 'Second', 'Third']);
  });

  it('flags nothing on an empty shelf, and asks the model nothing', async () => {
    const classify = vi.fn();
    expect(await flagEntries([], { classify })).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('scoring makes no request but the model files’, and keeps nothing (#493)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('captures every request: three pinned files from /models/, once, carrying nothing of the shelf', async () => {
    const { fetchFile } = serving();
    const doors = {
      xhr: vi.fn(),
      beacon: vi.fn(),
      setItem: vi.spyOn(Storage.prototype, 'setItem'),
      put: vi.spyOn(IDBObjectStore.prototype, 'put'),
      add: vi.spyOn(IDBObjectStore.prototype, 'add'),
      log: vi.spyOn(console, 'log'),
      warn: vi.spyOn(console, 'warn'),
      error: vi.spyOn(console, 'error'),
    };
    vi.stubGlobal('fetch', fetchFile);
    vi.stubGlobal('XMLHttpRequest', doors.xhr);
    vi.stubGlobal('navigator', Object.create(navigator, { sendBeacon: { value: doors.beacon } }));
    const classifier = classifierLoader(TINY_MODEL);
    const entries = [
      entry('d1', 'Our chess club', 'needs new boards'),
      entry('d2', 'Keep the reading room open'),
      entry('d3', 'Potluck on Sunday'),
    ];

    if (classifier !== null) await flagEntries(entries, classifier);
    if (classifier !== null) await flagEntries(entries, classifier);

    expect(fetchFile.mock.calls.map(([url]) => url).sort()).toEqual(MODEL_URLS);
    for (const [, init] of fetchFile.mock.calls) {
      expect(init).toEqual({ credentials: 'same-origin', redirect: 'error' });
    }
    for (const door of Object.values(doors)) expect(door).not.toHaveBeenCalled();
  });
});
