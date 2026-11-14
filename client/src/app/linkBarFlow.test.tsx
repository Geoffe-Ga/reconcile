/**
 * The link bar in the app (#444; ADR-0077 §6): it stands on every screen
 * past first run, forms and ballots included; a link pasted into it opens
 * through that link's own page, its seed held in memory as Start's field
 * held it; the page under its panel is inert; and once a link opens,
 * nothing on the device keeps what was pasted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { cardLink } from '../coalition/card';
import { newCardSeed } from '../crypto/card';
import { newInviteSeed } from '../crypto/invite';
import { newRecoveryKeys, recoveryCode } from '../crypto/recovery';
import { doorLinkOf } from '../door/page';
import { shareLinkOf } from '../share/shareLink';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { closeAll, open, SLOW } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { containsBytes, scanDb } from '../test/scanDb';
import { App } from './App';
import { inviteLink } from './invite';
import { messages } from './messages';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount the app before its device's store closes.
  cleanup();
  closeAll();
});

const ORIGIN = 'https://reconcile.test';

/** Opens `hash` in `device`'s app, as following a link would. */
function opening(device: TestDevice, hash: string): void {
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/** The page's own heading. */
function heading(name: string) {
  return screen.findByRole('heading', { level: 1, name });
}

/** The bar's field. */
function bar(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('searchbox', { name: messages.linkBar.label });
}

/** The region the page scrolls in, under the bar. */
function page(): HTMLElement {
  const region = screen.getByRole('main').parentElement;
  if (region === null) throw new Error('Expected the page to stand in a region.');
  return region;
}

describe('the link bar in the app', SLOW, () => {
  it.each([
    ['Start', '#/', 'Your groups'],
    ['Discover', '#/discover', 'Discover'],
    ['Create group, a form', '#/create', 'Create a group'],
    ['Settings', '#/settings', 'Settings'],
  ])('stands over %s', async (_name, hash, title) => {
    opening(await open(createFakeRelay(), 'ben'), hash);

    expect(await heading(title)).toBeVisible();
    expect(screen.getByRole('search')).toContainElement(bar());
    expect(page()).not.toContainElement(bar());
  });

  it('opens an invite pasted on Discover through Join, its seed held in memory, and keeps nothing of it', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const seed = newInviteSeed();
    const link = inviteLink(ORIGIN, seed);
    const payload = new URL(link).hash.slice('#join/'.length);
    opening(await open(fake, 'ben'), '#/discover');
    expect(await heading('Discover')).toBeVisible();

    await user.click(bar());
    await user.paste(`join us: ${link}`);

    expect(screen.getByRole('option')).toHaveTextContent(messages.linkBar.kinds.invite);
    expect(page()).toHaveAttribute('inert');
    expect(screen.getByRole('navigation', { hidden: true })).toHaveAttribute('inert');
    expect(window.location.hash).toBe('#/discover');
    expect(fake.requests).toEqual([]);
    expect(await axeViolations()).toEqual([]);

    await user.keyboard('{Enter}');

    // Join reads the invite's mailbox, which holds nothing here, so it says the link has expired.
    expect(await screen.findByText(messages.join.badLink)).toBeVisible();
    expect(window.location.hash).toBe('#/join');
    expect(bar()).toHaveValue('');
    expect(page()).not.toHaveAttribute('inert');
    // Focus lands on the new page, as after any navigation, never lost to the document.
    expect(page()).toContainElement(document.activeElement as HTMLElement);
    const stored = await scanDb('ben');
    expect(stored.text).not.toContain(payload);
    expect(containsBytes(stored.bytes, seed)).toBe(false);
    const kept = Object.keys(localStorage).map(
      (key) => `${key}=${localStorage.getItem(key) ?? ''}`,
    );
    expect(kept.join('\n')).not.toContain(payload);
  });

  it('opens a reconcile card from a form, through Bring a card', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    opening(await open(fake, 'ben'), '#/create');
    expect(await heading('Create a group')).toBeVisible();

    await user.click(bar());
    await user.paste(cardLink(ORIGIN, newCardSeed()));
    await user.click(screen.getByRole('option', { name: /A reconcile card/u }));

    // Bring a card reads the card's mailbox, which holds nothing here, so it says the card has expired.
    expect(await screen.findByText(messages.bring.badLink)).toBeVisible();
    expect(window.location.hash).toBe('#/card');
  });

  it.each([
    ['a front door, by its address', () => doorLinkOf(ORIGIN, newInviteSeed()), '#door/'],
    [
      'a shared Document, whose link stays in the address bar',
      () => shareLinkOf(ORIGIN, { seed: newInviteSeed(), publicKey: newInviteSeed() }),
      '#share/',
    ],
  ])('opens %s', async (_name, make, prefix) => {
    const user = userEvent.setup();
    const link = make();
    opening(await open(createFakeRelay(), 'ben'), '#/');
    expect(await heading('Your groups')).toBeVisible();

    await user.click(bar());
    await user.paste(link);
    await user.keyboard('{Enter}');

    expect(window.location.hash).toBe(new URL(link).hash);
    expect(window.location.hash.startsWith(prefix)).toBe(true);
  });

  it('points a pasted recovery code to Help someone recover, which opens bare, and keeps none of it', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const code = recoveryCode(newRecoveryKeys());
    const body = code.slice('RR1.'.length);
    opening(await open(fake, 'ben'), '#/');
    expect(await heading('Your groups')).toBeVisible();

    await user.click(bar());
    await user.paste(code);
    expect(bar()).toHaveValue('');
    await user.click(screen.getByRole('link', { name: 'Help someone recover' }));

    expect(await heading('Help someone recover')).toBeVisible();
    expect(window.location.hash).toBe('#/help-recover');
    expect(screen.queryByRole('search')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(body);
    for (const field of document.querySelectorAll('input, textarea')) {
      expect((field as HTMLInputElement).value).not.toContain(body);
    }
    expect((await scanDb('ben')).text).not.toContain(body);
    const kept = Object.keys(localStorage).map(
      (key) => `${key}=${localStorage.getItem(key) ?? ''}`,
    );
    expect(kept.join('\n')).not.toContain(body);
    expect(fake.requests).toEqual([]);
  });

  it('isn’t on a shared page, which stands outside the app', async () => {
    const link = shareLinkOf(ORIGIN, { seed: newInviteSeed(), publicKey: newInviteSeed() });
    opening(await open(createFakeRelay(), 'ben'), new URL(link).hash);

    // The fake relay holds no such share, so the page says it isn't shared.
    expect(await heading(messages.shared.goneTitle)).toBeVisible();
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
