/**
 * The Bedfellows model's files, each pinned by its SHA-256 (#476; ADR-0080 §2).
 *
 * Every device fetches exactly these files from Reconcile's own origin, under
 * `/models/`, so a fetch says nothing about the reader. They are too large for
 * git: `scripts/models.sh` fetches the model and its tokenizer from `source`
 * into `client/.models/`, checking each hash, and the runtime's WebAssembly
 * comes from the npm package `package-lock.json` pins. The build
 * (`plugins/modelFiles.ts`) checks every hash again and writes the files to
 * `dist/models/`; the page checks it once more before first use
 * (`src/net/modelFiles.ts`). A file changes only with an app release.
 *
 * This file holds data, and {@link servedFiles}, which only lists it, so the
 * build, the scripts and the app all read the same pins.
 */

/**
 * `bytes` in lowercase hex. The pins are written as bytes, not hex, so a
 * secret scanner doesn't take a public file's hash for a key.
 */
function hexOf(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One file the model needs, and what it must be. */
export interface PinnedFile {
  /** Its name under `/models/`. Its hash's first eight hex digits are in it, so a new file is a new URL. */
  readonly file: string;
  /** The SHA-256 of its bytes, in lowercase hex. */
  readonly sha256: string;
  /** Its size in bytes. */
  readonly bytes: number;
}

/** A pinned file, with where the build gets it and its license (ADR-0024). */
export interface SourcedFile extends PinnedFile {
  /** A URL at a fixed revision, or `npm:<package>@<version>/<path>` for a file the lockfile pins. */
  readonly source: string;
  /** Its SPDX license. */
  readonly license: string;
}

/** The three files the model needs: the network, its tokenizer, and the runtime that runs it. */
export type ModelFileName = 'model' | 'tokenizer' | 'runtime';

/** A set of pins, one per file. */
export type ModelPins = Readonly<Record<ModelFileName, PinnedFile>>;

/**
 * all-MiniLM-L6-v2 (sentence-transformers, Apache-2.0), as Xenova's 8-bit
 * ONNX export (Apache-2.0), with its WordPiece tokenizer, and ONNX Runtime
 * Web's plain WebAssembly build (MIT): the same three files for every device.
 */
export const MODEL_FILES: Readonly<Record<ModelFileName, SourcedFile>> = {
  model: {
    file: 'all-MiniLM-L6-v2-q8-afdb6f1a.onnx',
    sha256: hexOf([
      175, 219, 111, 26, 14, 69, 183, 21, 208, 187, 155, 17, 119, 47, 3, 44, 57, 155, 171, 210, 59,
      252, 49, 254, 209, 193, 112, 175, 200, 72, 189, 177,
    ]),
    bytes: 22_972_370,
    source:
      'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx',
    license: 'Apache-2.0',
  },
  tokenizer: {
    file: 'all-MiniLM-L6-v2-tokenizer-da0e7993.json',
    sha256: hexOf([
      218, 14, 121, 147, 59, 158, 213, 23, 152, 163, 174, 39, 137, 61, 60, 95, 164, 162, 1, 18, 108,
      239, 117, 88, 98, 150, 223, 155, 77, 44, 98, 160,
    ]),
    bytes: 711_661,
    source:
      'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json',
    license: 'Apache-2.0',
  },
  runtime: {
    file: 'ort-wasm-simd-threaded-4b884c20.wasm',
    sha256: hexOf([
      75, 136, 76, 32, 59, 15, 164, 141, 5, 123, 227, 51, 44, 101, 81, 63, 248, 90, 163, 197, 189,
      221, 105, 70, 172, 192, 250, 183, 236, 218, 0, 29,
    ]),
    bytes: 14_848_852,
    source: 'npm:onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm',
    license: 'MIT',
  },
};

/**
 * A stance model (#478; ADR-0080 §3): a sentence-pair inference model, its
 * tokenizer and the runtime, and which of its outputs is entailment and which
 * contradiction. A two-way model, entailment or not, has no contradiction.
 */
export interface StanceModel {
  readonly files: Readonly<Record<ModelFileName, SourcedFile>>;
  readonly labels: { readonly entailment: number; readonly contradiction?: number };
}

/**
 * The stance model every device would fetch: none (#478). Three small
 * inference models were tried on the corpus's `tune` split, and none that
 * fits the 60 MB budget and ADR-0024 calls a single shared claim agreement,
 * so the judge ships switched off (ADR-0080 §3's amendment): every reason is
 * unverified, and no device downloads a stance model. Pinning one that passes
 * the harness switches it on; its files are then built, fetched and served
 * beside the embedder's ({@link servedFiles}).
 */
export const STANCE_MODEL: StanceModel | null = null;

/** Every file the build serves under `/models/`: the embedder's, then `stance`'s, each once. */
export function servedFiles(stance: StanceModel | null): SourcedFile[] {
  const files = [...Object.values(MODEL_FILES), ...Object.values(stance?.files ?? {})];
  return [...new Map(files.map((pin) => [pin.file, pin])).values()];
}

/** The files the build serves, and every device may fetch, under `/models/`. */
export const SERVED_FILES: readonly SourcedFile[] = servedFiles(STANCE_MODEL);
