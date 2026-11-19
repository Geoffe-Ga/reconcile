/**
 * The shelf classifier (#493; ADR-0082; docs/spec/listed-doors.md §6.6): a
 * small toxicity model that reads public shelf entries on the steward's
 * device and puts those it flags in the console's queue.
 *
 * - **It only flags.** A flag names the rule that fired and the clause it
 *   suggests. It never holds, hides or reorders an entry, no reader sees it,
 *   and the steward decides every hold.
 * - **The narrow rule** (ADR-0082 Decision 3): the model's `threat` or
 *   `identity_hate` output at {@link FLAG_BAR} or more. It never flags on the
 *   broad labels (`toxic`, `obscene`, `insult`), which in the spike fell on
 *   swearing, counter-speech and reclaimed language.
 * - **Off until the re-measure.** {@link shelfClassifier} is null while
 *   `SHELF_CLASSIFIER` in `src/net/modelPins.ts` is, which is the feature
 *   flag (ADR-0082 Decision 1): then nothing loads, nothing is fetched, and
 *   the console shows no flag.
 * - **On the steward's device only.** dependency-cruiser's
 *   `only-the-steward-console-reaches-the-classifier` lets only the steward's
 *   app module (`src/app/steward.ts`) import this, and it asks only on a
 *   device that holds the steward's key. The model's files are fetched from
 *   our own origin the first time an entry is classified, never before, each
 *   checked against its pin (`src/net/modelFiles.ts`), and the model starts
 *   then, in a worker of its own (`classifyWorker.ts`), so no reader's
 *   device loads either.
 * - **It sends and keeps nothing.** A score lives only in memory while one
 *   entry is read, and a flag only in the console's state until it closes:
 *   nothing is written to the store, the relay or anywhere else.
 */
import { fetchPinned } from '../net/modelFiles';
import { type PinnedFile, SHELF_CLASSIFIER, type ShelfClassifierModel } from '../net/modelPins';
import type { RuntimeFiles } from '../bedfellows/runtime';
import type { FromClassifier, ToClassifier } from './classifyWorker';
import type { Clause } from './record';

/** The narrow rule's bar, on each of its two labels: the model card's own (ADR-0082). */
export const FLAG_BAR = 0.5;

/** Which of the narrow rule's two labels fired: what the console names. */
export type FlagRule = 'threat' | 'identity-hate';

/** What the classifier says of one text. */
export interface Verdict {
  /** The higher of `threat` and `identity_hate`, from 0 to 1. Never shown, and never a ranking. */
  readonly score: number;
  /** The label that gave {@link score}. */
  readonly rule: FlagRule;
  /** The covenant clause a flag suggests: C1 for both labels. */
  readonly clause: Clause;
}

/** The clause each rule suggests: both are C1, violence or denying a group's humanity. */
const CLAUSE_OF: Readonly<Record<FlagRule, Clause>> = { threat: 'C1', 'identity-hate': 'C1' };

/** The verdict on `probabilities`, the model's per-label outputs, whose rule labels sit at `labels`. */
export function verdictOf(
  probabilities: ArrayLike<number>,
  labels: ShelfClassifierModel['labels'],
): Verdict {
  const threat = probabilities[labels.threat] ?? 0;
  const hate = probabilities[labels.identityHate] ?? 0;
  const rule: FlagRule = hate > threat ? 'identity-hate' : 'threat';
  return { score: Math.max(threat, hate), rule, clause: CLAUSE_OF[rule] };
}

/** Whether `verdict` flags its text: the narrow rule's bar is reached. */
export function flags(verdict: Verdict): boolean {
  return verdict.score >= FLAG_BAR;
}

/** A started model: a text in, each label's probability out (`runtime.ts`'s `TextClassifier`). */
export interface TextScorer {
  scores(text: string): Promise<Float32Array>;
}

/** A shelf classifier: a text in, its verdict out. */
export interface ShelfClassifier {
  classify(text: string): Promise<Verdict>;
}

/** The worker's side of a channel, as the page sees it: a `Worker`, or a test's stand-in. */
export interface ClassifierWorker {
  postMessage(message: ToClassifier): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<FromClassifier>) => void): void;
  terminate(): void;
}

