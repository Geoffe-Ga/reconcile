/**
 * Group home waits for the device's coalitions as it waits for the group
 * (#334): a home drawn before `listCoalitions` answers would show the
 * Coalitions section empty, "Reconcile with another group" alone, and then
 * the rows would jump in. So nothing of the group shows until both have
 * answered, and the section is whole the first time it appears.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TestDevice } from '../test/appServices';
import {
  CARD_VALUES,
  closeAll,
  formedCoalition,
  found,
  open,
  SLOW,
} from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { App } from './App';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount the app before its device's store closes.
  cleanup();
  closeAll();
  vi.restoreAllMocks();
});

/** Long enough for the app to read the group and draw its home, were it not waiting. */
const A_WHILE = 300;

/** As long as a home takes to read and fold everything once the store answers. */
const APP_FOLDS = { timeout: 3_000 };

/** The Coalitions section on screen now, or null. */
const section = () => screen.queryByRole('region', { name: 'Coalitions' });

/**
 * Holds `device`'s `listCoalitions` back until the returned `release` is
 * called, as a slow store would, then answers as the store does.
 */
function holdCoalitions(device: TestDevice): () => void {
  const { store } = device.services;
  const list = store.listCoalitions.bind(store);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(store, 'listCoalitions').mockImplementation(async () => {
    await held;
    return list();
  });
  return release;
}

/** Every text the Coalitions section had, each time the page changed, while `run` runs. */
async function sectionTexts(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const now = section();
    if (now !== null) seen.push(now.textContent);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    await run();
  } finally {
    observer.disconnect();
  }
  return seen;
}

/** `device`'s app, opened on the home of `groupId`. */
function homeOf(device: TestDevice, groupId: string): void {
  window.history.replaceState(null, '', `#/g/${groupId}`);
  render(<App services={device.services} />);
}

describe('Group home and the device’s coalitions (#334)', SLOW, () => {
  it('shows the Coalitions section only once the coalitions have answered, never without the coalition', async () => {
    const fake = createFakeRelay();
    const { ana, riverside } = await formedCoalition(fake);
    const release = holdCoalitions(ana);

    const texts = await sectionTexts(async () => {
      homeOf(ana, riverside);
      await new Promise((resolve) => setTimeout(resolve, A_WHILE));
      expect(section()).toBeNull();
      release();
      await waitFor(() => {
        expect(section()).toHaveTextContent(CARD_VALUES.name);
      }, APP_FOLDS);
    });

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toContain(CARD_VALUES.name);
  });

  it('still offers a group in no coalition the reconcile card, once its device has answered', async () => {
    const fake = createFakeRelay();
    const eve = await open(fake, 'eve');
    const elm = await found(eve, 'Elm Row', 'Eve');
    const release = holdCoalitions(eve);

    homeOf(eve, elm);
    await new Promise((resolve) => setTimeout(resolve, A_WHILE));
    expect(section()).toBeNull();
    release();
    const shown = await waitFor(() => {
      const now = section();
      if (now === null) throw new Error('Expected the Coalitions section.');
      return now;
    }, APP_FOLDS);
    expect(within(shown).getByRole('link', { name: /Reconcile with another group/ })).toBeVisible();
  });
});
