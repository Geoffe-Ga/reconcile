/**
 * The service worker's entry, which the build writes to `/sw.js`
 * (`client/plugins/serviceWorker.ts`). It has its own tsconfig
 * (`tsconfig.sw.json`), whose library is the worker's, not the page's.
 *
 * The build replaces `__RECONCILE_PRECACHE__` with this build's precache
 * list, so `/sw.js` changes, and the browser installs a new version, whenever
 * any file of the app does.
 */
import { type Precache, startServiceWorker } from './serviceWorker';

declare const self: ServiceWorkerGlobalScope;
declare const __RECONCILE_PRECACHE__: Precache;

startServiceWorker(self, __RECONCILE_PRECACHE__);