/** The classifier's module worker, built by Vite from the app's own origin. */
function newWorker(): ClassifierWorker {
  return new Worker(new URL('./classifyWorker.ts', import.meta.url), { type: 'module' });
}

/**
 * Starts the model in a worker of its own (`classifyWorker.ts`), handing it
 * the checked files, and resolves once it has started with a scorer that
 * asks it one text at a time.
 *
 * @throws {Error} when the model doesn't start; the worker is then ended.
 */
export function startInWorker(
  files: RuntimeFiles,
  makeWorker: () => ClassifierWorker = newWorker,
): Promise<TextScorer> {
  const worker = makeWorker();
  const waiting = new Map<number, (scores: Float32Array | null) => void>();
  let next = 0;
  return new Promise((resolve, reject) => {
    const scorer: TextScorer = {
      scores: (text) =>
        new Promise((done, fail) => {
          const id = (next += 1);
          waiting.set(id, (scores) => {
            if (scores === null) fail(new Error('The classifier couldn’t read an entry.'));
            else done(scores);
          });
          worker.postMessage({ type: 'score', id, text });
        }),
    };
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'started') resolve(scorer);
      if (data.type === 'failed') {
        worker.terminate();
        reject(new Error('The classifier couldn’t start.'));
      }
      if (data.type === 'scores' || data.type === 'error') {
        waiting.get(data.id)?.(data.type === 'scores' ? data.scores : null);
        waiting.delete(data.id);
      }
    });
    worker.postMessage({ type: 'start', files });
  });
}

/**
 * The classifier for `model`: null while none is pinned, so nothing loads.
 * Otherwise nothing is fetched until its first `classify`, which fetches and
 * checks the three files with `fetchPin` and starts the model with `start`;
 * later calls use the same model, and a call after a failed load tries again.
 */
export function classifierLoader(
  model: ShelfClassifierModel | null,
  fetchPin: (pin: PinnedFile) => Promise<Uint8Array> = fetchPinned,
  start: (files: RuntimeFiles) => Promise<TextScorer> = startInWorker,
): ShelfClassifier | null {
  if (model === null) return null;
  const { files, labels } = model;
  let loading: Promise<TextScorer> | null = null;
  async function load(): Promise<TextScorer> {
    const [network, tokenizer, runtime] = await Promise.all([
      fetchPin(files.model),
      fetchPin(files.tokenizer),
      fetchPin(files.runtime),
    ]);
    return start({ model: network, tokenizer, runtime });
  }
  return {
    classify: async (text) => {
      loading ??= load().catch((error: unknown) => {
        loading = null;
        throw error;
      });
      const scorer = await loading;
      return verdictOf(await scorer.scores(text), labels);
    },
  };
}

/** The app's shelf classifier: none while `SHELF_CLASSIFIER` is null, the flag that stays off. */
export const shelfClassifier: ShelfClassifier | null = classifierLoader(SHELF_CLASSIFIER);

/** What the classifier reads of an entry: its title, then its text on the next line. */
export function entryText(entry: { readonly title: string; readonly text: string }): string {
  return entry.text === '' ? entry.title : `${entry.title}\n${entry.text}`;
}

/** An entry the classifier flagged: which one, the rule that fired and the clause it suggests. No score. */
export interface EntryFlag {
  readonly address: string;
  readonly id: string;
  readonly rule: FlagRule;
  readonly clause: Clause;
}

/** The fields of a shelf entry the classifier reads and names. */
type Readable = Readonly<Record<'address' | 'id' | 'title' | 'text', string>>;

/**
 * The entries `classifier` flags, in `entries`' order, each read on its own:
 * a flag names its entry, rule and clause, never its score, so nothing can
 * rank the queue by it. `entries` is left as it was.
 *
 * @throws {Error} when the model can't be loaded or run.
 */
export async function flagEntries(
  entries: readonly Readable[],
  classifier: ShelfClassifier,
): Promise<EntryFlag[]> {
  const flagged: EntryFlag[] = [];
  for (const { address, id, title, text } of entries) {
    const verdict = await classifier.classify(entryText({ title, text }));
    if (flags(verdict)) flagged.push({ address, id, rule: verdict.rule, clause: verdict.clause });
  }
  return flagged;
}
