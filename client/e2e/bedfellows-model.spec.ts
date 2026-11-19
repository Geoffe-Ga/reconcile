/**
 * The Bedfellows model under the deploy CSP (#476; ADR-0080 §2).
 *
 * This builds the test-only page in e2e/bedfellows-model/ into a temp
 * directory, as e2e/bedfellows-worker.spec.ts does, and serves it with
 * `vite preview` and the app's own vite.config.ts, which sends the deploy
 * CSP. The page's worker runs the real embedder module and the real runtime,
 * ONNX Runtime Web's WebAssembly from the npm package, on a tiny model the
 * spec writes into the build's `models/` (`src/test/tinyModel.ts`), so no
 * test downloads anything from a third party.
 *
 * - Nothing under `/models/` is fetched until the page asks for a vector, and
 *   every request the page, its workers and the service worker send is to
 *   our own origin. The worker computes vectors with no CSP violation.
 * - A file that doesn't match its pin is refused.
 * - Control: the same page under the same CSP without `'wasm-unsafe-eval'`
 *   can't compile the runtime, and the worker sees the violation.
 * - In Chromium, the service worker keeps the files once fetched, and a
 *   reload offline computes the same vectors.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

import { MODEL_FILES, type ModelPins, type PinnedFile } from '../src/net/modelPins';
import { TINY_VOCAB, tinyModelOnnx, tinyTokenizerJson, tinyVectorOf } from '../src/test/tinyModel';
import type { BedfellowsModelPage } from './bedfellows-model/main';

const CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const PAGE = fileURLToPath(new URL('bedfellows-model', import.meta.url));

/** Where the init script below collects the page's own `securitypolicyviolation` events. */
const VIOLATIONS = 'e2eCspViolations';

/** A pin for `bytes`, served as `models/<name>-<hash>.<extension>`. */
function pinOf(name: string, extension: string, bytes: Uint8Array): PinnedFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { file: `${name}-${sha256.slice(0, 8)}.${extension}`, sha256, bytes: bytes.length };
}

const TINY_MODEL = tinyModelOnnx();
const TINY_TOKENIZER = new TextEncoder().encode(tinyTokenizerJson());

/** The tiny model and tokenizer, with the real runtime, which the build copies from npm. */
const PINS: ModelPins = {
  model: pinOf('tiny-model', 'onnx', TINY_MODEL),
  tokenizer: pinOf('tiny-tokenizer', 'json', TINY_TOKENIZER),
  runtime: MODEL_FILES.runtime,
};

const SENTENCES = ['Keep the reading room open.', 'Our chess boards'];

/** The tiny model's vector for `tokens`: their rows averaged, then scaled to unit length. */
function expected(tokens: readonly string[]): number[] {
  const rows = tokens.map((token) => tinyVectorOf(TINY_VOCAB.indexOf(token)));
  const mean = Array.from(
    { length: rows[0]?.length ?? 0 },
    (_, d) => rows.reduce((sum, row) => sum + (row[d] ?? 0), 0) / rows.length,
  );
  const length = Math.hypot(...mean);
  return mean.map((x) => x / length);
}

/** What the page's two sentences must embed to. */
const VECTORS = [
  expected(['[CLS]', 'keep', 'the', 'reading', 'room', 'open', '.', '[SEP]']),
  expected(['[CLS]', 'our', 'chess', 'board', '##s', '[SEP]']),
];

