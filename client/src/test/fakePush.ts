/**
 * A browser's notifications and Push API for tests (#99): `Notification` with
 * a permission a test sets and the answer its prompt gives, and a service
 * worker registration whose `pushManager` hands out subscriptions on a push
 * service's host. Nothing here reaches a push service.
 *
 * `browserPushPort(fake.environment)` is the app's own port over it, so a
 * test sees exactly what the app asks the browser for: `subscribed` keeps
 * every `subscribe` call's options.
 */
import { base64url } from '../crypto/base64url';
import type { PushEnvironment, PushSubscriptionLike } from '../platform/pushPort';

/** One subscription the fake push manager made. */
export interface FakeSubscription extends PushSubscriptionLike {
  /** True once `unsubscribe` was called. */
  readonly unsubscribed: boolean;
}

/** A test's handle on the fake browser. */
export interface FakePushBrowser {
  /** What `browserPushPort` reads. */
  readonly environment: PushEnvironment;
  /** `Notification.permission`. */
  permission: NotificationPermission;
  /** What the permission prompt answers; it becomes `permission`. */
  answer: NotificationPermission;
  /** How many times the page asked for permission. */
  readonly asked: number;
  /** The options of every `pushManager.subscribe` call, the key as base64url. */
  readonly subscribed: { readonly userVisibleOnly: boolean; readonly key: string }[];
  /** The live subscription, or null. */
  readonly subscription: FakeSubscription | null;
  /** Every subscription made, oldest first. */
  readonly made: readonly FakeSubscription[];
  /** How many Reconcile notifications the page closed. */
  readonly closed: number;
  /** Notifications the worker shows now, by tag, for `closeNotifications`. */
  readonly showing: string[];
  /** While true, `subscribe` rejects as a push service failure would. */
  failSubscribe: boolean;
  /** The endpoint of the `n`th subscription made: {@link fakeEndpoint} unless a test changes it. */
  endpointOf: (n: number) => string;
  /** Ends the subscription from the browser's side, as a push service may, and makes a new one. */
  rotate(): void;
}

/** Endpoints the fake makes: on FCM's host, which the relay accepts, numbered so each is new. */
export const fakeEndpoint = (n: number): string =>
  `https://fcm.googleapis.com/fcm/send/fake-${String(n)}`;

/** A fake browser with notifications at `permission` and a registered service worker. */
export function fakePushBrowser(permission: NotificationPermission = 'default'): FakePushBrowser {
  const made: (FakeSubscription & { unsubscribed: boolean })[] = [];
  let current: (FakeSubscription & { unsubscribed: boolean }) | null = null;

  const pushManager = {
    getSubscription: () => Promise.resolve(current),
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) {
      const key = base64url(options.applicationServerKey);
      fake.subscribed.push({ userVisibleOnly: options.userVisibleOnly, key });
      if (fake.failSubscribe) return Promise.reject(new DOMException('push service', 'AbortError'));
      if (current !== null && current.options.applicationServerKey !== null) {
        const held = base64url(new Uint8Array(current.options.applicationServerKey));
        if (held !== key) return Promise.reject(new DOMException('key', 'InvalidStateError'));
        return Promise.resolve(current);
      }
      const subscription = {
        endpoint: fake.endpointOf(made.length + 1),
        options: { applicationServerKey: options.applicationServerKey.slice().buffer },
        unsubscribed: false,
        unsubscribe() {
          subscription.unsubscribed = true;
          if (current === subscription) current = null;
          return Promise.resolve(true);
        },
      };
      made.push(subscription);
      current = subscription;
      return Promise.resolve(subscription);
    },
  };
  const registration = {
    pushManager,
    getNotifications: ({ tag }: { tag: string }) =>
      Promise.resolve(
        fake.showing
          .filter((shown) => shown === tag)
          .map(() => ({
            close: () => {
              fake.closed += 1;
              fake.showing.splice(fake.showing.indexOf(tag), 1);
            },
          })),
      ),
  };
  const fake: FakePushBrowser & { asked: number; closed: number } = {
    permission,
    answer: 'granted',
    asked: 0,
    subscribed: [],
    get subscription() {
      return current;
    },
    made,
    closed: 0,
    showing: [],
    failSubscribe: false,
    endpointOf: fakeEndpoint,
    rotate() {
      const held = current;
      if (held === null || held.options.applicationServerKey === null) return;
      current = null;
      void pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(held.options.applicationServerKey),
      });
      fake.subscribed.pop();
    },
    environment: {
      notification: {
        get permission(): NotificationPermission {
          return fake.permission;
        },
        requestPermission(): Promise<NotificationPermission> {
          fake.asked += 1;
          fake.permission = fake.answer;
          return Promise.resolve(fake.answer);
        },
      },
      container: {
        getRegistration: () => Promise.resolve(registration),
        ready: Promise.resolve(registration),
      },
    },
  };
  return fake;
}
