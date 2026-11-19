/**
 * Vitest's global setup, which runs in Node before any test file: it reads
 * ONNX Runtime Web's WebAssembly from the npm package the lockfile pins and
 * hands it to the tests that run the real runtime on the tiny model
 * (`src/test/tinyModel.ts`, #476), so no test downloads anything. jsdom can't
 * read a file, so the bytes travel as base64.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** ONNX Runtime Web's `ort-wasm-simd-threaded.wasm`, base64. */
    ortWasm: string;
  }
}

export default function setup(project: TestProject): void {
  const wasm = createRequire(import.meta.url).resolve(
    'onnxruntime-web/ort-wasm-simd-threaded.wasm',
  );
  project.provide('ortWasm', readFileSync(wasm).toString('base64'));
}
