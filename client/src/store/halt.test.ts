/**
 * Halting the sync loop (#78): Erase halts it before it closes the store, so
 * no request starts once the halt resolves, and a pass already running stops
 * before its next group, with no chat bot run (#119) for the group it finishes
 * and no relay backup (#97) after it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newGroupSecret } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { createRelay, type Fetch } from '../net/relay';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { manualTimers } from '../test/timers';
import { openStore, type Store } from './db';
import { createSync } from './sync';

freshIndexedDBPerTest();

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A store holding two groups, each with its own secret and mailbox. */
async function twoGroups(): Promise<Store> {
  const store = await openStore('halt');
  stores.push(store);
  for (const groupId of ['group-1', 'group-2']) {
    await store.addGroup({
      groupId,
      secret: newGroupSecret(),
      signingKey: new Uint8Array(32),
      me: { author: 'author-ana', name: 'Ana' },
    });
  }
  return store;
}

/** A relay `fetch` that holds its first request until the test lets it go, counting every call. */
function heldFetch() {
  const fake = createFakeRelay();
  const urls: string[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: Fetch = async (input, init) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    if (urls.length === 1) await held;
    return fake.fetch(input, init);
  };
  return {
    fetch,
    urls,
    release: () => {
      release();
    },
  };
}

describe('halt', () => {
  it('lets a running pass finish its group, then starts no request, and resolves once it has', async () => {
    const store = await twoGroups();
    const { fetch, urls, release } = heldFetch();
    const manual = manualTimers();
    const sync = createSync({
      store,
      relay: createRelay({ fetch }),
      seal: xchachaSeal,
      timers: manual.timers,
    });
    const passing = sync.syncOnce();
    await expect.poll(() => urls.length).toBe(1);

    let halted = false;
    const halting = sync.halt().then(() => {
      halted = true;
    });
    await Promise.resolve();
    expect(halted).toBe(false);
    release();
    await halting;

    expect(urls).toHaveLength(1);
    expect(await passing).toBe(true);
    expect(await sync.syncOnce()).toBe(false);
    expect(urls).toHaveLength(1);
    expect(manual.waits()).toEqual([]);
  });

  it('runs no chat bot for the group a halted pass finishes, so Erase starts no post', async () => {
    const store = await twoGroups();
    const { fetch, urls, release } = heldFetch();
    const chatBot = { run: vi.fn(() => Promise.resolve()) };
    const sync = createSync({
      store,
      relay: createRelay({ fetch }),
      seal: xchachaSeal,
      timers: manualTimers().timers,
      chatBot,
    });
    const passing = sync.syncOnce();
    await expect.poll(() => urls.length).toBe(1);

    const halting = sync.halt();
    release();
    await halting;

    expect(await passing).toBe(true);
    expect(chatBot.run).not.toHaveBeenCalled();
  });

  it('runs nothing after a halted pass, so Erase starts no relay backup (#97)', async () => {
    const store = await twoGroups();
    const { fetch, urls, release } = heldFetch();
    const afterPass = vi.fn(() => Promise.resolve());
    const sync = createSync({
      store,
      relay: createRelay({ fetch }),
      seal: xchachaSeal,
      timers: manualTimers().timers,
      afterPass,
    });
    const passing = sync.syncOnce();
    await expect.poll(() => urls.length).toBe(1);

    const halting = sync.halt();
    release();
    await halting;

    expect(await passing).toBe(true);
    expect(afterPass).not.toHaveBeenCalled();
  });

  it('stops polling, so neither focus nor coming back online starts a pass', async () => {
    const store = await twoGroups();
    const { fetch, urls, release } = heldFetch();
    release();
    const manual = manualTimers();
    const sync = createSync({
      store,
      relay: createRelay({ fetch }),
      seal: xchachaSeal,
      timers: manual.timers,
    });
    sync.start();
    await expect.poll(() => urls.length).toBe(2);
    await expect.poll(() => manual.waits().length).toBe(1);

    await sync.halt();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    sync.start();
    await Promise.resolve();

    expect(manual.waits()).toEqual([]);
    expect(urls).toHaveLength(2);
  });
});
