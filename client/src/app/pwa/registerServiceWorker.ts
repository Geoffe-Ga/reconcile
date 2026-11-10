/**
 * Registers the service worker that keeps the app shell offline (#76).
 *
 * The worker (`src/net/sw.ts`, built to `/sw.js`) is a file from the app's
 * own origin, so the CSP's `script-src 'self'` allows it, and this module is
 * bundled with the app: nothing is inline. It registers in production only,
 * after the page has loaded, so caching the app never slows the first visit.
 *
 * Updates apply on the next launch (ADR-0057; ADR-0073 drops the prompt). The
 * browser fetches a changed `/sw.js` in the background, and the new worker
 * waits until every Reconcile window has closed. Nothing here hurries it.
 */

/** Where the build puts the worker. At the root, its scope can be the whole app. */
const SERVICE_WORKER_URL = '/sw.js';

/** What registering needs, injected so tests can stand in for the browser. */
export interface ServiceWorkerHost {
  /** Whether this is a production build (`import.meta.env.PROD`). */
  readonly production: boolean;
  /** `navigator.serviceWorker`, or undefined where the browser has none. */
  readonly container: Pick<ServiceWorkerContainer, 'register'> | undefined;
  /** Runs `start` once the page has loaded. */
  readonly afterLoad: (start: () => void) => void;
}

/** Runs `start` now if the page has loaded, else once its `load` event fires. */
export function afterLoad(start: () => void): void {
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/**
 * Registers `/sw.js` for the whole app, once, in production. A browser that
 * refuses (a private window, say) still runs the app, just not offline.
 */
export function registerServiceWorker(host: ServiceWorkerHost): void {
  const { production, container } = host;
  if (!production || container === undefined) return;
  host.afterLoad(() => {
    container.register(SERVICE_WORKER_URL, { scope: '/' }).catch(() => undefined);
  });
}
