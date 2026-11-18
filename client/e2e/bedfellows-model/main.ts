/**
 * The test page's side (#476): it registers the app's service worker, starts
 * the model's worker, and hands `bedfellowsModel` to the spec on `window`.
 * Its two buttons measure the real model on this device and show the numbers,
 * for the founder's phones (`scripts/measure-model.sh`).
 */
import type { ModelPins } from '../../src/net/modelPins';
import type { FromModelWorker, Measurement, ToModelWorker } from './protocol';

/** What the spec drives the page with. */
export interface BedfellowsModelPage {
  /** Vectors for `sentences`, from the model `pins` names (the app's when absent). */
  embed(sentences: readonly string[], pins?: ModelPins): Promise<readonly (readonly number[])[]>;
  /** Measures the real model, and with `harness`, runs the harness too. */
  measure(harness: boolean): Promise<Measurement>;
  /** Each CSP violation the worker saw in its own scope. */
  readonly violations: string[];
}

/** A failure the worker reported, carrying its error's name. */
class WorkerFailure extends Error {
  constructor(
    override readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const waiting = new Map<
  number,
  { resolve: (reply: FromModelWorker) => void; reject: (error: Error) => void }
>();
const violations: string[] = [];
let last = 0;

/** Shows `text` in the status line. */
function status(text: string): void {
  const line = document.getElementById('status');
  if (line !== null) line.textContent = text;
}

worker.addEventListener('message', (event: MessageEvent<FromModelWorker>) => {
  const reply = event.data;
  if (reply.type === 'violation') {
    violations.push(reply.text);
    return;
  }
  if (reply.type === 'step') {
    status(`${reply.step}…`);
    return;
  }
  const run = waiting.get(reply.id);
  waiting.delete(reply.id);
  if (reply.type === 'failed') run?.reject(new WorkerFailure(reply.name, reply.message));
  else run?.resolve(reply);
});

/** Sends `message` with a fresh id, and resolves with the worker's answer to it. */
function ask(message: (id: number) => ToModelWorker): Promise<FromModelWorker> {
  last += 1;
  const id = last;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage(message(id));
  });
}

const page: BedfellowsModelPage = {
  embed: async (sentences, pins) => {
    const reply = await ask((id) => ({
      type: 'embed',
      id,
      sentences,
      ...(pins === undefined ? {} : { pins }),
    }));
    if (reply.type !== 'vectors') throw new Error(`Expected vectors, got ${reply.type}.`);
    return reply.vectors;
  },
  measure: async (harness) => {
    const reply = await ask((id) => ({ type: 'measure', id, harness }));
    if (reply.type !== 'measured') throw new Error(`Expected a measurement, got ${reply.type}.`);
    return reply.report;
  },
  violations,
};
Reflect.set(window, 'bedfellowsModel', page);

/** The rows of the numbers table: a label and a value, with the budget it's held to where ADR-0080 §8 sets one. */
function rowsOf(report: Measurement): [string, string][] {
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  return [
    ['Downloaded (budget 60 MB)', mb(report.download.bytes)],
    [
      'Transferred, as the browser reports it',
      report.download.transferred === null ? 'not reported' : mb(report.download.transferred),
    ],
    ['Fetch and check the three files', s(report.download.fetchAndCheckMs)],
    ['…of which hashing', s(report.download.hashMs)],
    ['Start the model', s(report.startMs)],
    ['First vector, once started', s(report.firstEmbedMs)],
    ['Time to first vector', s(report.timeToFirstVectorMs)],
    ['One sentence alone (median of 10)', `${report.perSentence.aloneMs.toFixed(1)} ms`],
    ['Per sentence, 64 in batches', `${report.perSentence.batchedMs.toFixed(1)} ms`],
    [
      `50 entries × 5 Documents, cold (${String(report.shelf50.cold.claims)} claims; budget 3 s)`,
      s(report.shelf50.cold.ms),
    ],
    [
      `50 entries × 5 Documents, warm (${String(report.shelf50.warm.claims)} claims)`,
      s(report.shelf50.warm.ms),
    ],
    [
      `500 entries × 20 Documents, cold (${String(report.shelf500.cold.claims)} claims)`,
      s(report.shelf500.cold.ms),
    ],
    [
      `500 entries × 20 Documents, warm (${String(report.shelf500.warm.claims)} claims; budget 10 s)`,
      s(report.shelf500.warm.ms),
    ],
    [
      'Rows: reading room vs library / chess vs housing board',
      `${report.rows.library.row ? 'row' : 'none'} (${report.rows.library.cosine.toFixed(3)}) / ${report.rows.chess.row ? 'row' : 'none'} (${report.rows.chess.cosine.toFixed(3)})`,
    ],
    [
      'Example: reading room vs library / vs chess',
      `${report.example.libraryCosine.toFixed(3)} / ${report.example.chessCosine.toFixed(3)}`,
    ],
    ['WebGPU available', report.device.webgpu ? 'yes (not used: WASM only)' : 'no'],
    ['Cores', String(report.device.cores)],
  ];
}

/** Shows `report` in the table and as JSON. */
function show(report: Measurement): void {
  const table = document.getElementById('numbers');
  if (table instanceof HTMLTableElement) {
    table.replaceChildren();
    for (const [label, value] of rowsOf(report)) {
      const row = table.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = value;
    }
  }
  const json = document.getElementById('report');
  if (json !== null) json.textContent = JSON.stringify(report, null, 2);
}

/** Runs a measurement from a button, showing its steps, its numbers or its error. */
function measureFrom(harness: boolean): void {
  status('Starting…');
  page.measure(harness).then(
    (report) => {
      status('Done. Copy the numbers below into the PR.');
      show(report);
    },
    (error: unknown) => {
      status(
        `Failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    },
  );
}

document.getElementById('measure')?.addEventListener('click', () => {
  measureFrom(false);
});
document.getElementById('harness')?.addEventListener('click', () => {
  measureFrom(true);
});

// The app's service worker keeps the model's files once fetched, so a second
// load works offline. Browsers offer it only in a secure context.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}
