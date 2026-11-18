/**
 * What the test page and its worker say to each other (#476). The worker runs
 * the real embedder, `src/bedfellows/embedder.ts`, as the Bedfellows worker
 * will once #477 switches matching to the model.
 */
import type { ModelPins } from '../../src/net/modelPins';

/** The page asks for vectors, with the pins to load (the app's when absent), or for a measurement. */
export type ToModelWorker =
  | {
      readonly type: 'embed';
      readonly id: number;
      readonly sentences: readonly string[];
      readonly pins?: ModelPins;
    }
  | { readonly type: 'measure'; readonly id: number; readonly harness: boolean };

/**
 * The worker answers with vectors, a measurement, a step it has reached, or
 * the name of an error; and it passes on each CSP violation in its own scope,
 * which the page's listener never sees.
 */
export type FromModelWorker =
  | { readonly type: 'violation'; readonly text: string }
  | {
      readonly type: 'vectors';
      readonly id: number;
      readonly vectors: readonly (readonly number[])[];
    }
  | { readonly type: 'measured'; readonly id: number; readonly report: Measurement }
  | { readonly type: 'step'; readonly id: number; readonly step: string }
  | {
      readonly type: 'failed';
      readonly id: number;
      readonly name: string;
      readonly message: string;
    };

/** One timed shelf: how long the pipeline took, and what it embedded and kept. */
export interface ShelfTiming {
  readonly documents: number;
  readonly entries: number;
  readonly claims: number;
  readonly rows: number;
  readonly ms: number;
}

/** How a matcher did on the corpus's tune split, kind by kind (#474's harness). */
export type HarnessCounts = Readonly<
  Record<string, { pairs: number; commonGround: number; sharedSubject: number; nothing: number }>
>;

/** Everything the page measures, in milliseconds and bytes. */
export interface Measurement {
  readonly device: {
    readonly userAgent: string;
    readonly cores: number;
    /** Whether the browser offers a WebGPU adapter. The model runs on WebAssembly either way. */
    readonly webgpu: boolean;
    readonly crossOriginIsolated: boolean;
  };
  readonly download: {
    /** The three files' sizes, which every device downloads once. */
    readonly bytes: number;
    /** What the browser reports it transferred, or null where it doesn't say. */
    readonly transferred: number | null;
    /** Fetching and checking all three, in parallel. */
    readonly fetchAndCheckMs: number;
    /** Hashing them alone, again, for the share of the above it takes. */
    readonly hashMs: number;
  };
  /** Compiling the WebAssembly and starting the model. */
  readonly startMs: number;
  /** The first sentence's vector, once started. */
  readonly firstEmbedMs: number;
  /** From the first fetch to the first vector. */
  readonly timeToFirstVectorMs: number;
  /** The issue's example: the reading room against the library, and against the chess club. */
  readonly example: { readonly libraryCosine: number; readonly chessCosine: number };
  readonly perSentence: {
    /** The median of ten one-sentence calls. */
    readonly aloneMs: number;
    /** Sixty-four corpus sentences in one call, run in batches, per sentence. */
    readonly batchedMs: number;
  };
  readonly shelf50: ShelfTiming;
  readonly shelf500: ShelfTiming;
  /** The harness on tune with the model and with #475's stand-in, when asked for. */
  readonly harness: { readonly model: HarnessCounts; readonly standIn: HarnessCounts } | null;
}
