/**
 * The browser's notifications and Push API, behind one small port (#99), so
 * the rest of the app, and its tests, never touch `Notification` or
 * `pushManager` directly.
 *
 * - `requestPermission` calls the browser's at once, never after an `await`,
 *   so it runs inside the tap that asked: Safari allows the prompt nowhere
 *   else.
 * - `subscribe` always asks for `userVisibleOnly: true` (every push shows a
 *   notification, which Safari and Chrome require) with the relay's key,
 *   which the caller reads from `GET /v1/push/key`, never a build constant.
 * - On iOS and iPadOS the Push API exists only in the installed app, which
 *   the install gate already requires (ADR-0029, `installGate.ts`). A browser
 *   without it, or without a service worker, isn't `supported`.
 *
 * Talking to a push service is the browser's own business: nothing here
 * calls `fetch`.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import type { ShownNotification } from '../sw/notify';

/**
 * The tag the service worker gives every Reconcile notification
 * (`sw/notify.ts`). The worker shares no module with the page, so it is
 * written in both, and `sw/notify.test.ts` keeps them equal.
 */
export const NOTIFICATION_TAG = 'reconcile';

/** What the person has said about notifications: yes, no, or not yet. */
export type PushPermission = 'granted' | 'denied' | 'default';

/** A push subscription as the browser gives one, as far as the app reads it. */
export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  unsubscribe(): Promise<boolean>;
}

/** The parts of a `ServiceWorkerRegistration` push uses. */
export interface PushRegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  };
  getNotifications(filter: { tag: string }): Promise<readonly ShownNotification[]>;
}

/** What the port reads from the browser; tests hand in a fake one (`src/test/fakePush.ts`). */
export interface PushEnvironment {
  /** `Notification`, where the browser has it. */
  readonly notification:
    | {
        readonly permission: PushPermission;
        requestPermission(): Promise<PushPermission>;
      }
    | undefined;
  /** `navigator.serviceWorker`, where the browser has it and the Push API. */
  readonly container:
    | {
        getRegistration(): Promise<PushRegistrationLike | undefined>;
        readonly ready: Promise<PushRegistrationLike>;
      }
    | undefined;
}

/** This device's push subscription: its endpoint, and the relay key it was made with. */
export interface DeviceSubscription {
  /** The push service's URL for this device, which the relay posts its empty pushes to. */
  readonly endpoint: string;
  /** The VAPID key it was made with, as 87 base64url characters, or null when the browser won't say. */
  readonly key: string | null;
  /** Ends it: the push service then refuses the relay's pushes, and the relay forgets it. */
  unsubscribe(): Promise<boolean>;
}

/** The browser's notifications and Push API. */
export interface PushPort {
  /** Whether this browser can get push at all: notifications, a service worker and the Push API. */
  readonly supported: boolean;
  /** What the person has said so far. */
  permission(): PushPermission;
  /** Asks the person, at once; call it straight from the tap. */
  requestPermission(): Promise<PushPermission>;
  /** This device's subscription, or null when it has none (or no service worker yet). */
  subscription(): Promise<DeviceSubscription | null>;
  /**
   * Subscribes with `userVisibleOnly: true` and the relay's `key`.
   *
   * @throws {Error} when no service worker is registered, or the browser or its push service refuses.
   */
  subscribe(key: string): Promise<DeviceSubscription>;
  /** Closes every Reconcile notification this device shows. */
  closeNotifications(): Promise<void>;
}

/** The browser's own notifications and service worker, where it has the Push API. */
export function browserEnvironment(): PushEnvironment {
  const push = 'PushManager' in window && 'serviceWorker' in navigator;
  return {
    notification: 'Notification' in window ? window.Notification : undefined,
    container: push ? navigator.serviceWorker : undefined,
  };
}

function asDevice(subscription: PushSubscriptionLike): DeviceSubscription {
  const key = subscription.options.applicationServerKey;
  return {
    endpoint: subscription.endpoint,
    key: key === null ? null : base64url(new Uint8Array(key)),
    unsubscribe: () => subscription.unsubscribe(),
  };
}

/** The port over `environment`: the browser's own unless a test hands in another. */
export function browserPushPort(environment: PushEnvironment = browserEnvironment()): PushPort {
  const { notification, container } = environment;
  const registration = async () => container?.getRegistration();
  return {
    supported: notification !== undefined && container !== undefined,
    permission: () => notification?.permission ?? 'default',
    requestPermission: () =>
      notification === undefined ? Promise.resolve('denied') : notification.requestPermission(),
    async subscription() {
      const held = await (await registration())?.pushManager.getSubscription();
      return held === undefined || held === null ? null : asDevice(held);
    },
    async subscribe(key) {
      // `ready` never settles without a registration, so check for one first.
      if (container === undefined || (await container.getRegistration()) === undefined) {
        throw new Error('This device has no service worker to receive push.');
      }
      const ready = await container.ready;
      const applicationServerKey = fromBase64url(key);
      return asDevice(
        await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
      );
    },
    async closeNotifications() {
      const shown =
        (await (await registration())?.getNotifications({ tag: NOTIFICATION_TAG })) ?? [];
      for (const open of shown) open.close();
    },
  };
}

/** What {@link closeWhenVisible} watches: the page's visibility. */
export type VisibleDocument = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Closes Reconcile's notifications now if the page is visible, and each time
 * it becomes visible, since the app syncs as it comes to the front (#99).
 * Returns the way to stop.
 */
export function closeWhenVisible(
  port: Pick<PushPort, 'closeNotifications'>,
  page: VisibleDocument,
) {
  const close = (): void => {
    if (page.visibilityState === 'visible') port.closeNotifications().catch(() => undefined);
  };
  close();
  page.addEventListener('visibilitychange', close);
  return () => {
    page.removeEventListener('visibilitychange', close);
  };
}
