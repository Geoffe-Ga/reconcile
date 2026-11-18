/**
 * ONNX Runtime Web's WebAssembly for unit tests (#476), read from the npm
 * package the lockfile pins by Vitest's global setup (`test/globalSetup.ts`),
 * which runs in Node, and handed over as base64, since jsdom can't read a
 * file. No test downloads anything.
 */
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** ONNX Runtime Web's `ort-wasm-simd-threaded.wasm`, base64 (`test/globalSetup.ts`). */
    ortWasm: string;
  }
}

/** ONNX Runtime Web's WebAssembly, from the npm package the lockfile pins: no download. */
export function ortWasm(): Uint8Array {
  return Uint8Array.from(atob(inject('ortWasm')), (c) => c.charCodeAt(0));
}
