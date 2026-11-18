/**
 * The stance judge (#478; ADR-0080 §3): an inference model asked both ways,
 * and only confident entailment both ways counts as agreement.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../crypto/hash';
import { fetchPinned, PinMismatchError } from '../net/modelFiles';
import type { ModelFileName, ModelPins, PinnedFile } from '../net/modelPins';
import { ortWasm } from '../test/ortWasm';
import { tinyClassifierOnnx, tinyTokenizerJson } from '../test/tinyModel';
import { judgeLoader, loadJudge, modelJudge, stanceOf, type StanceLabels } from './judge';
import { type PairClassifier, startPairClassifier } from './runtime';
import { standInJudge } from './standIns';
import { THRESHOLDS } from './thresholds';

/** A three-way inference model's outputs: entailment, neutral, contradiction. */
const THREE_WAY: StanceLabels = { entailment: 0, contradiction: 2 };

/** A two-way model's outputs: entailment, and not. */
const TWO_WAY: StanceLabels = { entailment: 0 };

const T = THRESHOLDS.stance;

/** Probabilities `[entailment, neutral, contradiction]`. */
function p(entailment: number, contradiction = 0): number[] {
  return [entailment, 1 - entailment - contradiction, contradiction];
}

/** A classifier that answers from `table`, keyed by premise then hypothesis, recording each ask. */
function classifierOf(table: Record<string, number[]>): PairClassifier & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    classify: (premise, hypothesis) => {
      const key = `${premise} → ${hypothesis}`;
      asked.push(key);
      return Promise.resolve(Float32Array.from(table[key] ?? p(0)));
    },
  };
}

describe('stanceOf (#478)', () => {
  it('agrees only when entailment is confident both ways', () => {
    expect(stanceOf(p(T.entails), p(T.entails), THREE_WAY, T)).toBe('agrees');
    expect(stanceOf(p(0.99), p(T.entails - 0.01), THREE_WAY, T)).toBe('unsure');
    expect(stanceOf(p(T.entails - 0.01), p(0.99), THREE_WAY, T)).toBe('unsure');
  });

  it('reads one-way entailment, as an ironic entry gets, as unsure', () => {
    // DeBERTa on the corpus's irony case: the entry entails the reader's welcome, not the reverse.
    expect(stanceOf(p(0, 0), p(0.97, 0), THREE_WAY, T)).toBe('unsure');
  });

  it('opposes only when contradiction is confident both ways', () => {
    expect(stanceOf(p(0, T.contradicts), p(0, T.contradicts), THREE_WAY, T)).toBe('opposes');
    expect(stanceOf(p(0, 0.99), p(0, T.contradicts - 0.01), THREE_WAY, T)).toBe('unsure');
    expect(stanceOf(p(0, 0.05), p(0, 0.99), THREE_WAY, T)).toBe('unsure');
  });

  it('reads a label the model doesn’t have as never reached', () => {
    expect(stanceOf([0.9], [0.9], { entailment: 1, contradiction: 2 }, T)).toBe('unsure');
  });

  it('never opposes with a two-way model, which has no contradiction', () => {
    expect(stanceOf([0.01, 0.99], [0.01, 0.99], TWO_WAY, T)).toBe('unsure');
    expect(stanceOf([0.95, 0.05], [0.9, 0.1], TWO_WAY, T)).toBe('agrees');
  });
});

