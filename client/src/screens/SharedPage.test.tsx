/**
 * The reader's page for a shared personal Document (#105): anyone with the
 * link reads the latest version, in any browser, with nothing kept on their
 * device and nothing of Reconcile's started.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { xchachaSeal } from '../crypto/seal';
import { shareChannelOf } from '../crypto/share';
import type * as SignModule from '../crypto/sign';
import { newSigningKeys } from '../crypto/sign';
import { createRelay } from '../net/relay';
import { type ShareLink, sharePayloadOf, startSharing, stopSharing } from '../share/shareLink';
import { openStore, type Store } from '../store/db';
import { TEST_NOW } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { SharedPage } from './SharedPage';

vi.mock('../crypto/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof SignModule>();
  return { ...actual, newSigningKeys: vi.fn(actual.newSigningKeys) };
});

freshIndexedDBPerTest();

const keysMade = vi.mocked(newSigningKeys);
const stores: Store[] = [];
const ID = 'U2hhcmVkIHN0YXRlbWVudA';

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  keysMade.mockClear();
  window.history.replaceState(null, '', '/');
});

/** Ana's device shares a Document titled `title` with `text`; returns the link's payload. */
async function anaShares(fake: FakeRelay, title: string, text: string) {
  const store = await openStore('ana');
  stores.push(store);
  const services = {
    store,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
    now: () => TEST_NOW,
  };
  await store.savePersonal({ id: ID, title, text, createdAt: TEST_NOW, updatedAt: TEST_NOW });
  const started = await startSharing(services, ID);
  if (started.kind !== 'shared') throw new Error('Expected a share.');
  return { payload: sharePayloadOf(started.link), link: started.link, services };
}

/** The page for `payload`, read through `fake`, as a fresh browser opens it. */
function renderPage(fake: FakeRelay, payload: string) {
  window.history.replaceState(null, '', `/#share/${payload}`);
  const reader = { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
  render(<SharedPage payload={payload} reader={reader} />);
  return { user: userEvent.setup() };
}

describe('SharedPage', () => {
  it('shows the latest version under “Shared with Reconcile. Read-only.”, the title as plain text and the text formatted', async () => {
    const fake = createFakeRelay();
    const { payload } = await anaShares(
      fake,
      'What I <b>stand</b> for',
      '# Neighbours\n\nI show up **every** week.\n',
    );
    renderPage(fake, payload);

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'What I <b>stand</b> for',
    });
    expect(heading.querySelector('bdi')?.textContent).toBe('What I <b>stand</b> for');
    expect(heading.querySelector('b')).toBe(null);
    expect(screen.getByText(messages.shared.note)).toBeVisible();
    const article = screen.getByRole('article');
    expect(within(article).getByRole('heading', { level: 2, name: 'Neighbours' })).toBeVisible();
    expect(within(article).getByText('every').tagName).toBe('STRONG');
    expect(screen.queryByRole('textbox')).toBe(null);
    expect(screen.queryByRole('button')).toBe(null);
    expect(await axeViolations()).toEqual([]);
  });

  it('names the tab generically, never with the Document’s own words, and leaves the link in the address bar', async () => {
    const fake = createFakeRelay();
    const { payload } = await anaShares(fake, 'Private title', 'Words.\n');
    renderPage(fake, payload);

    await screen.findByRole('heading', { level: 1, name: 'Private title' });

    expect(document.title).toBe(messages.app.pageTitle(messages.shared.pageTitle));
    expect(document.title).not.toContain('Private');
    expect(window.location.hash).toBe(`#share/${payload}`);
  });

  it('opens no database, makes no key, writes no web storage and polls nothing while it loads and renders', async () => {
    const fake = createFakeRelay();
    const { payload, link } = await anaShares(fake, 'Me', 'Real.\n');
    keysMade.mockClear();
    fake.requests.length = 0;
    const opened = vi.spyOn(indexedDB, 'open');
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    renderPage(fake, payload);

    await screen.findByRole('heading', { level: 1, name: 'Me' });
    // It is given no sync loop, only the relay and the seal: nothing more goes out after the one read.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(opened).not.toHaveBeenCalled();
    expect(keysMade).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
    expect(fake.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /v1/mailbox/${shareChannelOf(link.seed).mailbox}?after=0&limit=100`,
    ]);
  });

  it('shows the not-shared line once sharing stops', async () => {
    const fake = createFakeRelay();
    const { payload, services } = await anaShares(fake, 'Me', 'Real.\n');
    await stopSharing(services, ID);
    renderPage(fake, payload);

    expect(await screen.findByText(messages.shared.gone)).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: messages.shared.goneTitle }),
    ).toBeVisible();
    expect(screen.queryByText('Real.')).toBe(null);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the not-shared line for a link to an empty mailbox', async () => {
    const fake = createFakeRelay();
    const link: ShareLink = {
      seed: new Uint8Array(32).fill(4),
      publicKey: newSigningKeys().publicKey,
    };
    renderPage(fake, sharePayloadOf(link));

    expect(await screen.findByText(messages.shared.gone)).toBeVisible();
  });

  it.each([
    ['nothing', ''],
    ['a seed alone', base64url(new Uint8Array(32))],
    ['a short key', `${base64url(new Uint8Array(32))}.${'A'.repeat(42)}`],
    ['a path after it', `${base64url(new Uint8Array(32))}.${base64url(new Uint8Array(32))}/x`],
  ])(
    'shows the not-shared line for a damaged link holding %s, making no request',
    async (_name, payload) => {
      const fake = createFakeRelay();
      renderPage(fake, payload);

      expect(await screen.findByText(messages.shared.gone)).toBeVisible();
      expect(fake.requests).toEqual([]);
    },
  );

  it('says when the relay can’t be reached, and Try again reads it again', async () => {
    const fake = createFakeRelay();
    const { payload } = await anaShares(fake, 'Me', 'Back again.\n');
    fake.offline = true;
    const { user } = renderPage(fake, payload);

    expect(await screen.findByText(messages.shared.offline)).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: messages.shared.offlineTitle }),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    fake.offline = false;
    await user.click(screen.getByRole('button', { name: messages.shared.retry }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Me' })).toBeVisible();
    expect(screen.getByText('Back again.')).toBeVisible();
  });

  it('says a shared Document with no text has none yet', async () => {
    const fake = createFakeRelay();
    const { payload } = await anaShares(fake, 'Me', '   \n');
    renderPage(fake, payload);

    expect(await screen.findByText(messages.shared.empty)).toBeVisible();
    expect(screen.queryByRole('article')).toBe(null);
  });

  it('reads a new link when the page is handed one', async () => {
    const fake = createFakeRelay();
    const first = await anaShares(fake, 'First', 'One.\n');
    await stopSharing(first.services, ID);
    const second = await startSharing(first.services, ID);
    if (second.kind !== 'shared') throw new Error('Expected a share.');
    const reader = { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
    const { rerender } = render(<SharedPage payload={first.payload} reader={reader} />);
    expect(await screen.findByText(messages.shared.gone)).toBeVisible();

    rerender(<SharedPage payload={sharePayloadOf(second.link)} reader={reader} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'First' })).toBeVisible();
  });
});
