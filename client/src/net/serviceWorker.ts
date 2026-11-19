/**
 * The service worker (#76): it keeps the built app on the device, so
 * Reconcile opens offline and shows what it last synced from IndexedDB.
 *
 * - **Install** fetches every file of this build into a cache named for its
 *   version, revalidating each with the server rather than trusting the HTTP
 *   cache. If any file fails, the install fails and the browser tries again.
 * - **Activate** deletes the caches older versions left.
 * - **Fetch** answers page loads with the app shell (`/`, which is
 *   index.html) and the build's own files from that cache. Everything else
 *   goes to the network untouched. Nothing under `/v1`, the relay, is ever
 *   cached or answered here (spec §7).
 * - **Kept on first use** (#476): the Bedfellows model's files are part of
 *   the build but not of the install, so the app never downloads them at
 *   start. The first time something asks for one, the worker fetches it and
 *   keeps it in `reconcile-models`, which outlives versions; every later ask,
 *   offline too, is answered from there. Activate drops a kept file the
 *   build no longer lists. The page checks each file's hash itself
 *   (`src/net/modelFiles.ts`), whichever answered it.
 *
 * - **Push** (#99) shows one fixed notification, "Something new in Reconcile",
 *   whatever the push carries (the relay's carry nothing), closing the last
 *   first only where its tag doesn't replace it, and a tap on it opens the
 *   app, which syncs (`src/sw/notify.ts`).
 *
 * It never calls `skipWaiting()` or `clients.claim()`: a new version installs
 * in the background and takes over at the next launch, once every Reconcile
 * window has closed (ADR-0057). The page only says that one waits (#513,
 * `src/app/pwa/registerServiceWorker.ts`; ADR-0073's 2026-11-19 amendment).
 *
 * This lives in src/net/ because it handles the app's requests (spec §2).
 * `./sw.ts` starts it on the worker's global scope; the build writes the
 * precache list into that file (`client/plugins/serviceWorker.ts`).
 */

import {
  type NotificationInterface,
  type NotifyRegistration,
  openApp,
  replacesByTag,
  type ShownNotification,
  showSomethingNew,
  type WindowClients,
} from '../sw/notify';

/** What the build hands the worker: the files to keep, and a version naming them. */
export interface Precache {
  /** A hash of every URL and its bytes, so it changes whenever any file does. */
  readonly version: string;
  /** Every file of the build as a root-relative URL. `/` is index.html, the app shell. */
  readonly urls: readonly string[];
  /** Files of the build kept only once something asks for them: the model's (#476). */
  readonly lazy: readonly string[];
}

/** The parts of an `ExtendableEvent` the worker uses. */
export interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/** The parts of a `NotificationEvent` the worker uses: which notification was tapped. */
export interface TapEvent extends WaitUntilEvent {
  readonly notification: ShownNotification;
}

/** The parts of a `FetchEvent` the worker uses. */
export interface RequestEvent extends WaitUntilEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

/** The parts of `ServiceWorkerGlobalScope` the worker uses. */
export interface WorkerScope {
  readonly caches: CacheStorage;
  readonly location: { readonly origin: string };
  readonly registration: NotifyRegistration;
  readonly clients: WindowClients;
  /** The worker's `Notification`, which TypeScript's worker library leaves off the scope. */
  readonly Notification?: NotificationInterface;
  fetch(request: Request): Promise<Response>;
  addEventListener(
    type: 'install' | 'activate' | 'push',
    listener: (event: WaitUntilEvent) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: RequestEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: TapEvent) => void): void;
}

/** How the worker answers a request. */
export type Answer = 'network' | 'app-shell' | 'precached' | 'lazy';

/** Every cache this worker owns starts with this, so activate deletes only its own. */
const CACHE_PREFIX = 'reconcile-app-';

/** The cache of files kept on first use (#476). Its name has no version: it outlives them. */
const KEPT_ON_USE = 'reconcile-models';

/** The key of the app shell, which every page load gets. */
const APP_SHELL = '/';

