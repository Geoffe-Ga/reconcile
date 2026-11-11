/**
 * One device's `AppServices` for tests: its own IndexedDB database on the
 * shared fake-indexeddb, a relay client on a shared fake relay, a chat bot
 * (#119, #123) that posts to that fake's Discord webhook, never the network,
 * push (#99) over a fake browser whose permission starts unasked, the front
 * door's keeper (#121), and the relay backup's daily refresh after each
 * complete pass (#97).
 */
import { vi } from 'vitest';

import { botNotice, botThreadName } from '../app/chatMessages';
import { passkeyOn } from '../app/passkey';
import type { AppServices } from '../app/services';
import { plainText } from '../app/text/markdown';
import { xchachaSeal } from '../crypto/seal';
import { getWebhook, postWebhook } from '../net/discord';
import { createPushRelay } from '../net/push';
import { createDoorKeeper } from '../door/keeper';
import { createRelay } from '../net/relay';
import { browserPushPort } from '../platform/pushPort';
import { type ChatBot, createChatBot } from '../store/chatBot';
import { openStore } from '../store/db';
import type { MailboxAt } from '../store/mailbox';
import { createPush } from '../store/push';
import { refreshRelayBackup } from '../store/relayBackup';
import { createSync } from '../store/sync';
import { fakePushBrowser, type FakePushBrowser } from './fakePush';
import { webAuthn } from '../platform/webauthn';
import type { FakeAuthenticator } from './fakeAuthenticator';
import type { FakeRelay } from './fakeRelay';

/** The app's origin in tests. */
export const TEST_ORIGIN = 'https://reconcile.test';

/**
 * A test device: its services, every text it copied, every file it
 * downloaded, its browser's push, and its chat bot, whose posts a test can
 * wait for (#123).
 */
export interface TestDevice {
  readonly services: AppServices;
  readonly copied: string[];
  readonly downloaded: File[];
  readonly push: FakePushBrowser;
  readonly chatBot: ChatBot;
}

/** What a test may change about a device. */
export interface TestDeviceOptions {
  /** A group's mailbox at a relay minute, for push (#99): the store's own unless a test stubs it. */
  readonly mailboxAt?: MailboxAt;
}

/** A desktop browser's user agent, which `prfTrusted` trusts. */
const DESKTOP = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  maxTouchPoints: 0,
};

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
  const discord = fake.discord.fetch;
  const chatBot = createChatBot({
    store,
    post: (webhook, content, place) => postWebhook(webhook, content, { ...place, fetch: discord }),
    getWebhook: (webhook) => getWebhook(webhook, { fetch: discord }),
    notice: botNotice(TEST_ORIGIN, 'UTC'),
    threadName: botThreadName,
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
  // As in main.tsx, each sync keeps the front door, and looks for replies (#121).
  const door = createDoorKeeper({ store, relay, seal: xchachaSeal, plainText, clock: now });
  const sync = createSync({
    store,
    relay,
    seal: xchachaSeal,
    clock: now,
    chatBot,
    push,
    door,
    afterPass,
  });
  const copied: string[] = [];
  const copyText = vi.fn(async (text: string | Promise<string>) => {
    copied.push(await text);
  });
  const downloaded: File[] = [];
  // No Web Share, as in a desktop browser without it: Tell your group copies
  // instead, and a backup file downloads. Erase is a spy: `store/erase.test.ts`
  // erases for real. Without a fake authenticator the browser has no WebAuthn,
  // so no passkey is offered: `withPasskey` gives a device one (#95).
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
    passkey: passkeyOn({ store, webauthn: undefined, platform: DESKTOP, rpId: 'reconcile.test' }),
  };
  return { services, copied, downloaded, push: browser, chatBot };
}

/** `device` with a browser whose WebAuthn is `authenticator`, so a passkey is offered (#95). */
export function withPasskey(device: TestDevice, authenticator: FakeAuthenticator): TestDevice {
  const { store } = device.services;
  const webauthn = webAuthn(authenticator.calls);
  const passkey = passkeyOn({ store, webauthn, platform: DESKTOP, rpId: 'reconcile.test' });
  return { ...device, services: { ...device.services, passkey } };
}
