import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { NOTIFICATION_TAG as PAGE_TAG } from '../platform/pushPort';
import {
  NOTIFICATION_TAG,
  type NotifyRegistration,
  openApp,
  replacesByTag,
  showSomethingNew,
  SOMETHING_NEW,
  type WindowClients,
} from './notify';

/** One shown notification: whether it has been closed since. */
class FakeNotification {
  closed = false;

  constructor(readonly tag: string) {}

  close(): void {
    this.closed = true;
  }
}

/** A worker registration that keeps what it shows, counts what it closes, and has a badge spy. */
function fakeRegistration(open: readonly { tag: string }[] = []) {
  const held = open.map(({ tag }) => new FakeNotification(tag));
  const shown: { title: string; options: unknown }[] = [];
  const badges: unknown[] = [];
  const registration = {
    shown,
    badges,
    get closedCount() {
      return held.filter((n) => n.closed).length;
    },
    getNotifications: ({ tag }: { tag: string }) =>
      Promise.resolve(held.filter((n) => n.tag === tag && !n.closed)),
    showNotification: (title: string, options: { tag: string }) => {
      shown.push({ title, options });
      held.push(new FakeNotification(options.tag));
      return Promise.resolve();
    },
    setAppBadge: (count?: number) => {
      badges.push(count);
      return Promise.resolve();
    },
  } satisfies NotifyRegistration & Record<string, unknown>;
  return registration;
}

/** The windows a click can find, and what it did with them. */
function fakeClients(windows: number) {
  const focused: number[] = [];
  const opened: string[] = [];
  const matched: unknown[] = [];
  const clients: WindowClients & { focused: number[]; opened: string[]; matched: unknown[] } = {
    focused,
    opened,
    matched,
    matchAll: (options) => {
      matched.push(options);
      return Promise.resolve(
        Array.from({ length: windows }, (_, i) => ({
          focus: () => {
            focused.push(i);
            return Promise.resolve();
          },
        })),
      );
    },
    openWindow: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
  return clients;
}

/**
 * A registration as Chromium keeps one: a tag names one notification, so a
 * new one under it replaces the last, and closing any object under the tag
 * closes whichever one shows under it now, the new one included.
 */
function replacingRegistration() {
  const byTag = new Map<string, { title: string; serial: number }>();
  let serial = 0;
  let closes = 0;
  const registration = {
    get closes() {
      return closes;
    },
    showing: (tag: string) => byTag.get(tag),
    getNotifications: ({ tag }: { tag: string }) =>
      Promise.resolve(
        byTag.has(tag)
          ? [
              {
                close: () => {
                  closes += 1;
                  byTag.delete(tag);
                },
              },
            ]
          : [],
      ),
    showNotification: (title: string, options: { tag: string }) => {
      serial += 1;
      byTag.set(options.tag, { title, serial });
      return Promise.resolve();
    },
  } satisfies NotifyRegistration & Record<string, unknown>;
  return registration;
}

describe('replacesByTag: whether this browser replaces a notification under its tag', () => {
  it('is true where notifications have renotify, which only replacement gives meaning', () => {
    expect(replacesByTag({ prototype: { renotify: false } })).toBe(true);
  });

  it('is false where they have none, as in Safari and Firefox, or there is no Notification', () => {
    expect(replacesByTag({ prototype: {} })).toBe(false);
    expect(replacesByTag(undefined)).toBe(false);
  });
});

describe('showSomethingNew: what one push shows (#99, ADR-0012)', () => {
  it('where the browser replaces by tag, shows the new one without closing the last', async () => {
    const reg = replacingRegistration();

    await showSomethingNew(reg, true);
    await showSomethingNew(reg, true);

    // Closing first would close under the tag the new one shares (Chromium 153 can apply it late).
    expect(reg.closes).toBe(0);
    expect(reg.showing('reconcile')).toEqual({ title: SOMETHING_NEW, serial: 2 });
  });

  it('where it doesn’t, closes the open one first, then shows exactly one with only its tag', async () => {
    const reg = fakeRegistration([{ tag: 'reconcile' }]);

    await showSomethingNew(reg, false);

    expect(reg.closedCount).toBe(1);
    expect(reg.shown).toEqual([
      { title: messages.push.somethingNew, options: { tag: 'reconcile' } },
    ]);
    expect(messages.push.somethingNew).toBe('Something new in Reconcile');
    expect(NOTIFICATION_TAG).toBe('reconcile');
  });

  it('says what the messages module says, under the tag the page closes', () => {
    // The worker can't import either: it shares no chunk with the page.
    expect(SOMETHING_NEW).toBe(messages.push.somethingNew);
    expect(NOTIFICATION_TAG).toBe(PAGE_TAG);
    expect(messages.push.disclosure).toContain(`“${SOMETHING_NEW}.”`);
  });

  it('leaves another tag’s notification alone and never sets the app badge', async () => {
    const reg = fakeRegistration([{ tag: 'other' }, { tag: 'reconcile' }, { tag: 'reconcile' }]);

    await showSomethingNew(reg, false);
    await showSomethingNew(reg, false);
    await showSomethingNew(reg, true);

    expect(reg.closedCount).toBe(3);
    expect(reg.shown).toHaveLength(3);
    expect(reg.badges).toEqual([]);
  });
});

describe('openApp: what a tap on the notification does', () => {
  it('closes it and focuses an open window', async () => {
    const notification = new FakeNotification('reconcile');
    const clients = fakeClients(2);

    await openApp(notification, clients);

    expect(notification.closed).toBe(true);
    expect(clients.focused).toEqual([0]);
    expect(clients.opened).toEqual([]);
    expect(clients.matched).toEqual([{ type: 'window', includeUncontrolled: true }]);
  });

  it('opens the app at / when no window is open', async () => {
    const notification = new FakeNotification('reconcile');
    const clients = fakeClients(0);

    await openApp(notification, clients);

    expect(notification.closed).toBe(true);
    expect(clients.opened).toEqual(['/']);
  });
});
