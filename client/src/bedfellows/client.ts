/**
 * The page's side of the Bedfellows worker (#475): it sends the reader's
 * Documents and the shelf to `worker.ts` and hands back the rows, so the
 * pipeline never runs on the main thread. A run can be cancelled; a cancelled
 * run's answer, should one still arrive, is dropped.
 *
 * The worker is a module Worker that Vite builds from the app's own origin,
 * so the deploy CSP's `default-src 'self'` already allows it. It starts on
 * the first run, not with the app, and serves every run after.
 */
import type { BedfellowsInput, FromWorker, Row, ToWorker } from './types';

/** The parts of a Worker the client uses, so a test can hand it a fake. */
export interface BedfellowsWorker {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** One run: its rows, once the worker answers, and a way to stop it. */
export interface BedfellowsRun {
  /** Resolves with the rows; rejects if the run fails, or with an AbortError once cancelled. */
  readonly rows: Promise<Row[]>;
  /** Stops the run. It does nothing once the run has answered. */
  cancel(): void;
}

/** The page's handle on the worker. */
export interface BedfellowsClient {
  /** Starts a run of `input`. */
  run(input: BedfellowsInput): BedfellowsRun;
  /** Ends the worker, rejecting every open run with an AbortError. The next run starts a new one. */
  close(): void;
}

/** A run waiting for its answer. */
interface Waiting {
  readonly resolve: (rows: Row[]) => void;
  readonly reject: (error: Error) => void;
}

/** The Bedfellows worker, built by Vite from the app's own origin. */
function startWorker(): BedfellowsWorker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

/** An AbortError for a run the page stopped. */
function cancelled(): DOMException {
  return new DOMException('The Bedfellows run was cancelled.', 'AbortError');
}

/** The error a run that failed rejects with: bare, so no word of the reader's is in it. */
function failed(): Error {
  return new Error('The Bedfellows run failed.');
}

/** A client of the worker `makeWorker` starts, on the first run. */
export function createBedfellowsClient(
  makeWorker: () => BedfellowsWorker = startWorker,
): BedfellowsClient {
  const waiting = new Map<number, Waiting>();
  let worker: BedfellowsWorker | null = null;
  let last = 0;

  /** Rejects every open run with `error`, and ends the worker. */
  function end(error: () => Error): void {
    for (const run of waiting.values()) run.reject(error());
    waiting.clear();
    worker?.terminate();
    worker = null;
  }

  /** Settles the run `message` answers, if the page is still waiting for it. */
  function answer(message: FromWorker): void {
    const run = waiting.get(message.id);
    if (run === undefined) return;
    waiting.delete(message.id);
    if (message.type === 'rows') run.resolve([...message.rows]);
    else run.reject(failed());
  }

  /** The worker, started now if it isn't running. */
  function connected(): BedfellowsWorker {
    if (worker !== null) return worker;
    const started = makeWorker();
    started.onmessage = (event) => {
      answer(event.data);
    };
    started.onerror = () => {
      end(failed);
    };
    worker = started;
    return started;
  }

  return {
    run: (input) => {
      last += 1;
      const id = last;
      const rows = new Promise<Row[]>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
      try {
        connected().postMessage({ type: 'run', id, input });
      } catch {
        // The worker couldn't start (a CSP that blocks it, say): the run fails, it doesn't throw.
        end(failed);
      }
      return {
        rows,
        cancel: () => {
          const run = waiting.get(id);
          if (run === undefined) return;
          waiting.delete(id);
          worker?.postMessage({ type: 'cancel', id });
          run.reject(cancelled());
        },
      };
    },
    close: () => {
      end(cancelled);
    },
  };
}
