/**
 * React Aria's iOS scroll lock under the deploy CSP (#153).
 *
 * On iOS and iPadOS, an open React Aria Modal prepends an inline `<style>`,
 * which the deploy CSP allows by its hash in style-src-elem. The app has no
 * modal yet (#77's Leave dialog is the first), so this builds the test-only
 * page in e2e/ios-modal/ into a temp directory and serves it with
 * `vite preview` and the app's own vite.config.ts, which sends the deploy CSP.
 * Each browser poses as an iPhone, so React Aria takes its iOS path.
 *
 * The control serves the same page under the same CSP without that hash. It
 * must show the violation and leave the style unapplied, or the first test
 * isn't testing anything.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, devices, expect, test } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const PAGE = fileURLToPath(new URL('ios-modal', import.meta.url));

/** Where the init script below collects `securitypolicyviolation` events. */
const VIOLATIONS = 'e2eCspViolations';

/** What a page showed with the Modal open. */
interface Seen {
  /** The text of each `<style>` in `<head>`. */
  readonly styles: readonly string[];
  /** The root's computed overscroll-behavior-y: `contain` once the scroll-lock style applies. */
  readonly overscroll: string;
  /** Each CSP violation, as "directive blocked URI". */
  readonly violations: readonly string[];
}

/**
 * Runs in the page before any script. React Aria's isIOS() reads
 * navigator.platform, which Playwright's iPhone doesn't set, so this makes it
 * read as an iPhone's. Chromium's userAgentData would answer first, so it goes.
 */
function emulateIosPlatform(): void {
  for (const [name, value] of [
    ['platform', 'iPhone'],
    ['userAgentData', undefined],
  ] as const) {
    Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
  }
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

/** Opens the page as an iPhone, taps the button that opens the Modal, and reports what it saw. */
async function openModalOnIPhone(browser: Browser, url: string): Promise<Seen> {
  const context = await browser.newContext({ ...devices['iPhone 15'], bypassCSP: false });
  try {
    await context.addInitScript(emulateIosPlatform);
    await context.addInitScript(recordCspViolations, VIOLATIONS);
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole('button', { name: 'Open the dialog' }).tap();
    await expect(page.getByRole('dialog', { name: 'A React Aria Modal' })).toBeVisible();
    return await page.evaluate(async (key) => {
      // A frame and then a task, so any queued violation report has arrived.
      await new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      });
      return {
        styles: [...document.head.querySelectorAll('style')].map((style) => style.textContent),
        overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
        violations: Reflect.get(window, key) as string[],
      };
    }, VIOLATIONS);
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
  outDir = await mkdtemp(join(tmpdir(), 'reconcile-ios-modal-'));
  await build({
    configFile: CONFIG,
    root: PAGE,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  deploy = await serve(outDir);
  const withoutHash = cspOf(deploy)
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => !directive.startsWith('style-src-elem '))
    .join('; ');
  control = await serve(outDir, withoutHash);
});

test.afterAll(async () => {
  for (const server of [deploy, control]) await server?.close();
  if (outDir !== '') await rm(outDir, { recursive: true, force: true });
});

test('on an iPhone, an open Modal’s scroll-lock style applies under the deploy CSP', async ({
  browser,
}) => {
  const seen = await openModalOnIPhone(browser, urlOf(started(deploy)));

  expect(seen.styles, 'React Aria took its iOS path').toHaveLength(1);
  expect(seen.violations, 'CSP violations').toEqual([]);
  expect(seen.overscroll, 'the scroll-lock style applied').toBe('contain');
});

test('control: without its hash, the CSP blocks the same style', async ({ browser }) => {
  expect(cspOf(started(control)), 'the control drops style-src-elem').not.toBe(
    cspOf(started(deploy)),
  );

  const seen = await openModalOnIPhone(browser, urlOf(started(control)));

  expect(seen.styles, 'React Aria took its iOS path').toHaveLength(1);
  expect(seen.overscroll, 'the CSP left the style unapplied').toBe('auto');
  expect(seen.violations, 'CSP violations').not.toEqual([]);
  for (const line of seen.violations) expect(line).toMatch(/^style-src(-elem)? blocked inline$/);
});
