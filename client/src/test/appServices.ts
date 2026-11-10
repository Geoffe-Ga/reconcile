/**
 * One device's `AppServices` for tests: its own IndexedDB database on the
 * shared fake-indexeddb, a relay client on a shared fake relay, and a chat
 * bot (#119) that posts to that fake's Discord endpoint, never the network.
 */
import { vi } from 'vitest';

import { botNotice } from '../app/chatMessages';
import type { AppServices } from '../app/services';
import { xchachaSeal } from '../crypto/seal';
import { postWebhook } from '../net/discord';
import { createRelay } from '../net/relay';
import { createChatBot } from '../store/chatBot';
import { openStore } from '../store/db';
import { refreshRelayBackup } from '../store/relayBackup';
import { createSync } from '../store/sync';
import type { FakeRelay } from './fakeRelay';

/** The app's origin in tests. */
export const TEST_ORIGIN = 'https://reconcile.test';

/** A test device: its services, every text it copied, and every file it downloaded. */
export interface TestDevice {
  readonly services: AppServices;
  readonly copied: string[];
  readonly downloaded: File[];
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
  // As in main.tsx, the relay backup refreshes after each complete pass (#97).
  const afterPass = (): Promise<void> => refreshRelayBackup({ store, relay, now });
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: now, chatBot, afterPass });
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
  };
  return { services, copied, downloaded };
}