/** The relay's API (spec §6). */
const RELAY = /^\/v1(\/|$)/;

function cacheName(precache: Precache): string {
  return `${CACHE_PREFIX}${precache.version}`;
}

/**
 * How to answer `request`: the network for anything that isn't a same-origin
 * GET, and always for the relay; the app shell for any page load; the cache
 * for a file of this build, asked for exactly, kept at install (`urls`) or on
 * first use (`lazy`).
 */
export function answerFor(
  request: Pick<Request, 'url' | 'method' | 'mode'>,
  origin: string,
  urls: ReadonlySet<string>,
  lazy: ReadonlySet<string> = new Set(),
): Answer {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin || RELAY.test(url.pathname)) {
    return 'network';
  }
  if (request.mode === 'navigate') return 'app-shell';
  if (url.search !== '') return 'network';
  if (urls.has(url.pathname)) return 'precached';
  return lazy.has(url.pathname) ? 'lazy' : 'network';
}

async function install(scope: WorkerScope, precache: Precache): Promise<void> {
  const cache = await scope.caches.open(cacheName(precache));
  const { origin } = scope.location;
  await cache.addAll(
    precache.urls.map((url) => new Request(new URL(url, origin), { cache: 'no-cache' })),
  );
}

async function activate(scope: WorkerScope, precache: Precache): Promise<void> {
  const current = cacheName(precache);
  const stale = (await scope.caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== current,
  );
  await Promise.all(stale.map((name) => scope.caches.delete(name)));
  await dropUnlisted(scope, precache);
}

/** Deletes every file kept on first use that this version doesn't list. */
async function dropUnlisted(scope: WorkerScope, precache: Precache): Promise<void> {
  const listed = new Set(precache.lazy);
  const cache = await scope.caches.open(KEPT_ON_USE);
  const gone = (await cache.keys()).filter((kept) => !listed.has(new URL(kept.url).pathname));
  await Promise.all(gone.map((kept) => cache.delete(kept)));
}

/** The file `request` asks for, from the cache, or else from the network, kept if it came. */
async function keptOnUse(scope: WorkerScope, request: Request): Promise<Response> {
  const cache = await scope.caches.open(KEPT_ON_USE);
  const key = new URL(new URL(request.url).pathname, scope.location.origin).href;
  const kept = await cache.match(key);
  if (kept !== undefined) return kept;
  const response = await scope.fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

/** The kept file at `path`, or the network's answer if it's missing from the cache. */
async function fromCache(
  scope: WorkerScope,
  precache: Precache,
  path: string,
  request: Request,
): Promise<Response> {
  const cache = await scope.caches.open(cacheName(precache));
  const kept = await cache.match(new URL(path, scope.location.origin).href);
  return kept ?? scope.fetch(request);
}

/** Starts the worker on `scope` for this build's `precache`. */
export function startServiceWorker(scope: WorkerScope, precache: Precache): void {
  const urls = new Set(precache.urls);
  const lazy = new Set(precache.lazy);
  scope.addEventListener('install', (event) => {
    event.waitUntil(install(scope, precache));
  });
  scope.addEventListener('activate', (event) => {
    event.waitUntil(activate(scope, precache));
  });
  scope.addEventListener('fetch', (event) => {
    const { request } = event;
    const answer = answerFor(request, scope.location.origin, urls, lazy);
    if (answer === 'network') return;
    if (answer === 'lazy') {
      event.respondWith(keptOnUse(scope, request));
      return;
    }
    const path = answer === 'app-shell' ? APP_SHELL : new URL(request.url).pathname;
    event.respondWith(fromCache(scope, precache, path, request));
  });
  // The push's data is never read: what shows is fixed (#99).
  const replaces = replacesByTag(scope.Notification);
  scope.addEventListener('push', (event) => {
    event.waitUntil(showSomethingNew(scope.registration, replaces));
  });
  scope.addEventListener('notificationclick', (event) => {
    event.waitUntil(openApp(event.notification, scope.clients));
  });
}
