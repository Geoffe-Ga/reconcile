/**
 * One device's `AppServices` for tests: its own IndexedDB database on the
 * shared fake-indexeddb, a relay client on a shared fake relay, a chat bot
 * (#119) that posts to that fake's Discord endpoint, never the network,
 * push (#99) over a fake browser whose permission starts unasked, and the
 * relay backup's daily refresh after each complete pass (#97).
 */
import { vi } from 'vitest';

import { botNotice } from '../app/chatMessages';
import type { AppServices } from '../app/services';
import { xchachaSeal } from '../crypto/seal';
import { postWebhook } from '../net/discord';
import { createPushRelay } from '../net/push';
import { createRelay } from '../net/relay';
import { browserPushPort } from '../platform/pushPort';
import { createChatBot } from '../store/chatBot';
import { openStore } from '../store/db';
import type { MailboxAt } from '../store/mailbox';
import { createPush } from '../store/push';
import { refreshRelayBackup } from '../store/relayBackup';
import { createSync } from '../store/sync';
import { fakePushBrowser, type FakePushBrowser } from './fakePush';
import type { FakeRelay } from './fakeRelay';

/** The app's origin in tests. */
export const TEST_ORIGIN = 'https://reconcile.test';

/** A test device: its services, every text it copied, every file it downloaded, and its browser's push. */
export interface TestDevice {
  readonly services: AppServices;
  readonly copied: string[];
  readonly downloaded: File[];
  readonly push: FakePushBrowser;
}

/** What a test may change about a device. */
export interface TestDeviceOptions {
  /** A group's mailbox at a relay minute, for push (#99): the store's own unless a test stubs it. */
  readonly mailboxAt?: MailboxAt;
}

/** The device clock tests start at, in milliseconds. */
export const TEST_NOW = 1_762_650_000_000;

/**
 * Opens device `name` on `fake`. The sync loop never polls; actions run it
 * once. `clock` is the device clock, fixed at {@link TEST_NOW} unless a test
 * moves it. Copy invite link hands `copyText` a promise of the link, as the
 * browser's clipboard takes one, and nothing is copied when it rejects. The
 * chat bot dates its notices in UTC, so a test can spell out what it posts.
 */
export async function testDevice(
  fake: FakeRelay,
  name: string,
  clock: () => number = () => TEST_NOW,
  options: TestDeviceOptions = {},
): Promise<TestDevice> {
  const store = await openStore(name);
  const relay = createRelay({ fetch: fake.fetch });
  const now = (): number => clock();
  const chatBot = createChatBot({
    store,
    post: (webhook, content) => postWebhook(webhook, content, fake.discord.fetch),
    notice: botNotice(TEST_ORIGIN, 'UTC'),
    clock: now,
  });
  const browser = fakePushBrowser();
  const push = createPush({
    store,
    relay: createPushRelay({ fetch: fake.fetch }),
    port: browserPushPort(browser.environment),
    clock: now,
    ...(options.mailboxAt === undefined ? {} : { mailboxAt: options.mailboxAt }),
  });
  // As in main.tsx, the relay backup refreshes after each complete pass (#97).
  const afterPass = (): Promise<void> => refreshRelayBackup({ store, relay, now });
  const sync = createSync({
    store,
    relay,
    seal: xchachaSeal,
    clock: now,
    chatBot,
    push,
    afterPass,
  });
  const copied: string[] = [];
  const copyText = vi.fn(async (text: string | Promise<string>) => {
    copied.push(await text);
  });
  const downloaded: File[] = [];
  // No Web Share, as in a desktop browser without it: Tell your group copies
  // instead, and a backup file downloads. Erase is a spy: `store/erase.test.ts`
  // erases for real.
  const services = {
    store,
    relay,
    sync,
    seal: xchachaSeal,
    now,
    origin: TEST_ORIGIN,
    copyText,
    share: undefined,
    files: {
      canShare: undefined,
      share: undefined,
      download: (file: File) => {
        downloaded.push(file);
      },
    },
    erase: vi.fn(() => Promise.resolve()),
    push,
  };
  return { services, copied, downloaded, push: browser };
}
