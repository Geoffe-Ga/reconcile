/**
 * Builds the service worker (#76) with the app: `src/net/sw.ts` becomes
 * `/sw.js`, holding the list of every file the build writes, so the worker
 * can keep them all on the device.
 *
 * - The worker is one self-contained classic script at the site's root, so
 *   its scope is the whole app and the CSP's `script-src 'self'` allows it.
 *   The build fails if it would import another chunk.
 * - The list holds every chunk and asset (fonts included) and every file in
 *   `public/` (the manifest and icons), with index.html as `/`, the app
 *   shell. `/sw.js` itself isn't on it, and neither is anything under `/v1`:
 *   the relay isn't part of the build.
 * - Its version hashes every URL and file, so `/sw.js` changes, and the
 *   browser installs the new version in the background, whenever any file
 *   does.
 *
 * A small hand-written worker stands in for vite-plugin-pwa, whose
 * workbox-build dependency fails `npm audit` with no patched release.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin, ResolvedConfig } from 'vite';

/**
 * The worker's entry, found from this file rather than from the build's
 * root, so a build of another page with this config (such as
 * e2e/ios-scroll-lock.spec.ts's) still finds it. And the file it becomes.
 */
const ENTRY = fileURLToPath(new URL('../src/net/sw.ts', import.meta.url));
const OUTPUT = 'sw.js';
/** The name `src/net/sw.ts` declares, which the build replaces with the precache list. */
const PLACEHOLDER = '__RECONCILE_PRECACHE__';
/** Hex characters of the version: 64 bits, plenty to tell builds apart. */
const VERSION_LENGTH = 16;

/** One file the build writes: its URL and its contents. */
interface BuiltFile {
  readonly url: string;
  readonly bytes: string | Uint8Array;
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** index.html is the app shell, kept as `/`. Every other file keeps its own path. */
function urlOf(fileName: string): string {
  return fileName === 'index.html' ? '/' : `/${fileName}`;
}

/** Every file under `dir`, as a path relative to it with forward slashes; none if it's absent. */
function filesUnder(dir: string): string[] {
  if (dir === '' || !existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/** The list and version for `files`, sorted so the same build always gives the same worker. */
function precacheFor(files: readonly BuiltFile[]): { version: string; urls: string[] } {
  const sorted = [...files].sort((a, b) => (a.url < b.url ? -1 : 1));
  const digest = sha256(sorted.map((file) => `${file.url}\0${sha256(file.bytes)}`).join('\n'));
  return { version: digest.slice(0, VERSION_LENGTH), urls: sorted.map((file) => file.url) };
}

/** The Vite plugin that emits `/sw.js` and writes its precache list into it. */
export function serviceWorker(): Plugin {
  let config: ResolvedConfig | undefined;
  return {
    name: 'reconcile:service-worker',
    apply: 'build',
    // After Vite's own plugins, so index.html is in the bundle.
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      this.emitFile({ type: 'chunk', id: ENTRY, fileName: OUTPUT });
    },
    generateBundle(_options, bundle) {
      const worker = Object.values(bundle).find((file) => file.fileName === OUTPUT);
      if (worker?.type !== 'chunk') return this.error(`The build is missing ${OUTPUT}.`);
      if (worker.imports.length > 0 || worker.dynamicImports.length > 0) {
        return this.error(`${OUTPUT} must be one script: it imports ${worker.imports.join(', ')}.`);
      }
      const built = Object.values(bundle)
        .filter((file) => file.fileName !== OUTPUT)
        .map((file) => ({
          url: urlOf(file.fileName),
          bytes: file.type === 'chunk' ? file.code : file.source,
        }));
      const publicDir = config?.publicDir ?? '';
      const kept = filesUnder(publicDir).map((name) => ({
        url: urlOf(name),
        bytes: readFileSync(join(publicDir, name)),
      }));
      const parts = worker.code.split(PLACEHOLDER);
      if (parts.length !== 2) {
        return this.error(`${OUTPUT} must name ${PLACEHOLDER} exactly once.`);
      }
      worker.code = parts.join(JSON.stringify(precacheFor([...built, ...kept])));
    },
  };
}