/** Runs in the page before any script: collects each CSP violation on `window`. */
function recordCspViolations(key: string): void {
  const seen: string[] = [];
  Reflect.set(window, key, seen);
  window.addEventListener(
    'securitypolicyviolation',
    (event) => {
      seen.push(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`);
    },
    true,
  );
}

/** The CSP `server` sends: the one vite.config.ts sets, unless overridden. */
function cspOf(server: PreviewServer): string {
  const csp = server.config.preview.headers['Content-Security-Policy'];
  if (typeof csp !== 'string') {
    throw new Error('vite.config.ts no longer sends a Content-Security-Policy under preview.');
  }
  return csp;
}

/** `vite preview` of the built page, with the app's config and, if given, another CSP. */
async function serve(outDir: string, csp?: string): Promise<PreviewServer> {
  return preview({
    configFile: CONFIG,
    root: PAGE,
    logLevel: 'warn',
    build: { outDir },
    preview: {
      host: '127.0.0.1',
      port: 0,
      ...(csp === undefined ? {} : { headers: { 'Content-Security-Policy': csp } }),
    },
  });
}

/** A server `beforeAll` started. */
function started(server: PreviewServer | undefined): PreviewServer {
  if (server === undefined) throw new Error('beforeAll started no server.');
  return server;
}

/** The address `server` listens on. */
function urlOf(server: PreviewServer | undefined): string {
  const url = started(server).resolvedUrls?.local[0];
  if (url === undefined) throw new Error('vite preview reported no local URL.');
  return url;
}

/** A browser profile under the CSP, recording every request it sends, its service worker's included. */
async function profile(browser: Browser): Promise<{ context: BrowserContext; requests: string[] }> {
  const context = await browser.newContext({ bypassCSP: false });
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  await context.addInitScript(recordCspViolations, VIOLATIONS);
  return { context, requests };
}

/** The page's vectors for `sentences` from the model `pins` names, or the name of the error it failed with. */
async function embedOn(
  page: Page,
  pins: ModelPins,
): Promise<{ vectors: readonly (readonly number[])[] } | { failed: string }> {
  return page.evaluate(
    async ({ sentences, pins: chosen }) => {
      const model = Reflect.get(window, 'bedfellowsModel') as BedfellowsModelPage;
      try {
        return { vectors: await model.embed(sentences, chosen) };
      } catch (error) {
        return { failed: error instanceof Error ? error.name : String(error) };
      }
    },
    { sentences: SENTENCES, pins },
  );
}

/** Every CSP violation the page and its worker saw, once any queued report has arrived. */
async function violationsOn(page: Page): Promise<string[]> {
  return page.evaluate(async (key) => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
    const model = Reflect.get(window, 'bedfellowsModel') as BedfellowsModelPage;
    return [...(Reflect.get(window, key) as string[]), ...model.violations];
  }, VIOLATIONS);
}

/** Asserts each of `got` is the expected vector, to float precision. */
function expectVectors(
  got: { vectors: readonly (readonly number[])[] } | { failed: string },
): void {
  expect(got).toHaveProperty('vectors');
  const vectors = 'vectors' in got ? got.vectors : [];
  expect(vectors).toHaveLength(VECTORS.length);
  vectors.forEach((vector, i) => {
    (VECTORS[i] ?? []).forEach((x, d) => {
      expect(vector[d]).toBeCloseTo(x, 5);
    });
  });
}

let outDir = '';
let publicDir = '';
let deploy: PreviewServer | undefined;
let control: PreviewServer | undefined;

test.beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'reconcile-bedfellows-model-'));
  publicDir = await mkdtemp(join(tmpdir(), 'reconcile-bedfellows-model-public-'));
  // The tiny model's files go in through the page's public directory, so the
  // service worker plugin lists them under models/ like the real ones.
  await mkdir(join(publicDir, 'models'));
  await writeFile(join(publicDir, 'models', PINS.model.file), TINY_MODEL);
  await writeFile(join(publicDir, 'models', PINS.tokenizer.file), TINY_TOKENIZER);
  await build({
    configFile: CONFIG,
    root: PAGE,
    publicDir,
    logLevel: 'error',
    build: { outDir, emptyOutDir: true },
  });
  deploy = await serve(outDir);
  control = await serve(outDir, cspOf(deploy).replace(" 'wasm-unsafe-eval'", ''));
});

test.afterAll(async () => {
  for (const server of [deploy, control]) await server?.close();
  for (const dir of [outDir, publicDir]) {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  }
});

test('loads the model only when asked, from our own origin, and embeds under the deploy CSP', async ({
  browser,
}) => {
  const url = urlOf(deploy);
  const origin = new URL(url).origin;
  const { context, requests } = await profile(browser);
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    const beforeAsking = requests.filter((request) =>
      new URL(request).pathname.startsWith('/models/'),
    );

    const got = await embedOn(page, PINS);

    expect(beforeAsking, 'nothing under /models/ before the first ask').toEqual([]);
    expectVectors(got);
    const models = [...new Set(requests.map((request) => new URL(request).pathname))].filter(
      (path) => path.startsWith('/models/'),
    );
    expect(models.sort()).toEqual(
      Object.values(PINS)
        .map((pin) => `/models/${pin.file}`)
        .sort(),
    );
    expect(await violationsOn(page), 'CSP violations').toEqual([]);
    for (const request of requests) expect(request.startsWith(`${origin}/`), request).toBe(true);
  } finally {
    await context.close();
  }
});

test('refuses a file that doesn’t match its pin', async ({ browser }) => {
  const { context } = await profile(browser);
  try {
    const page = await context.newPage();
    await page.goto(urlOf(deploy));
    const wrong = PINS.tokenizer.sha256.replace(/^./, (c) => (c === '0' ? '1' : '0'));

    const got = await embedOn(page, { ...PINS, tokenizer: { ...PINS.tokenizer, sha256: wrong } });

    expect(got).toEqual({ failed: 'PinMismatchError' });
    expect(await violationsOn(page), 'CSP violations').toEqual([]);
  } finally {
    await context.close();
  }
});

test('control: without wasm-unsafe-eval the runtime can’t compile, and the worker sees the violation', async ({
  browser,
  browserName,
}) => {
  expect(cspOf(started(deploy))).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(cspOf(started(control))).not.toContain('wasm-unsafe-eval');
  const { context } = await profile(browser);
  try {
    const page = await context.newPage();
    await page.goto(urlOf(control));

    const got = await embedOn(page, PINS);

    // The same page under the deploy CSP embeds (the tests above, in every browser), so
    // the keyword is the whole difference: here the run fails with a named error.
    expect(got).toEqual({ failed: expect.any(String) });
    const violations = await violationsOn(page);
    for (const line of violations) expect(line).toMatch(/^script-src blocked wasm-eval$/);
    // Chromium reports the blocked compile as a securitypolicyviolation event. WebKit
    // refuses the compile just the same but fires no event for it (seen in CI), so the
    // report is checked where the browser makes one.
    if (browserName === 'chromium') expect(violations, 'CSP violations').not.toEqual([]);
  } finally {
    await context.close();
  }
});

test('the service worker keeps the files once fetched, so a reload offline embeds the same', async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Playwright takes the network away from a service worker only in Chromium (#76).',
  );
  const { context } = await profile(browser);
  try {
    const page = await context.newPage();
    await page.goto(urlOf(deploy));
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Reload so the page, and so the worker it starts, are under the service worker.
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expectVectors(await embedOn(page, PINS));

    await context.setOffline(true);
    await page.reload();

    expectVectors(await embedOn(page, PINS));
    expect(await violationsOn(page), 'CSP violations').toEqual([]);
  } finally {
    await context.close();
  }
});
