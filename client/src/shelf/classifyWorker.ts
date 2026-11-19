/**
 * The shelf classifier's worker (#493; ADR-0082): runs the toxicity model on
 * #476's runtime, off the console's page, as Bedfellows' worker runs its
 * model. Running it in a module worker keeps the runtime's code in the
 * workers' build, whose `ortWasmUrl()` keeps its WebAssembly under
 * `/models/`, and keeps the page responsive while the model starts.
 *
 * It fetches nothing: the page hands it the model's files, already checked
 * against their pins (`classify.ts`), then one text at a time, and it answers
 * each text's per-label probabilities. It keeps nothing and sends nothing
 * but its answers to the page that started it.
 */
import { type RuntimeFiles, startTextClassifier, type TextClassifier } from '../bedfellows/runtime';

/** What the page sends: the checked files once, then texts to score. */
export type ToClassifier =
  | { readonly type: 'start'; readonly files: RuntimeFiles }
  | { readonly type: 'score'; readonly id: number; readonly text: string };

/** What the worker answers: whether the model started, then each text's scores, by id. */
export type FromClassifier =
  | { readonly type: 'started' }
  | { readonly type: 'failed' }
  | { readonly type: 'scores'; readonly id: number; readonly scores: Float32Array }
  | { readonly type: 'error'; readonly id: number };

/**
 * The worker's side: starts the model from the first `start` with `start`,
 * then answers each `score` with the model's scores, or an error. A `score`
 * before the model has started waits for it.
 */
export function createClassifierHost(
  post: (message: FromClassifier) => void,
  start: (files: RuntimeFiles) => Promise<TextClassifier> = startTextClassifier,
): { readonly handle: (message: ToClassifier) => void } {
  let model: Promise<TextClassifier> | null = null;
  async function score(id: number, text: string): Promise<void> {
    try {
      if (model === null) throw new Error('The classifier hasn’t started.');
      post({ type: 'scores', id, scores: await (await model).scores(text) });
    } catch {
      post({ type: 'error', id });
    }
  }
  return {
    handle: (message) => {
      if (message.type === 'score') {
        void score(message.id, message.text);
        return;
      }
      model = start(message.files);
      model.then(
        () => {
          post({ type: 'started' });
        },
        () => {
          post({ type: 'failed' });
        },
      );
    },
  };
}

const host = createClassifierHost((message) => {
  self.postMessage(message);
});

self.addEventListener('message', (event: MessageEvent<ToClassifier>) => {
  host.handle(event.data);
});
