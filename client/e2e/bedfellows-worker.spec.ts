/**
 * The Bedfellows worker under the deploy CSP (#475).
 *
 * Bedfellows runs its pipeline in a module Worker that Vite builds from the
 * app's own origin. No screen starts it yet (#433 wires the view), so this
 * builds the test-only page in e2e/bedfellows-worker/ into a temp directory
 * and serves it with `vite preview` and the app's own vite.config.ts, which
 * sends the deploy CSP, as e2e/ios-scroll-lock.spec.ts does. The page starts
 * the client; the spec sends it runs and reads the rows back.
 *
 * A run without the model matches by term overlap (#477). A run that asks for
 * the model finds no model files here (the spec deletes the build's
 * `models/`, so the run is the same with or without them on the machine):
 * the worker asks our own origin for them, fails to load, and answers with
 * the same term-overlap rows rather than an error.
 *
 * The control serves the same page under the same CSP with `child-src 'none'`
 * added, which every browser applies to workers. The worker must then fail to
 * load and the page must see the violation, or the first test isn't testing
 * anything.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, expect, test } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

import type { BedfellowsClient } from '../src/bedfellows/client';
import type { BedfellowsInput, Row } from '../src/bedfellows/types';

const CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const PAGE = fileURLToPath(new URL('bedfellows-worker', import.meta.url));

/** Where the init script below collects `securitypolicyviolation` events. */
const VIOLATIONS = 'e2eCspViolations';

/** Where the test page puts its client. */
const CLIENT = 'bedfellowsClient';

/** The issue's example: one Document and two entries, one of which shares its subject. */
const INPUT: BedfellowsInput = {
  reader: [{ title: 'Ours', text: 'Keep the library open on Sundays.' }],
  entries: [
    { id: 'e1', title: '', text: 'We want the library open.' },
    { id: 'e2', title: '', text: 'Feed the ducks at the pond.' },
  ],
  dial: 0,
};

/** What a page saw of its runs. */
interface Seen {
  /** The first run's rows, or the name of the error it rejected with. */
  readonly first: { readonly rows: readonly Row[] } | { readonly failed: string };
  /** The name of the error a run cancelled at once rejected with. */
  readonly cancelled: string;
  /** A run after the cancel: its rows, or the name of its error. */
  readonly after: { readonly rows: readonly Row[] } | { readonly failed: string };
  /** A run that asks for the model, which can't load here: its rows, or the name of its error. */
  readonly withModel: { readonly rows: readonly Row[] } | { readonly failed: string };
  /** Each CSP violation, as "directive blocked URI". */
  readonly violations: readonly string[];
  /** The URL of each worker the page started. */
  readonly workers: readonly string[];
  /** Every request the page and its worker sent. */
  readonly requests: readonly string[];
}

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

/** The address `server` listens on. */
function urlOf(server: PreviewServer): string {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('vite preview reported no local URL.');
  return url;
}

/**
 * Opens the page, sends the client a run, a run it cancels at once, and one
 * more, and reports what it saw.
 */
async function runOnPage(browser: Browser, url: string): Promise<Seen> {
  const context = await browser.newContext({ bypassCSP: false });
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  try {
    await context.addInitScript(recordCspViolations, VIOLATIONS);
    const page = await context.newPage();
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    await page.goto(url);
    const seen = await page.evaluate(
      async ({ key, client, input }) => {
        const bedfellows = Reflect.get(window, client) as BedfellowsClient;
        /** A run's rows, or the name of the error it failed with. */
        async function settled(rows: () => Promise<Row[]>) {
          try {
            return { rows: await rows() };
          } catch (error) {
            return { failed: error instanceof Error ? error.name : String(error) };
          }
        }
        const first = await settled(() => bedfellows.run(input).rows);
        const doomed = bedfellows.run(input);
        doomed.cancel();
        const cancelled = await settled(() => doomed.rows);
        const after = await settled(() => bedfellows.run(input).rows);
        const withModel = await settled(() => bedfellows.run(input, { model: true }).rows);
        // A frame and then a task, so any queued violation report has arrived.
        await new Promise((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        });
        return {
          first,
          cancelled: 'failed' in cancelled ? cancelled.failed : 'answered',
          after,
          withModel,
          violations: Reflect.get(window, key) as string[],
        };
      },
      { key: VIOLATIONS, client: CLIENT, input: INPUT },
    );
    return { ...seen, workers, requests };
  } finally {
    await context.close();
  }
}

let outDir = '';
let deploy: PreviewServer | undefined;
let control: PreviewServer | undefined;

/** A server `beforeAll` started. */
function started(server: PreviewServer | undefined): PreviewServer {
  if (server === undefined) throw new Error('beforeAll started no server.');
  return server;
}

test.beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'reconcile-bedfellows-worker-'));
  await build({
    configFile: CONFIG,
    root: PAGE,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  // The build writes the real model's files where the machine has them; without them every
  // machine runs this spec the same way, as a device whose model won't load.
  await rm(join(outDir, 'models'), { recursive: true, force: true });
  deploy = await serve(outDir);
  control = await serve(outDir, `${cspOf(deploy)}; child-src 'none'`);
});

test.afterAll(async () => {
  for (const server of [deploy, control]) await server?.close();
  if (outDir !== '') await rm(outDir, { recursive: true, force: true });
});

test('the Bedfellows worker loads under the deploy CSP, answers, can be cancelled, and falls back when the model won’t load', async ({
  browser,
}) => {
  const origin = new URL(urlOf(started(deploy))).origin;

  const seen = await runOnPage(browser, urlOf(started(deploy)));

  expect(seen.violations, 'CSP violations').toEqual([]);
  expect(seen.first).toEqual({
    rows: [
      {
        entryId: 'e1',
        tier: 'close',
        reason: {
          entrySentence: 'We want the library open.',
          readerSentence: 'Keep the library open on Sundays.',
          verified: false,
        },
      },
    ],
  });
  expect(seen.cancelled, 'a cancelled run rejects').toBe('AbortError');
  expect(seen.after, 'the worker answers after a cancel').toEqual(seen.first);
  expect(seen.withModel, 'a run whose model won’t load falls back to term overlap').toEqual(
    seen.first,
  );
  expect(
    seen.requests.some((request) => new URL(request).pathname.startsWith('/models/')),
    'the run with the model asked our own origin for it',
  ).toBe(true);
  expect(seen.workers, 'one worker, a script from our own origin').toHaveLength(1);
  for (const worker of seen.workers) {
    expect(worker.startsWith(`${origin}/assets/`), worker).toBe(true);
    expect(worker.endsWith('.js'), worker).toBe(true);
  }
  for (const request of seen.requests) expect(request.startsWith(`${origin}/`), request).toBe(true);
});

test('control: a CSP that allows no worker blocks it, and the page sees the violation', async ({
  browser,
}) => {
  expect(cspOf(started(control)), 'the control adds child-src').not.toBe(cspOf(started(deploy)));

  const seen = await runOnPage(browser, urlOf(started(control)));

  expect(seen.first).not.toHaveProperty('rows');
  expect(seen.violations, 'CSP violations').not.toEqual([]);
  for (const line of seen.violations) expect(line).toMatch(/^(worker|child)-src blocked /);
});
