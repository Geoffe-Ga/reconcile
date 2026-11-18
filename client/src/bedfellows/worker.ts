/**
 * The Bedfellows worker (#475, #477; ADR-0080 §1, §2, §5): a module Worker,
 * built by Vite from the app's own origin, that runs the pipeline off the
 * main thread so a long run never stalls the page. `client.ts` is the page's
 * side.
 *
 * It takes `{ type: 'run', id, input, model }` and posts
 * `{ type: 'rows', id, rows }` or a bare `{ type: 'error', id }`, and it takes
 * `{ type: 'cancel', id }`, which stops that run and answers nothing. It
 * holds a run only while it runs: once a run ends, by rows, error or cancel,
 * nothing of it is left. It logs nothing and sends nothing but its answers to
 * the page (ADR-0080 §5).
 *
 * With `model`, a run matches with the embedding model (#476), which the
 * worker loads on the first such run, never before: `embedder.ts`, and with
 * it the runtime, are imported only then. Without `model`, or when the model
 * fails to load (offline on first use, a file that doesn't match its pin), the
 * run matches by term overlap, every row unverified (`fallback.ts`), and a
 * later run with `model` tries the load again. A run with the model judges
 * stance with `judge.ts` (#478), imported then too; it ships switched off, so
 * its judge is the stand-in and every reason is unverified, and a stance
 * model that won't load leaves the stand-in in its place.
 *
 * The one thing it writes is the cache of public entry vectors
 * (`entryVectors.ts`), in an IndexedDB database of its own: never the
 * reader's text, vectors or scores.
 */
import { indexedDbVectorStore, type VectorStore } from './entryVectors';
import { bedfellows } from './pipeline';
import { standInJudge } from './standIns';
import type { BedfellowsInput, Embedder, FromWorker, StanceJudge, ToWorker } from './types';

/** The worker's side of the protocol: what it does with each message from the page. */
export interface Runner {
  /** Starts or cancels a run. */
  handle(message: ToWorker): void;
  /** How many runs it holds now: 0 once every run has ended. */
  inFlight(): number;
}

/** What a runner runs with. */
export interface WorkerSetup {
  /** The judge while no stance model has loaded: the stand-in, always unsure. */
  readonly judge: StanceJudge;
  /**
   * The stance model (#478), loaded on the first run that has the embedding
   * model; a call after a failed load tries again. Without it, or when it
   * won't load, the run judges with {@link WorkerSetup.judge}.
   */
  readonly loadJudge?: () => Promise<StanceJudge>;
  /** The embedding model, loaded on the first call; a call after a failed load tries again. */
  readonly loadModel: () => Promise<Embedder>;
  /** Where entries' public vectors are kept, where the browser can keep them. */
  readonly store?: VectorStore | undefined;
}

/**
 * `embedder`, waiting for a fresh task before each call, so a cancel can land
 * between calls even when the embedder answers at once.
 */
export function yielding(embedder: Embedder): Embedder {
  return {
    ...(embedder.model === undefined ? {} : { model: embedder.model }),
    embed: async (sentences) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return embedder.embed(sentences);
    },
  };
}

/** Imports the real embedder's module and loads the model: fetched, checked and started. */
async function loadModel(): Promise<Embedder> {
  const { loadEmbedder } = await import('./embedder');
  return loadEmbedder();
}

/** Imports the stance judge's module and loads its model: the stand-in while none is pinned. */
async function loadJudge(): Promise<StanceJudge> {
  const judge = await import('./judge');
  return judge.loadJudge();
}

/** The model for a run that asks for it, or none when it doesn't or the model won't load. */
async function embedderFor(model: boolean, setup: WorkerSetup): Promise<Embedder | undefined> {
  if (!model) return undefined;
  try {
    return yielding(await setup.loadModel());
  } catch {
    return undefined;
  }
}

/** The judge for a run: the stance model's when the run has the embedding model and it loads, else the setup's. */
async function judgeFor(embedder: Embedder | undefined, setup: WorkerSetup): Promise<StanceJudge> {
  if (embedder === undefined || setup.loadJudge === undefined) return setup.judge;
  try {
    return await setup.loadJudge();
  } catch {
    return setup.judge;
  }
}

/** A runner that runs with `setup` and posts each answer with `post`. */
export function createRunner(setup: WorkerSetup, post: (message: FromWorker) => void): Runner {
  const runs = new Map<number, AbortController>();

  /** Runs `input` as run `id`, and posts its rows, or an error unless it was cancelled. */
  async function run(id: number, input: BedfellowsInput, model: boolean): Promise<void> {
    const controller = new AbortController();
    runs.set(id, controller);
    try {
      const embedder = await embedderFor(model, setup);
      const judge = await judgeFor(embedder, setup);
      const rows = await bedfellows(
        input,
        { embedder, judge },
        { signal: controller.signal, store: setup.store },
      );
      post({ type: 'rows', id, rows });
    } catch {
      if (!controller.signal.aborted) post({ type: 'error', id });
    } finally {
      runs.delete(id);
    }
  }

  return {
    handle: (message) => {
      if (message.type === 'run') void run(message.id, message.input, message.model);
      else runs.get(message.id)?.abort();
    },
    inFlight: () => runs.size,
  };
}

const runner = createRunner(
  {
    judge: standInJudge,
    loadModel,
    loadJudge,
    store: typeof indexedDB === 'undefined' ? undefined : indexedDbVectorStore(indexedDB),
  },
  (message) => {
    self.postMessage(message);
  },
);

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  runner.handle(event.data);
});
