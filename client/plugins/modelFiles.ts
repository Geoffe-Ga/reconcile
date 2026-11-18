/**
 * Puts the Bedfellows model's files in the build, under `models/`, each
 * checked against its pin (#476; ADR-0080 §2; `src/net/modelPins.ts`): the
 * embedder's, and a stance model's once one is pinned (#478).
 *
 * - The runtime's WebAssembly comes from the npm package the lockfile pins.
 * - The model and its tokenizer are too large for git: `scripts/models.sh`
 *   fetches them, at a fixed revision and checked by hash, into
 *   `client/.models/`, and this copies them from there.
 * - A file whose hash doesn't match fails the build. A missing model or
 *   tokenizer is a warning, so a build with no network access (CI's, the e2e
 *   specs') still works, with the stand-in models; `RECONCILE_MODELS=required`,
 *   which deploy/deploy.sh sets, makes it an error.
 * - `models/NOTICE.txt` names each file's source and license.
 *
 * The service worker plugin keeps everything under `models/` out of the
 * install and lists it to keep on first use instead.
 *
 * {@link ortWasmUrl} is for the workers' build: it stops Vite from copying
 * the runtime's WebAssembly into `assets/` a second time.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite';

import { MODEL_FILES, SERVED_FILES, type SourcedFile } from '../src/net/modelPins.ts';

/** Where `scripts/models.sh` leaves the files it fetched. */
const CACHE = fileURLToPath(new URL('../.models', import.meta.url));
/** The notice's own words; the Apache License's text follows them. */
const NOTICE = fileURLToPath(new URL('modelNotice.txt', import.meta.url));

const require = createRequire(import.meta.url);

/**
 * npm package `name`'s directory, found from its entry, since its `exports` may hide package.json.
 *
 * It assumes the package sits in a directory named `node_modules/<name>`,
 * a scoped name as two segments (`node_modules/@scope/pkg`), with its entry
 * somewhere inside it: it walks up from `require.resolve(name)` to the first
 * directory that ends in that path and holds a package.json. npm's layout,
 * hoisted or nested, and pnpm's store both fit. A package installed under
 * another directory name, or whose entry lies outside its own directory,
 * walks up to the filesystem's root and throws.
 */
function packageDir(name: string): string {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, 'package.json')) || !dir.endsWith(join('node_modules', name))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`Can't find the npm package ${name}.`);
    dir = up;
  }
  return dir;
}

/** Where the build reads `pin` from: the npm package for an `npm:` source, else the fetched copy. */
function sourceOf(pin: SourcedFile): string {
  if (!pin.source.startsWith('npm:')) return join(CACHE, pin.file);
  const match = /^npm:((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(pin.source);
  if (match === null) throw new Error(`${pin.file}'s source isn't npm:<package>@<version>/<path>.`);
  return join(packageDir(match[1]), match[2]);
}

/** Whether `bytes` are `pin`'s. */
function matches(pin: SourcedFile, bytes: Buffer): boolean {
  return (
    bytes.length === pin.bytes && createHash('sha256').update(bytes).digest('hex') === pin.sha256
  );
}

/** The Vite plugin that writes `models/` into the build. */
export function modelFiles(required = process.env.RECONCILE_MODELS === 'required'): Plugin {
  return {
    name: 'reconcile:model-files',
    apply: 'build',
    buildStart() {
      const missing: string[] = [];
      for (const pin of SERVED_FILES) {
        const source = sourceOf(pin);
        if (!existsSync(source)) {
          missing.push(pin.file);
          continue;
        }
        const bytes = readFileSync(source);
        if (!matches(pin, bytes)) this.error(`${source} isn't the file src/net/modelPins.ts pins.`);
        this.emitFile({ type: 'asset', fileName: `models/${pin.file}`, source: bytes });
      }
      if (missing.length > 0) {
        const message = `No ${missing.join(', ')} in client/.models/: run client/scripts/models.sh. Bedfellows' model won't load from this build.`;
        if (required) this.error(message);
        this.warn(message);
      }
      const apache = readFileSync(join(packageDir('@huggingface/tokenizers'), 'LICENSE'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'models/NOTICE.txt',
        source: `${readFileSync(NOTICE, 'utf8')}\n${apache}`,
      });
    },
  };
}

/** Where ONNX Runtime Web's bundle points at its WebAssembly, which Vite would copy into `assets/`. */
const ORT_WASM_URL = 'new URL("ort-wasm-simd-threaded.wasm",import.meta.url).href';

/**
 * The Vite plugin, for the workers' build, that points ONNX Runtime Web at the
 * pinned copy under `/models/` instead of its own file. The runtime is handed
 * its checked bytes (`src/bedfellows/runtime.ts`) and never fetches either,
 * but left alone, Vite would copy the 15 MB file into `assets/`, where the
 * service worker would download it at install. A runtime upgrade that moves
 * the reference fails the build here rather than shipping that copy.
 */
export function ortWasmUrl(): Plugin {
  return {
    name: 'reconcile:ort-wasm-url',
    enforce: 'pre',
    transform(code, id) {
      if (!/onnxruntime-web[/\\]dist[/\\]ort\.wasm\.bundle\.min\.mjs$/.test(id)) return null;
      if (!code.includes(ORT_WASM_URL)) {
        this.error(`${id} no longer points at its WebAssembly as ${ORT_WASM_URL}.`);
      }
      return code.replaceAll(ORT_WASM_URL, JSON.stringify(`/models/${MODEL_FILES.runtime.file}`));
    },
  };
}
