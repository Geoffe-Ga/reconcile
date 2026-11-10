import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  answerFor,
  type Precache,
  type RequestEvent,
  startServiceWorker,
  type WaitUntilEvent,
} from './serviceWorker';

const ORIGIN = 'https://reconcile.test';
const PRECACHE: Precache = {
  version: 'abc123',
  urls: ['/', '/assets/index-1a2b.js', '/assets/public-sans-latin.woff2', '/manifest.webmanifest'],
};
const CURRENT = 'reconcile-app-abc123';

/** One cache: what it holds, and every request `addAll` was handed. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  readonly added: Request[] = [];
  readonly put = vi.fn();

  constructor(private readonly serve: (request: Request) => Response) {}

  addAll(requests: Request[]): Promise<void> {
    const responses = requests.map((request) => this.serve(request));
    if (responses.some((response) => !response.ok)) {
      return Promise.reject(new TypeError('A request failed.'));
    }
    requests.forEach((request, index) => {
      this.added.push(request);
      this.entries.set(request.url, responses[index] ?? Response.error());
    });
    return Promise.resolve();
  }

  match(key: string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(key)?.clone());
  }
}

/** CacheStorage over named FakeCaches. */
class FakeCaches {
  readonly byName = new Map<string, FakeCache>();

  constructor(private readonly serve: (request: Request) => Response = ok) {}

  open(name: string): Promise<FakeCache> {
    const cache = this.byName.get(name) ?? new FakeCache(this.serve);
    this.byName.set(name, cache);
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.byName.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.byName.delete(name));
  }
}

function ok(request: Request): Response {
  return new Response(`cached ${new URL(request.url).pathname}`);
}

type Listener = (event: never) => void;

