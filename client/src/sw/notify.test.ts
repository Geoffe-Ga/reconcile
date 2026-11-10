import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { NOTIFICATION_TAG as PAGE_TAG } from '../platform/pushPort';
import {
  NOTIFICATION_TAG,
  type NotifyRegistration,
  openApp,
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

describe('showSomethingNew: what one push shows (#99, ADR-0012)', () => {
  it('closes the open one first, then shows exactly one notification with only its tag', async () => {
    const reg = fakeRegistration([{ tag: 'reconcile' }]);

    await showSomethingNew(reg);

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

    await showSomethingNew(reg);
    await showSomethingNew(reg);

    expect(reg.closedCount).toBe(3);
    expect(reg.shown).toHaveLength(2);
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
