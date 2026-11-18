/**
 * The stance judge behind the `StanceJudge` port (#478; ADR-0080 §3): a
 * small natural-language-inference model, run by `runtime.ts`, asked about
 * each of an entry's best pairs both ways, the reader's sentence as premise
 * and then the entry's.
 *
 * The rule, {@link stanceOf}: a pair **agrees** only when the model's
 * entailment is at least `entails` both ways, since a claim two groups share
 * reads as each restating the other, and one-way entailment is how an
 * inference model reads a literal echo, irony included. It **opposes** only
 * when contradiction is at least `contradicts` both ways. Anything else is
 * **unsure**: a shared subject, never agreement.
 *
 * The judge ships switched off: no stance model met ADR-0080 §8's targets on
 * the corpus's `tune` split within the download budget and ADR-0024, so none
 * is pinned (`STANCE_MODEL` in `src/net/modelPins.ts`), {@link loadJudge}
 * resolves with the stand-in, which is always unsure, and no device fetches a
 * stance model. Once one is pinned, it loads as the embedder does: from our
 * own origin, the same files for everyone, each checked against its pin, on
 * first use, and kept by the service worker.
 *
 * It sends nothing and keeps nothing: a pair, a stance and a confidence live
 * only in the worker's memory for one run.
 */
import { fetchPinned } from '../net/modelFiles';
import { type ModelPins, type PinnedFile, STANCE_MODEL, type StanceModel } from '../net/modelPins';
import { type PairClassifier, type RuntimeFiles, startPairClassifier } from './runtime';
import { standInJudge } from './standIns';
import { THRESHOLDS, type Thresholds } from './thresholds';
import type { Stance, StanceJudge } from './types';

/** Which of the model's outputs is entailment, and which contradiction (none for a two-way model). */
export type StanceLabels = StanceModel['labels'];

/** A stance model's files, pinned, and its labels. */
export interface PinnedStanceModel {
  readonly files: ModelPins;
  readonly labels: StanceLabels;
}

/** Whether `probabilities` reach `bar` at `label`, both ways round. */
function bothWays(
  forward: ArrayLike<number>,
  backward: ArrayLike<number>,
  label: number,
  bar: number,
): boolean {
  return (forward[label] ?? 0) >= bar && (backward[label] ?? 0) >= bar;
}

/**
 * A pair's stance from the model's probabilities asked `forward` (the
 * reader's sentence as premise) and `backward` (the entry's): it opposes on
 * confident contradiction both ways, agrees on confident entailment both
 * ways, and is otherwise unsure.
 */
export function stanceOf(
  forward: ArrayLike<number>,
  backward: ArrayLike<number>,
  labels: StanceLabels,
  t: Thresholds['stance'],
): Stance {
  const { contradiction } = labels;
  if (contradiction !== undefined && bothWays(forward, backward, contradiction, t.contradicts)) {
    return 'opposes';
  }
  return bothWays(forward, backward, labels.entailment, t.entails) ? 'agrees' : 'unsure';
}

/** A `StanceJudge` over a started inference model whose outputs are `labels`. */
export function modelJudge(
  classifier: PairClassifier,
  labels: StanceLabels,
  t: Thresholds['stance'] = THRESHOLDS.stance,
): StanceJudge {
  return {
    judge: async (readerSentence, entrySentence) => {
      const forward = await classifier.classify(readerSentence, entrySentence);
      const backward = await classifier.classify(entrySentence, readerSentence);
      return stanceOf(forward, backward, labels, t);
    },
  };
}

/**
 * A loader of the judge for `model`: with none pinned, it resolves with the
 * stand-in and fetches nothing. Otherwise its first call fetches and checks
 * the three files with `fetchPin`, starts the model with `start` and resolves
 * with the judge; later calls resolve with the same one, and a call after a
 * failed load tries again.
 */
export function judgeLoader(
  model: PinnedStanceModel | null,
  fetchPin: (pin: PinnedFile) => Promise<Uint8Array> = fetchPinned,
  start: (files: RuntimeFiles) => Promise<PairClassifier> = startPairClassifier,
): () => Promise<StanceJudge> {
  if (model === null) return () => Promise.resolve(standInJudge);
  const { files, labels } = model;
  let loading: Promise<StanceJudge> | null = null;
  async function load(): Promise<StanceJudge> {
    const [network, tokenizer, runtime] = await Promise.all([
      fetchPin(files.model),
      fetchPin(files.tokenizer),
      fetchPin(files.runtime),
    ]);
    return modelJudge(await start({ model: network, tokenizer, runtime }), labels);
  }
  return () => {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}

/** The app's judge: the stand-in while no stance model is pinned (#478). */
export const loadJudge = judgeLoader(STANCE_MODEL);
