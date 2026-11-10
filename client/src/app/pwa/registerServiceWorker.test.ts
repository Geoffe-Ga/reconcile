import { afterEach, describe, expect, it, vi } from 'vitest';

import { afterLoad, registerServiceWorker, type ServiceWorkerHost } from './registerServiceWorker';

/** A registration whose every way to hurry an update is a spy. */
function fakeRegistration() {
  return {
    update: vi.fn(),
    unregister: vi.fn(),
    addEventListener: vi.fn(),
    waiting: { postMessage: vi.fn() },
  };
}

function host(overrides: Partial<ServiceWorkerHost> = {}) {
  const registration = fakeRegistration();
  const register = vi.fn(() =>
    Promise.resolve(registration as unknown as ServiceWorkerRegistration),
  );
  const container = { register };
  const loaded = vi.fn((start: () => void) => {
    start();
  });
  return {
    registration,
    register,
    host: { production: true, container, afterLoad: loaded, ...overrides },
    loaded,
  };
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
    expect(registration.update).not.toHaveBeenCalled();
    expect(registration.addEventListener).not.toHaveBeenCalled();
    expect(registration.waiting.postMessage).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
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
    const { host: failing } = host({ container: { register } });
    registerServiceWorker(failing);
    await settle();
    expect(register).toHaveBeenCalledTimes(1);
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
