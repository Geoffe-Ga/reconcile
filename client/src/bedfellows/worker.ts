/**
 * The Bedfellows worker (#475; ADR-0080 §1): a module Worker, built by Vite
 * from the app's own origin, that runs the pipeline off the main thread so a
 * long run never stalls the page. `client.ts` is the page's side.
 *
 * It takes `{ type: 'run', id, input }` and posts `{ type: 'rows', id, rows }`
 * or a bare `{ type: 'error', id }`, and it takes `{ type: 'cancel', id }`,
 * which stops that run between entries and answers nothing. It holds a run
 * only while it runs: once a run ends, by rows, error or cancel, nothing of
 * it is left. It writes nothing, logs nothing and sends nothing but its
 * answers to the page (ADR-0080 §5).
 *
 * The models are the stand-ins until each later issue in #473 replaces one.
 * The real embedder (#476) is wired as a choice, {@link embedderFor}`('model')`,
 * which imports `embedder.ts`, and with it the runtime, only when a run first
 * asks it for a vector; this issue keeps the stand-in ({@link WORKER_EMBEDDER}),
 * and #477 switches matching to the model.
 */
import { bedfellows } from './pipeline';
import { standInEmbedder, standInJudge } from './standIns';
import type { BedfellowsInput, Embedder, FromWorker, Models, ToWorker } from './types';

/** The worker's side of the protocol: what it does with each message from the page. */
export interface Runner {
  /** Starts or cancels a run. */
  handle(message: ToWorker): void;
  /** How many runs it holds now: 0 once every run has ended. */
  inFlight(): number;
}

/**
 * `embedder`, waiting for a fresh task before each call. The stand-ins answer
 * at once, so without it a run would finish before a cancel could arrive.
 */
export function yielding(embedder: Embedder): Embedder {
  return {
    embed: async (sentences) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return embedder.embed(sentences);
    },
  };
}

/** Which embedder the worker runs: #475's stand-in, or the real model (#476). */
export type EmbedderChoice = 'stand-in' | 'model';

/** The worker's embedder in this issue: the stand-in. #477 switches matching to the model. */
export const WORKER_EMBEDDER: EmbedderChoice = 'stand-in';

/** Imports the real embedder's module and loads the model: fetched, checked and started. */
async function loadModel(): Promise<Embedder> {
  const { loadEmbedder } = await import('./embedder');
  return loadEmbedder();
}

/**
 * The embedder for `choice`. The model is loaded with `load` when it is first
 * asked for a vector, never before, and once; a call after a failed load
 * tries again.
 */
export function embedderFor(
  choice: EmbedderChoice,
  load: () => Promise<Embedder> = loadModel,
): Embedder {
  if (choice === 'stand-in') return yielding(standInEmbedder);
  let loading: Promise<Embedder> | null = null;
  return {
    embed: async (sentences) => {
      loading ??= load().catch((error: unknown) => {
        loading = null;
        throw error;
      });
      return (await loading).embed(sentences);
    },
  };
}

/** A runner that runs `models` and posts each answer with `post`. */
export function createRunner(models: Models, post: (message: FromWorker) => void): Runner {
  const runs = new Map<number, AbortController>();

  /** Runs `input` as run `id`, and posts its rows, or an error unless it was cancelled. */
  async function run(id: number, input: BedfellowsInput): Promise<void> {
    const controller = new AbortController();
    runs.set(id, controller);
    try {
      post({ type: 'rows', id, rows: await bedfellows(input, models, controller.signal) });
    } catch {
      if (!controller.signal.aborted) post({ type: 'error', id });
    } finally {
      runs.delete(id);
    }
  }

  return {
    handle: (message) => {
      if (message.type === 'run') void run(message.id, message.input);
      else runs.get(message.id)?.abort();
    },
    inFlight: () => runs.size,
  };
}

const runner = createRunner(
  { embedder: embedderFor(WORKER_EMBEDDER), judge: standInJudge },
  (message) => {
    self.postMessage(message);
  },
);

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  runner.handle(event.data);
});
