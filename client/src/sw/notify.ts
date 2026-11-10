/**
 * What the service worker does with a push (#99; ADR-0012): show one fixed,
 * content-free notification, and open the app when it's tapped.
 *
 * The relay's pushes are empty (#89), and nothing here reads one: whatever a
 * push carries, the notification says only "Something new in Reconcile",
 * with no body, icon, image, badge, data or actions, so it never names a
 * group or shows text, ids or counts, on a lock screen or a watch. It never
 * sets the app badge, which would count.
 *
 * Every notification has the tag `reconcile`. Safari ignores a tag's
 * replacement, so the worker closes any it already shows before it shows a
 * new one: a phone shows one at most. The app closes them too whenever it
 * becomes visible (`platform/pushPort.ts`), since it has synced by then.
 *
 * These are pure functions over the parts of the worker's scope they use,
 * so tests hand in fakes; `net/serviceWorker.ts` calls them from its `push`
 * and `notificationclick` listeners.
 *
 * The worker is one script that shares no chunk with the page
 * (`plugins/serviceWorker.ts`), so this file imports nothing the app does:
 * not even `app/messages.ts`. Its text and tag are written here, and
 * `notify.test.ts` pins them to `messages.push.somethingNew` and to the tag
 * `platform/pushPort.ts` closes.
 */

/** The one tag every Reconcile notification carries. */
export const NOTIFICATION_TAG = 'reconcile';

/** What every notification says, and all it says: `messages.push.somethingNew`. */
export const SOMETHING_NEW = 'Something new in Reconcile';

/** A notification the worker shows, as far as it's closed. */
export interface ShownNotification {
  close(): void;
}

/** The parts of `ServiceWorkerRegistration` a push uses. */
export interface NotifyRegistration {
  getNotifications(filter: { tag: string }): Promise<readonly ShownNotification[]>;
  showNotification(title: string, options: { tag: string }): Promise<void>;
}

/** The parts of the worker's `clients` a tap uses. */
export interface WindowClients {
  matchAll(options: {
    type: 'window';
    includeUncontrolled: true;
  }): Promise<readonly { focus(): Promise<unknown> }[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Shows "Something new in Reconcile" for one push, with only its tag: first
 * closing every Reconcile notification already open, so exactly one shows.
 */
export async function showSomethingNew(registration: NotifyRegistration): Promise<void> {
  for (const open of await registration.getNotifications({ tag: NOTIFICATION_TAG })) {
    open.close();
  }
  await registration.showNotification(SOMETHING_NEW, { tag: NOTIFICATION_TAG });
}

/**
 * A tap on the notification: closes it, then focuses a Reconcile window, one
 * this worker doesn't control yet included, or opens the app at `/` when none
 * is open. The app syncs as it comes to the front.
 */
export async function openApp(notification: ShownNotification, clients: WindowClients) {
  notification.close();
  const [open] = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  await (open === undefined ? clients.openWindow('/') : open.focus());
}
