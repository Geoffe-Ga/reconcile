/**
 * The test page's worker (#476, #477): it loads the real embedder from our
 * own origin, as the Bedfellows worker does, and embeds, or measures the
 * model and the pipeline on this device, with the cache of entry vectors in
 * an IndexedDB database of its own. Only the test page starts it.
 */
import { sha256OfFile } from '../../src/crypto/hash';
import { pipelineMatcher } from '../../src/bedfellows/matcher';
import { harnessAsync, type Report } from '../../src/bedfellows/harness';
import { embedderLoader, modelEmbedder, modelIdOf } from '../../src/bedfellows/embedder';
import { loadCorpus } from '../../src/bedfellows/corpus';
import { indexedDbVectorStore, type VectorStore } from '../../src/bedfellows/entryVectors';
import { bedfellows, cosine } from '../../src/bedfellows/pipeline';
import { startEncoder } from '../../src/bedfellows/runtime';
import { standInEmbedder, standInJudge, standInSplitter } from '../../src/bedfellows/standIns';
import type { BedfellowsEntry, Embedder } from '../../src/bedfellows/types';
import { fetchPinned } from '../../src/net/modelFiles';
import { MODEL_FILES, type ModelPins } from '../../src/net/modelPins';
import type {
  FromModelWorker,
  HarnessCounts,
  Measurement,
  ShelfTiming,
  ShelfTimings,
  ToModelWorker,
} from './protocol';

const scope = self as unknown as {
  postMessage(message: FromModelWorker): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
};

/** One loader per set of pins, so the spec can load the tiny model and a wrong pin side by side. */
const loaders = new Map<string, () => Promise<Embedder>>();

function loaderFor(pins: ModelPins): () => Promise<Embedder> {
  const key = JSON.stringify(pins);
  const known = loaders.get(key);
  if (known !== undefined) return known;
  const load = embedderLoader(pins);
  loaders.set(key, load);
  return load;
}

/** Milliseconds since `start`, to a tenth. */
function since(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

/** The median of `values`. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Every Document of the corpus's readers, and `entries` entries: the corpus's
 * entries, repeated as needed, each repeat's sentences made its own with a
 * number, so a shelf of 500 holds 500 entries' worth of distinct claims.
 */
function shelfOf(documents: number, entries: number) {
  const corpus = loadCorpus();
  const reader = corpus.readers.flatMap((one) => one.documents).slice(0, documents);
  const shelf: BedfellowsEntry[] = Array.from({ length: entries }, (_, i) => {
    const entry = corpus.entries[i % corpus.entries.length];
    if (entry === undefined) throw new Error('The corpus has no entries.');
    const copy = Math.floor(i / corpus.entries.length);
    const text =
      copy === 0 ? entry.text : entry.text.replace(/([.!?])(\s|$)/gu, ` (${String(copy)})$1$2`);
    return { id: `${entry.id}#${String(copy)}`, title: entry.title, text };
  });
  return { reader, shelf };
}

/** Runs the pipeline over `documents` of the reader's and `entries` entries, timed. */
async function timeShelf(
  embedder: Embedder,
  store: VectorStore,
  documents: number,
  entries: number,
): Promise<ShelfTiming> {
  const { reader, shelf } = shelfOf(documents, entries);
  let claims = 0;
  const counting: Embedder = {
    model: embedder.model ?? 'measured',
    embed: (sentences) => {
      claims += sentences.length;
      return embedder.embed(sentences);
    },
  };
  const start = performance.now();
  const rows = await bedfellows(
    { reader, entries: shelf, dial: 0 },
    { embedder: counting, judge: standInJudge },
    { store },
  );
  return {
    documents: reader.length,
    entries: shelf.length,
    claims,
    rows: rows.length,
    ms: since(start),
  };
}

/** A shelf timed with no entry vectors kept, then again with all of them kept. */
async function coldAndWarm(
  embedder: Embedder,
  store: VectorStore,
  documents: number,
  entries: number,
): Promise<ShelfTimings> {
  await store.keepOnly([], '');
  const cold = await timeShelf(embedder, store, documents, entries);
  const warm = await timeShelf(embedder, store, documents, entries);
  return { cold, warm };
}

/** Whether `reader` gets a row for an entry of `text` from the pipeline, and the pair's cosine. */
async function rowFor(embedder: Embedder, reader: string, text: string) {
  const rows = await bedfellows(
    { reader: [{ title: '', text: reader }], entries: [{ id: 'e', title: '', text }], dial: 0 },
    { embedder, judge: standInJudge },
  );
  const [a, b] = await embedder.embed([reader, text]);
  return { row: rows.length > 0, cosine: cosine(a ?? [], b ?? []) };
}

/** The bytes the browser says it transferred for the model's files, or null where it says nothing. */
function transferred(): number | null {
  const entries = performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry.name.includes('/models/'));
  if (entries.length === 0) return null;
  return entries.reduce((sum, entry) => sum + entry.transferSize, 0);
}

/**
 * The model, from its three files fetched and checked, with how long that
 * took, how long hashing alone takes, and how long starting the model took.
 * The files are handed over and not kept once this returns, as embedderLoader
 * does, so the memory measured is the model's and not this page's copies.
 */