/** A worker scope that records its listeners, with spies on the calls that hurry an update. */
function fakeScope(caches = new FakeCaches()) {
  const listeners = new Map<string, Listener>();
  const network = vi.fn((request: Request) =>
    Promise.resolve(new Response(`network ${request.url}`)),
  );
  const scope = {
    caches: caches as unknown as CacheStorage,
    location: { origin: ORIGIN },
    fetch: network,
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  startServiceWorker(scope, PRECACHE);
  return { scope, caches, listeners, network };
}

/** Fires a lifecycle event and returns the promise it was told to wait for. */
function lifecycle(listeners: Map<string, Listener>, type: 'install' | 'activate') {
  let waited: Promise<unknown> = Promise.resolve();
  const event: WaitUntilEvent = {
    waitUntil: (promise) => {
      waited = promise;
    },
  };
  listeners.get(type)?.(event as never);
  return waited;
}

interface Answered {
  readonly answered: boolean;
  readonly response: Promise<Response> | null;
}

/** Fires a fetch event; `answered` says whether the worker called `respondWith`. */
function request(
  listeners: Map<string, Listener>,
  url: string,
  init: { method?: string; mode?: RequestMode } = {},
): Answered {
  const answered: { response: Promise<Response> | null } = { response: null };
  const event: RequestEvent = {
    request: {
      url: new URL(url, ORIGIN).href,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'cors',
    } as Request,
    waitUntil: () => undefined,
    respondWith: (answer) => {
      answered.response = answer;
    },
  };
  listeners.get('fetch')?.(event as never);
  return { answered: answered.response !== null, response: answered.response };
}

async function text(answer: Answered): Promise<string> {
  if (answer.response === null) throw new Error('The worker didn’t answer.');
  return (await answer.response).text();
}

describe('install', () => {
  it('keeps every file of this version, revalidated with the server', async () => {
    const { caches, listeners, scope } = fakeScope();
    await lifecycle(listeners, 'install');
    const cache = caches.byName.get(CURRENT);
    expect(cache?.added.map((added) => added.url)).toEqual(
      PRECACHE.urls.map((url) => `${ORIGIN}${url}`),
    );
    expect(cache?.added.every((added) => added.cache === 'no-cache')).toBe(true);
    // A new version waits for the next launch.
    expect(scope.skipWaiting).not.toHaveBeenCalled();
  });

  it('fails as a whole when any file can’t be fetched, so the browser tries again later', async () => {
    const caches = new FakeCaches((req) =>
      req.url.endsWith('.woff2') ? new Response('', { status: 404 }) : ok(req),
    );
    const { listeners } = fakeScope(caches);
    await expect(lifecycle(listeners, 'install')).rejects.toThrow(TypeError);
  });
});

describe('activate', () => {
  it('deletes the caches older versions left, and nothing else', async () => {
    const caches = new FakeCaches();
    await caches.open('reconcile-app-old');
    await caches.open('someone-else');
    const { listeners, scope } = fakeScope(caches);
    await lifecycle(listeners, 'install');
    await lifecycle(listeners, 'activate');
    expect(await caches.keys()).toEqual(['someone-else', CURRENT]);
    // Open windows keep the version they started with.
    expect(scope.clients.claim).not.toHaveBeenCalled();
  });
});

describe('fetch', () => {
  async function installed() {
    const worker = fakeScope();
    await lifecycle(worker.listeners, 'install');
    return worker;
  }

  it('answers every page load with the app shell, whatever the path', async () => {
    const { listeners } = await installed();
    for (const path of ['/', '/index.html', '/anything/else?x=1']) {
      expect(await text(request(listeners, path, { mode: 'navigate' }))).toBe('cached /');
    }
  });

  it('answers a kept file from the cache', async () => {
    const { listeners, network } = await installed();
    expect(await text(request(listeners, '/assets/index-1a2b.js'))).toBe(
      'cached /assets/index-1a2b.js',
    );
    expect(await text(request(listeners, '/assets/public-sans-latin.woff2'))).toBe(
      'cached /assets/public-sans-latin.woff2',
    );
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ['a relay read', '/v1/m/abc', {}],
    ['a relay write', '/v1/m/abc', { method: 'PUT' }],
    ['a page load of the relay', '/v1/health', { mode: 'navigate' as const }],
    ['the relay root', '/v1', { mode: 'navigate' as const }],
    ['a file it doesn’t keep', '/robots.txt', {}],
    ['a kept file with a query', '/assets/index-1a2b.js?v=2', {}],
    ['another site', 'https://elsewhere.example/assets/index-1a2b.js', {}],
    ['a POST', '/', { method: 'POST', mode: 'navigate' as const }],
  ])('leaves %s to the network', async (_name, url, init) => {
    const { listeners } = await installed();
    expect(request(listeners, url, init).answered).toBe(false);
  });

  it('falls back to the network when a kept file is missing from the cache', async () => {
    const { listeners, network } = fakeScope();
    expect(await text(request(listeners, '/', { mode: 'navigate' }))).toBe(`network ${ORIGIN}/`);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('never stores a response itself', async () => {
    const { listeners, caches } = await installed();
    await text(request(listeners, '/', { mode: 'navigate' }));
    request(listeners, '/v1/m/abc');
    expect(caches.byName.get(CURRENT)?.put).not.toHaveBeenCalled();
  });
});

describe('answerFor', () => {
  const urls = new Set(PRECACHE.urls);

  it('never answers anything under /v1 from the cache, for any method or mode', () => {
    const modes: RequestMode[] = ['navigate', 'cors', 'no-cors', 'same-origin'];
    // Paths under /v1 from path-safe characters, with an optional query. No
    // `.`, so no `..` segment can resolve out of /v1 before the worker sees it.
    const unit = fc.constantFrom(...'aZ09-_~!$&()*+,;=:@%'.split(''));
    const segment = fc.string({ unit, maxLength: 8 });
    const relayUrl = fc
      .tuple(fc.array(segment, { maxLength: 4 }), fc.option(segment))
      .map(([segments, query]) => {
        const path = ['/v1', ...segments].join('/');
        return `${ORIGIN}${path}${query === null ? '' : `?${query}`}`;
      });
    fc.assert(
      fc.property(
        relayUrl,
        fc.constantFrom('GET', 'PUT', 'POST', 'HEAD'),
        fc.constantFrom(...modes),
        (url, method, mode) => answerFor({ url, method, mode }, ORIGIN, urls) === 'network',
      ),
    );
  });

  it('names how each kind of request is answered', () => {
    expect(answerFor({ url: `${ORIGIN}/g`, method: 'GET', mode: 'navigate' }, ORIGIN, urls)).toBe(
      'app-shell',
    );
    expect(
      answerFor(
        { url: `${ORIGIN}/manifest.webmanifest`, method: 'GET', mode: 'cors' },
        ORIGIN,
        urls,
      ),
    ).toBe('precached');
    expect(answerFor({ url: `${ORIGIN}/v1x`, method: 'GET', mode: 'cors' }, ORIGIN, urls)).toBe(
      'network',
    );
  });
});
