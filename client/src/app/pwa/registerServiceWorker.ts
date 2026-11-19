/**
 * Registers the service worker that keeps the app shell offline (#76).
 *
 * The worker (`src/net/sw.ts`, built to `/sw.js`) is a file from the app's
 * own origin, so the CSP's `script-src 'self'` allows it, and this module is
 * bundled with the app: nothing is inline. It registers in production only,
 * after the page has loaded, so caching the app never slows the first visit.
 *
 * Updates apply on the next launch (ADR-0057). The browser fetches a changed
 * `/sw.js` in the background, and the new worker waits until every Reconcile
 * window has closed. Nothing here hurries it: no `update()`, no message to
 * the worker, no `skipWaiting`. It only reports that a new version is
 * installed and waiting, so the app can say so (#513; ADR-0073's 2026-11-19
 * amendment): an iPhone's installed app is suspended rather than closed, so
 * without the line a tester can run an old build for days.
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
  /** Called each time a new version is installed and waiting for the next launch. */
  readonly onWaiting: () => void;
}

/** The parts of a registration this module reads. */
type Registration = Pick<
  ServiceWorkerRegistration,
  'active' | 'waiting' | 'installing' | 'addEventListener'
>;

/** Runs `start` now if the page has loaded, else once its `load` event fires. */
export function afterLoad(start: () => void): void {
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/**
 * Reports a new version when one is waiting: installed while another version
 * is active. The first install has nothing to wait for, and a worker that
 * already took over or failed isn't waiting.
 */
function reportIfWaiting(registration: Registration, onWaiting: () => void): void {
  if (registration.waiting !== null && registration.active !== null) onWaiting();
}

/**
 * Watches `registration` for a new version: one already waiting at launch,
 * and each one the browser finds later, once it reaches `installed`.
 */
function watchForWaiting(registration: Registration, onWaiting: () => void): void {
  reportIfWaiting(registration, onWaiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') reportIfWaiting(registration, onWaiting);
    });
  });
}

/**
 * Registers `/sw.js` for the whole app, once, in production, and reports
 * each new version that waits. A browser that refuses (a private window,
 * say) still runs the app, just not offline.
 */
export function registerServiceWorker(host: ServiceWorkerHost): void {
  const { production, container, onWaiting } = host;
  if (!production || container === undefined) return;
  host.afterLoad(() => {
    container
      .register(SERVICE_WORKER_URL, { scope: '/' })
      .then((registration) => {
        watchForWaiting(registration, onWaiting);
      })
      .catch(() => undefined);
  });
}
