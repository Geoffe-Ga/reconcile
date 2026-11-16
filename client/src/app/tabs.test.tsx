/**
 * The tab bar in the app (#423; ADR-0077 §6–§7): each tab opens its place,
 * Me opens Personal with Settings reached from it, the bar stays off a form,
 * and a reconcile card pasted into the link bar on Discover opens Bring a
 * card (#444).
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { cardLink } from '../coalition/card';
import { newCardSeed } from '../crypto/card';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { closeAll, open, SLOW } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { App } from './App';
import { messages } from './messages';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount the app before its device's store closes.
  cleanup();
  closeAll();
});

/** Opens `hash` in `device`'s app, as following a link would. */
function opening(device: TestDevice, hash: string): void {
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/** The tab bar. */
function bar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main' });
}

/** The page's own heading. */
function heading(name: string) {
  return screen.findByRole('heading', { level: 1, name });
}

describe('the tab bar', SLOW, () => {
  it('opens each place from its tab, and marks where the person is', async () => {
    const user = userEvent.setup();
    opening(await open(createFakeRelay(), 'ben'), '#/');
    expect(await heading('Your groups')).toBeVisible();
    expect(within(bar()).getByRole('link', { current: 'page' })).toHaveTextContent('Groups');

    await user.click(within(bar()).getByRole('link', { name: 'Discover' }));
    expect(await heading('Discover')).toBeVisible();
    expect(window.location.hash).toBe('#/discover');
    expect(within(bar()).getByRole('link', { current: 'page' })).toHaveTextContent('Discover');

    await user.click(within(bar()).getByRole('link', { name: 'Me' }));
    expect(await heading('Personal')).toBeVisible();
    expect(window.location.hash).toBe('#/me');
    expect(within(bar()).getByRole('link', { current: 'page' })).toHaveTextContent('Me');

    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await heading('Settings')).toBeVisible();
    expect(within(bar()).getByRole('link', { name: 'Me' })).toHaveAttribute('aria-current', 'true');

    await user.click(within(bar()).getByRole('link', { name: 'Groups' }));
    expect(await heading('Your groups')).toBeVisible();
    expect(window.location.hash).toBe('#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('stays off a screen whose one primary action is a form: Create group', async () => {
    opening(await open(createFakeRelay(), 'ben'), '#/create');

    expect(await heading('Create a group')).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });
});

describe('Discover and the link bar', SLOW, () => {
  it('opens Bring a card from a reconcile card pasted into the link bar on Discover, its seed held in memory', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const seed = newCardSeed();
    opening(await open(fake, 'ben'), '#/discover');
    expect(await heading('Discover')).toBeVisible();

    await user.click(screen.getByRole('searchbox', { name: 'Search or paste a link' }));
    await user.paste(cardLink('https://reconcile.test', seed));
    await user.keyboard('{Enter}');

    // Bring a card reads the card's mailbox, which holds nothing here, so it says the card has expired.
    expect(await screen.findByText(messages.bring.badLink)).toBeVisible();
    expect(window.location.hash).toBe('#/card');
    expect(fake.requests.map((request) => request.method)).toEqual(['GET']);
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });
});