describe('modelJudge (#478)', () => {
  it('asks the model both ways: the reader’s sentence as premise, then the entry’s', async () => {
    const classifier = classifierOf({});

    await modelJudge(classifier, THREE_WAY).judge('Keep it open.', 'Close it.');

    expect(classifier.asked).toEqual(['Keep it open. → Close it.', 'Close it. → Keep it open.']);
  });

  it('gives the issue’s examples: a restated aim agrees, the deer season never does', async () => {
    const library = ['Keep the library open.', 'We want the library to stay open.'] as const;
    const deer = ['Deer season is our heritage.', 'End deer season now.'] as const;
    const judge = modelJudge(
      classifierOf({
        [`${library[0]} → ${library[1]}`]: p(0.93),
        [`${library[1]} → ${library[0]}`]: p(0.88),
        [`${deer[0]} → ${deer[1]}`]: p(0.02, 0.4),
        [`${deer[1]} → ${deer[0]}`]: p(0.01, 0.7),
      }),
      THREE_WAY,
    );

    expect(await judge.judge(...library)).toBe('agrees');
    expect(await judge.judge(...deer)).not.toBe('agrees');
  });

  it('never turns opposes into agrees when the reader and the entry swap sides', async () => {
    const probabilities = fc
      .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
      .map(([a, b]) => {
        const [entailment, contradiction] = a + b > 1 ? [a / (a + b), b / (a + b)] : [a, b];
        return p(entailment, contradiction);
      });
    await fc.assert(
      fc.asyncProperty(probabilities, probabilities, async (forward, backward) => {
        const judge = modelJudge(classifierOf({ 'a → b': forward, 'b → a': backward }), THREE_WAY);
        const ours = await judge.judge('a', 'b');
        const swapped = await judge.judge('b', 'a');
        expect(ours === 'opposes' && swapped === 'agrees').toBe(false);
        expect(swapped).toBe(ours);
      }),
    );
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

/** Pins for `files`, named as real ones are. */
function pinsFor(files: Readonly<Record<ModelFileName, Uint8Array>>): ModelPins {
  const pin = (name: ModelFileName): PinnedFile => {
    const sha = hexOf(files[name]);
    return { file: `tiny-${name}-${sha.slice(0, 8)}.bin`, sha256: sha, bytes: files[name].length };
  };
  return { model: pin('model'), tokenizer: pin('tokenizer'), runtime: pin('runtime') };
}

const PINS = pinsFor(TINY);

/** A server holding `files` under `PINS`' names, counting each request. */
function serving(files: Readonly<Record<ModelFileName, Uint8Array>>) {
  const byUrl = new Map(
    (Object.keys(PINS) as ModelFileName[]).map((name) => [
      `/models/${PINS[name].file}`,
      files[name],
    ]),
  );
  const fetchFile = vi.fn((url: string) => {
    const body = byUrl.get(url);
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : new Response(body.slice()),
    );
  });
  return { fetchFile, fetchPin: (pin: PinnedFile) => fetchPinned(pin, fetchFile) };
}

describe('judgeLoader (#478)', () => {
  it('is the stand-in, fetching nothing, while no stance model is pinned: the judge ships switched off', async () => {
    const { fetchFile, fetchPin } = serving(TINY);

    expect(await judgeLoader(null, fetchPin)()).toBe(standInJudge);
    expect(await loadJudge()).toBe(standInJudge);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('fetches nothing until it is called', () => {
    const { fetchFile, fetchPin } = serving(TINY);
    judgeLoader({ files: PINS, labels: THREE_WAY }, fetchPin);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('fetches and checks the three files once, starts the model, and judges with it', async () => {
    const { fetchFile, fetchPin } = serving(TINY);
    const load = judgeLoader({ files: PINS, labels: THREE_WAY }, fetchPin);
    const direct = modelJudge(await startPairClassifier(TINY), THREE_WAY);

    const judge = await load();
    const again = await load();

    expect(again).toBe(judge);
    expect(fetchFile.mock.calls.map(([url]) => url).sort()).toEqual(
      Object.values(PINS)
        .map((pin) => `/models/${pin.file}`)
        .sort(),
    );
    for (const [reader, entry] of [
      ['Keep the library open.', 'We want boards.'],
      ['Our chess club.', 'Our chess club.'],
    ] as const) {
      expect(await judge.judge(reader, entry)).toBe(await direct.judge(reader, entry));
    }
  });

  it('refuses a file that doesn’t match its pin, and never starts the model', async () => {
    const tampered = TINY.model.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    const { fetchPin } = serving({ ...TINY, model: tampered });
    const start = vi.fn(startPairClassifier);

    await expect(
      judgeLoader({ files: PINS, labels: THREE_WAY }, fetchPin, start)(),
    ).rejects.toBeInstanceOf(PinMismatchError);

    expect(start).not.toHaveBeenCalled();
  });

  it('tries again on the next call after a load fails', async () => {
    const { fetchFile, fetchPin } = serving(TINY);
    fetchFile.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })));
    const load = judgeLoader({ files: PINS, labels: THREE_WAY }, fetchPin);

    await expect(load()).rejects.toThrow(/couldn’t be fetched/);
    await expect(load()).resolves.toHaveProperty('judge');
  });
});
