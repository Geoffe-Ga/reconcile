import { describe, expect, it, vi } from 'vitest';

import { fakeEndpoint, fakePushBrowser } from '../test/fakePush';
import { TEST_PUSH_KEY } from '../test/fakeRelay';
import { browserEnvironment, browserPushPort, closeWhenVisible } from './pushPort';

describe('browserPushPort (#99)', () => {
  it('asks the browser for permission at once, before anything is awaited', () => {
    const browser = fakePushBrowser();
    const port = browserPushPort(browser.environment);

    void port.requestPermission();

    expect(browser.asked).toBe(1);
  });

  it('reports the permission the browser holds', async () => {
    const browser = fakePushBrowser('denied');
    const port = browserPushPort(browser.environment);
    expect(port.permission()).toBe('denied');
    browser.answer = 'granted';

    expect(await port.requestPermission()).toBe('granted');
    expect(port.permission()).toBe('granted');
  });

  it('subscribes with userVisibleOnly and exactly the key it is given', async () => {
    const browser = fakePushBrowser('granted');
    const port = browserPushPort(browser.environment);

    const subscription = await port.subscribe(TEST_PUSH_KEY);

    expect(browser.subscribed).toEqual([{ userVisibleOnly: true, key: TEST_PUSH_KEY }]);
    expect(subscription.endpoint).toBe(fakeEndpoint(1));
    expect(subscription.key).toBe(TEST_PUSH_KEY);
    expect((await port.subscription())?.endpoint).toBe(fakeEndpoint(1));
  });

  it('reads no subscription before one, and ends one when asked', async () => {
    const browser = fakePushBrowser('granted');
    const port = browserPushPort(browser.environment);
    expect(await port.subscription()).toBeNull();
    const subscription = await port.subscribe(TEST_PUSH_KEY);

    expect(await subscription.unsubscribe()).toBe(true);

    expect(browser.made[0]?.unsubscribed).toBe(true);
    expect(await port.subscription()).toBeNull();
  });

  it('reads a key the browser won’t give as null', async () => {
    const environment = {
      notification: undefined,
      container: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: {
              getSubscription: () =>
                Promise.resolve({
                  endpoint: fakeEndpoint(9),
                  options: { applicationServerKey: null },
                  unsubscribe: () => Promise.resolve(true),
                }),
              subscribe: () => Promise.reject(new Error('unused')),
            },
            getNotifications: () => Promise.resolve([]),
          }),
        ready: new Promise<never>(() => undefined),
      },
    };

    expect(await browserPushPort(environment).subscription()).toMatchObject({ key: null });
  });

  it('refuses to subscribe with no service worker, rather than wait on one forever', async () => {
    const browser = fakePushBrowser('granted');
    const environment = {
      ...browser.environment,
      container: {
        getRegistration: () => Promise.resolve(undefined),
        ready: new Promise<never>(() => undefined),
      },
    };
    const port = browserPushPort(environment);

    await expect(port.subscribe(TEST_PUSH_KEY)).rejects.toThrow(/no service worker/);
    expect(await port.subscription()).toBeNull();
    await port.closeNotifications();
  });

  it('closes only Reconcile’s notifications', async () => {
    const browser = fakePushBrowser('granted');
    browser.showing.push('reconcile', 'other', 'reconcile');

    await browserPushPort(browser.environment).closeNotifications();

    expect(browser.closed).toBe(2);
    expect(browser.showing).toEqual(['other']);
  });

  it('isn’t supported without notifications or the Push API, and then never prompts', async () => {
    const browser = fakePushBrowser('default');
    const noPush = browserPushPort({ ...browser.environment, container: undefined });
    const noNotifications = browserPushPort({ ...browser.environment, notification: undefined });

    expect(browserPushPort(browser.environment).supported).toBe(true);
    expect(noPush.supported).toBe(false);
    expect(noNotifications.supported).toBe(false);
    expect(noNotifications.permission()).toBe('default');
    expect(await noNotifications.requestPermission()).toBe('denied');
    await expect(noPush.subscribe(TEST_PUSH_KEY)).rejects.toThrow();
    expect(browser.asked).toBe(0);
  });

  it('reads the real browser by default, which in jsdom has no Push API', () => {
    expect(browserEnvironment().container).toBeUndefined();
    expect(browserPushPort().supported).toBe(false);
  });
});

describe('closeWhenVisible', () => {
  /** A page whose visibility a test sets. */
  function page(state: DocumentVisibilityState) {
    const target = new EventTarget();
    const doc = Object.assign(target, { visibilityState: state });
    const become = (next: DocumentVisibilityState) => {
      doc.visibilityState = next;
      target.dispatchEvent(new Event('visibilitychange'));
    };
    return { doc, become };
  }

  it('closes them now when the page is visible, and each time it comes back', () => {
    const port = { closeNotifications: vi.fn(() => Promise.resolve()) };
    const { doc, become } = page('visible');

    const stop = closeWhenVisible(port, doc);
    become('hidden');
    become('visible');
    stop();
    become('hidden');
    become('visible');

    expect(port.closeNotifications).toHaveBeenCalledTimes(2);
  });

  it('waits while the page is hidden, and shrugs off a failure', async () => {
    const port = { closeNotifications: vi.fn(() => Promise.reject(new Error('no worker'))) };
    const { doc, become } = page('hidden');

    closeWhenVisible(port, doc);
    expect(port.closeNotifications).not.toHaveBeenCalled();
    become('visible');
    await Promise.resolve();

    expect(port.closeNotifications).toHaveBeenCalledTimes(1);
  });
});