async function started(step: (name: string) => void) {
  step('Downloading and checking the model’s three files');
  const begin = performance.now();
  const [model, tokenizer, runtime] = await Promise.all([
    fetchPinned(MODEL_FILES.model),
    fetchPinned(MODEL_FILES.tokenizer),
    fetchPinned(MODEL_FILES.runtime),
  ]);
  const fetchAndCheckMs = since(begin);
  const hashStart = performance.now();
  for (const bytes of [model, tokenizer, runtime]) await sha256OfFile(bytes);
  const hashMs = since(hashStart);
  step('Starting the model');
  const startAt = performance.now();
  const embedder = modelEmbedder(
    await startEncoder({ model, tokenizer, runtime }),
    modelIdOf(MODEL_FILES),
  );
  return { embedder, fetchAndCheckMs, hashMs, startMs: since(startAt) };
}

/** A harness report, kind by kind. */
function countsOf(report: Report): HarnessCounts {
  return report.byKind;
}

/** Measures the real model on this device, step by step. */
async function measure(id: number, harness: boolean): Promise<Measurement> {
  const step = (name: string) => {
    scope.postMessage({ type: 'step', id, step: name });
  };
  const pins = [MODEL_FILES.model, MODEL_FILES.tokenizer, MODEL_FILES.runtime] as const;
  const begin = performance.now();
  const { embedder, fetchAndCheckMs, hashMs, startMs } = await started(step);
  const firstAt = performance.now();
  const [reading] = await embedder.embed(['Keep the reading room open.']);
  const firstEmbedMs = since(firstAt);
  const timeToFirstVectorMs = since(begin);
  const [library, chess] = await embedder.embed([
    'We want the library to stay open.',
    'Our chess club needs new boards.',
  ]);
  step('Timing sentences');
  const alone: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const at = performance.now();
    await embedder.embed([`Keep the reading room open on day ${String(i)}.`]);
    alone.push(since(at));
  }
  const sentences = [
    ...new Set(loadCorpus().entries.flatMap((entry) => standInSplitter(entry.text))),
  ].slice(0, 64);
  const batchAt = performance.now();
  await embedder.embed(sentences);
  const batchedMs = Math.round((since(batchAt) / sentences.length) * 10) / 10;
  const rows = {
    library: await rowFor(
      embedder,
      'Keep the reading room open late.',
      'The library must stay open.',
    ),
    chess: await rowFor(
      embedder,
      'Our chess club needs new boards.',
      'The housing board meets on Tuesday.',
    ),
  };
  const store = indexedDbVectorStore(indexedDB, 'reconcile-bedfellows-vectors-measure');
  step('A 50-entry shelf against 5 Documents, cold then warm');
  const shelf50 = await coldAndWarm(embedder, store, 5, 50);
  step('A 500-entry shelf against 20 Documents, cold then warm');
  const shelf500 = await coldAndWarm(embedder, store, 20, 500);
  let harnessCounts: Measurement['harness'] = null;
  if (harness) {
    step('The harness on tune, with the model, the stand-in and term overlap');
    const withModel = await harnessAsync(
      pipelineMatcher({ embedder, judge: standInJudge }),
      'tune',
    );
    const withStandIn = await harnessAsync(
      pipelineMatcher({ embedder: standInEmbedder, judge: standInJudge }),
      'tune',
    );
    const withFallback = await harnessAsync(pipelineMatcher({ judge: standInJudge }), 'tune');
    harnessCounts = {
      model: countsOf(withModel),
      standIn: countsOf(withStandIn),
      fallback: countsOf(withFallback),
    };
  }
  const gpu = Reflect.get(navigator, 'gpu') as { requestAdapter(): Promise<unknown> } | undefined;
  const adapter = gpu === undefined ? null : await gpu.requestAdapter();
  return {
    device: {
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      webgpu: adapter !== null,
      crossOriginIsolated: self.crossOriginIsolated,
    },
    download: {
      bytes: pins.reduce((sum, pin) => sum + pin.bytes, 0),
      transferred: transferred(),
      fetchAndCheckMs,
      hashMs,
    },
    startMs,
    firstEmbedMs,
    timeToFirstVectorMs,
    example: {
      libraryCosine: cosine(reading ?? [], library ?? []),
      chessCosine: cosine(reading ?? [], chess ?? []),
    },
    rows,
    perSentence: { aloneMs: median(alone), batchedMs },
    shelf50,
    shelf500,
    harness: harnessCounts,
  };
}

/** Answers one message from the page. */
async function answer(message: ToModelWorker): Promise<FromModelWorker> {
  if (message.type === 'measure') {
    return { type: 'measured', id: message.id, report: await measure(message.id, message.harness) };
  }
  const embedder = await loaderFor(message.pins ?? MODEL_FILES)();
  const vectors = await embedder.embed(message.sentences);
  return { type: 'vectors', id: message.id, vectors: vectors.map((vector) => Array.from(vector)) };
}

scope.addEventListener('securitypolicyviolation', (event) => {
  const violation = event as SecurityPolicyViolationEvent;
  scope.postMessage({
    type: 'violation',
    text: `${violation.effectiveDirective} blocked ${violation.blockedURI || 'inline'}`,
  });
});

scope.addEventListener('message', (event) => {
  const message = (event as MessageEvent<ToModelWorker>).data;
  answer(message).then(
    (reply) => {
      scope.postMessage(reply);
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      scope.postMessage({
        type: 'failed',
        id: message.id,
        name: failure.name,
        message: failure.message,
      });
    },
  );
});
