import { afterEach, describe, expect, it, vi } from 'vitest';

import { afterLoad, registerServiceWorker, type ServiceWorkerHost } from './registerServiceWorker';

type Listener = () => void;

/** A worker whose state the test moves on, firing `statechange` as the browser would. */
function fakeWorker(state: ServiceWorkerState) {
  const listeners: Listener[] = [];
  const worker = {
    state,
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === 'statechange') listeners.push(listener);
    }),
    moveTo(next: ServiceWorkerState) {
      worker.state = next;
      for (const listener of listeners) listener();
    },
  };
  return worker;
}

type FakeWorker = ReturnType<typeof fakeWorker>;

/**
 * A registration whose every way to hurry an update is a spy. `findUpdate`
 * plays the browser finding a changed `/sw.js`: the new worker installs, and
 * `updatefound` fires.
 */
function fakeRegistration(start: { active?: FakeWorker | null; waiting?: FakeWorker | null } = {}) {
  const listeners: Listener[] = [];
  const registration = {
    active: start.active === undefined ? fakeWorker('activated') : start.active,
    waiting: start.waiting ?? null,
    installing: null as FakeWorker | null,
    update: vi.fn(),
    unregister: vi.fn(),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === 'updatefound') listeners.push(listener);
    }),
    findUpdate<W extends FakeWorker | null>(worker: W): W {
      registration.installing = worker;
      for (const listener of listeners) listener();
      return worker;
    },
    /** The browser's own step: an installed worker waits while another is active. */
    install(worker: FakeWorker) {
      registration.installing = null;
      registration.waiting = worker;
      worker.moveTo('installed');
    },
  };
  return registration;
}

type FakeRegistration = ReturnType<typeof fakeRegistration>;

function host(overrides: Partial<ServiceWorkerHost> = {}, registration = fakeRegistration()) {
  const register = vi.fn(() =>
    Promise.resolve(registration as unknown as ServiceWorkerRegistration),
  );
  const container = { register };
  const loaded = vi.fn((start: () => void) => {
    start();
  });
  const onWaiting = vi.fn();
  return {
    registration,
    register,
    onWaiting,
    host: { production: true, container, afterLoad: loaded, onWaiting, ...overrides },
    loaded,
  };
}

/** Every way a page could hurry a waiting worker: none may have been called. */
function expectNothingHurried(registration: FakeRegistration, ...workers: FakeWorker[]) {
  expect(registration.update).not.toHaveBeenCalled();
  expect(registration.unregister).not.toHaveBeenCalled();
  for (const worker of workers) expect(worker.postMessage).not.toHaveBeenCalled();
}

/** Lets the register promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('registerServiceWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers /sw.js once in production, for the whole app, after the page loads', async () => {
    const { host: production, register, loaded } = host();
    registerServiceWorker(production);
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('never registers in development', async () => {
    const { host: dev, register, loaded } = host({ production: false });
    registerServiceWorker(dev);
    await settle();
    expect(loaded).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('never hurries an update: a new version waits for the next launch', async () => {
    const { host: production, registration } = host();
    registerServiceWorker(production);
    await settle();
    const worker = registration.findUpdate(fakeWorker('installing'));
    registration.install(worker);
    expectNothingHurried(registration, worker);
  });

  it('says a new version is waiting when one already was at launch', async () => {
    const waiting = fakeWorker('installed');
    const { host: production, registration, onWaiting } = host({}, fakeRegistration({ waiting }));
    registerServiceWorker(production);
    await settle();
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expectNothingHurried(registration, waiting);
  });

  it('says so once a new version found while open has installed, and not before', async () => {
    const { host: production, registration, onWaiting } = host();
    registerServiceWorker(production);
    await settle();
    expect(onWaiting).not.toHaveBeenCalled();
    const worker = registration.findUpdate(fakeWorker('installing'));
    expect(onWaiting).not.toHaveBeenCalled();
    registration.install(worker);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    worker.moveTo('redundant');
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when an update fails to install', async () => {
    const { host: production, registration, onWaiting } = host();
    registerServiceWorker(production);
    await settle();
    registration.findUpdate(fakeWorker('installing')).moveTo('redundant');
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('stays quiet for the first install, which takes over with nothing to wait for', async () => {
    const first = fakeRegistration({ active: null });
    const { host: production, registration, onWaiting } = host({}, first);
    registerServiceWorker(production);
    await settle();
    const worker = registration.findUpdate(fakeWorker('installing'));
    registration.install(worker);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('stays quiet when the installed worker has already moved on', async () => {
    const { host: production, registration, onWaiting } = host();
    registerServiceWorker(production);
    await settle();
    const worker = registration.findUpdate(fakeWorker('installing'));
    registration.installing = null;
    worker.moveTo('installed');
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('stays quiet when updatefound comes with no installing worker', async () => {
    const { host: production, registration, onWaiting } = host();
    registerServiceWorker(production);
    await settle();
    expect(() => registration.findUpdate(null)).not.toThrow();
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('does nothing where the browser has no service workers', () => {
    const { host: none, loaded } = host({ container: undefined });
    expect(() => {
      registerServiceWorker(none);
    }).not.toThrow();
    expect(loaded).not.toHaveBeenCalled();
  });

  it('carries on quietly when registration fails, as in a private window', async () => {
    const register = vi.fn(() => Promise.reject(new Error('blocked')));
    const { host: failing, onWaiting } = host({ container: { register } });
    registerServiceWorker(failing);
    await settle();
    expect(register).toHaveBeenCalledTimes(1);
    expect(onWaiting).not.toHaveBeenCalled();
  });
});

describe('afterLoad', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs at once when the page has already loaded', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    const start = vi.fn();
    afterLoad(start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for the load event otherwise, and runs once', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    const start = vi.fn();
    afterLoad(start);
    expect(start).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    window.dispatchEvent(new Event('load'));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
