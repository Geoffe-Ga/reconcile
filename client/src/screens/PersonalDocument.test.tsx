/**
 * One personal Document (#93, `#/me/{id}`): a title over the composer's Write
 * and Preview tabs, saved on this device about half a second after typing
 * stops, with no vote, and Delete behind an alert dialog. Nothing here ever
 * reaches the network.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { personalSharing } from '../app/personalSharing';
import { vaultKeyFromPrf } from '../crypto/keyVault';
import { xchachaSeal } from '../crypto/seal';
import { shareChannelOf } from '../crypto/share';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { createRelay } from '../net/relay';
import { parseShareLink, readShare, startSharing } from '../share/shareLink';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { openStore, type Store } from '../store/db';
import type { PersonalDocument as Stored } from '../store/personal';
import { PersonalDocument } from './PersonalDocument';

freshIndexedDBPerTest();

const ID = 'Q2FuYXJ5IHN0YXRlbWVudA';
const OTHER = 'UmVhZGluZyBsaXN0IGlkIQ';
const NOW = 1_762_650_000_000;

const STATEMENT: Stored = {
  id: ID,
  title: 'My mission statement',
  text: '# What I stand for\nI show up for my neighbors.\n',
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
};

let store: Store;
let clock: number;
let relay: FakeRelay;
let copied: string[];
const fetchSpy = vi.fn(() => Promise.reject(new Error('No network for personal Documents.')));
const ORIGIN = 'https://reconcile.test';

beforeEach(async () => {
  store = await openStore();
  clock = NOW;
  relay = createFakeRelay();
  copied = [];
  vi.stubGlobal('fetch', fetchSpy);
});

/** Sharing by link on the test's store and fake relay: no Web Share, so a link is copied. */
function sharing() {
  return personalSharing({
    store,
    relay: createRelay({ fetch: relay.fetch }),
    seal: xchachaSeal,
    now: () => clock,
    origin: ORIGIN,
    share: undefined,
    copyText: async (copiedText: string) => {
      copied.push(copiedText);
      await Promise.resolve();
    },
  });
}

afterEach(() => {
  store.close();
  fetchSpy.mockClear();
});

/** Renders the editor for `id` on the test's store, as `#/me/{id}` does. */
function open(id = ID, onDeleted = vi.fn()) {
  const view = render(
    <PersonalDocument
      id={id}
      documents={store}
      now={() => clock}
      onDeleted={onDeleted}
      sharing={sharing()}
    />,
  );
  return { ...view, onDeleted, user: userEvent.setup() };
}

const title = () => screen.getByRole('textbox', { name: 'Title' });
const text = () => screen.getByRole('textbox', { name: 'Text' });
const saved = () => screen.findByText('Saved on this device.', {}, { timeout: 2_000 });

describe('PersonalDocument', () => {
  it('offers the first Document as My mission statement, with its prompt, and stores nothing on the visit', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'My mission statement' })).toBe(
      document.activeElement,
    );
    expect(title()).toHaveValue('My mission statement');
    expect(text()).toHaveValue('');
    expect(
      screen.getByText('What do you stand for, and what are you working toward?'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /propose/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /why|link/i })).not.toBeInTheDocument();
    expect(document.title).toBe('Personal Document · Reconcile');
    expect(await store.listPersonal()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('creates the record on the first save, about 500 ms after typing stops, and says so', async () => {
    const { user } = open();
    await screen.findByRole('heading', { level: 1 });

    await user.type(text(), 'I show up for my neighbors.');

    const line = await saved();
    expect(line).toBeVisible();
    expect(line).toHaveAttribute('role', 'status');
    expect(await store.listPersonal()).toEqual([
      {
        id: ID,
        title: 'My mission statement',
        text: 'I show up for my neighbors.',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  it('starts a Document beside others with a blank title, and holds saving until it has one', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open(OTHER);
    await screen.findByRole('heading', { level: 1, name: 'Untitled' });
    expect(title()).toHaveValue('');
    expect(screen.queryByText(/What do you stand for/)).not.toBeInTheDocument();

    await user.type(text(), 'Braiding Sweetgrass');
    expect(
      await screen.findByText(
        'Not saved yet. Fix the title to save your changes.',
        {},
        { timeout: 2_000 },
      ),
    ).toBeVisible();
    expect(await store.getPersonal(OTHER)).toBeUndefined();

    await user.type(title(), '  Reading list ');
    await saved();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reading list');
    expect(await store.getPersonal(OTHER)).toMatchObject({
      title: 'Reading list',
      text: 'Braiding Sweetgrass',
    });
  });

  it('keeps an edit across a remount, even one made just before leaving', async () => {
    await store.savePersonal(STATEMENT);
    const first = open();
    await first.user.type(await screen.findByRole('textbox', { name: 'Text' }), ' Every week.');
    first.unmount();

    open();

    expect(await screen.findByRole('textbox', { name: 'Text' })).toHaveValue(
      `${STATEMENT.text} Every week.`,
    );
    expect(title()).toHaveValue('My mission statement');
    expect(screen.queryByText(/What do you stand for/)).not.toBeInTheDocument();
  });

  it('keeps the text as typed, and its creation time, and stamps each save', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    const box = await screen.findByRole('textbox', { name: 'Text' });
    clock = NOW + 5_000;

    await user.clear(box);
    await user.type(box, 'Line one   {Enter}{Enter}{Enter}Line two  ');
    await saved();

    expect(await store.getPersonal(ID)).toEqual({
      ...STATEMENT,
      text: 'Line one   \n\n\nLine two  ',
      updatedAt: NOW + 5_000,
    });
  });

  it('never stamps a save earlier than the one before, even when the clock goes back', async () => {
    await store.savePersonal({ ...STATEMENT, updatedAt: NOW + 9_000 });
    const { user } = open();
    clock = NOW;

    await user.type(await screen.findByRole('textbox', { name: 'Text' }), 'More.');
    await saved();

    expect((await store.getPersonal(ID))?.updatedAt).toBe(NOW + 9_000);
  });

  it('refuses a 121-code-point title, with a message tied to the field, and keeps the last good one', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    const field = await screen.findByRole('textbox', { name: 'Title' });

    await user.clear(field);
    // 🌱 is one code point but two UTF-16 units, so the limit counts what a person sees.
    await user.paste('🌱'.repeat(121));
    await user.tab();

    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription('Keep the title to 120 characters or fewer.');
    expect(
      await screen.findByText(
        'Not saved yet. Fix the title to save your changes.',
        {},
        { timeout: 2_000 },
      ),
    ).toBeVisible();
    expect((await store.getPersonal(ID))?.title).toBe('My mission statement');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My mission statement');

    await user.clear(field);
    await user.paste('🌱'.repeat(120));
    await user.tab();
    await saved();
    expect(field).toBeValid();
    expect((await store.getPersonal(ID))?.title).toBe('🌱'.repeat(120));
  });

  it('refuses a blank title with its own message', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    const field = await screen.findByRole('textbox', { name: 'Title' });

    await user.clear(field);
    await user.tab();

    expect(field).toHaveAccessibleDescription('Give this Document a title.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My mission statement');
  });

  it('previews the normalized text as it will read, and never renders a javascript: link', async () => {
    await store.savePersonal({ ...STATEMENT, text: '[x](javascript:alert(1))\r\n' });
    const { user } = open();
    await screen.findByRole('textbox', { name: 'Text' });

    await user.click(screen.getByRole('tab', { name: 'Preview' }));

    const preview = screen.getByRole('tabpanel', { name: 'Preview' });
    expect(within(preview).queryByRole('link')).not.toBeInTheDocument();
    expect(preview).toHaveTextContent('[x](javascript:alert(1))');
    expect(preview.querySelector('a')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('previews the text normalized, as #105 will share it, while the stored text stays as typed', async () => {
    const typed = 'Cafe\u0301 on Fridays.\r\n\r\n\r\n';
    await store.savePersonal({ ...STATEMENT, text: typed });
    const { user } = open();
    await screen.findByRole('textbox', { name: 'Text' });

    await user.click(screen.getByRole('tab', { name: 'Preview' }));

    const paragraph = within(screen.getByRole('tabpanel', { name: 'Preview' })).getByText(/^Caf/);
    expect(paragraph.textContent).toBe('Caf\u00e9 on Fridays.');
    expect(text()).toHaveValue(typed.replace(/\r\n/g, '\n'));
    expect((await store.getPersonal(ID))?.text).toBe(typed);
  });

  it('previews Markdown through the one renderer, and says when there’s nothing to preview', async () => {
    const { user } = open();
    await screen.findByRole('textbox', { name: 'Text' });

    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('Nothing to preview yet.')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Write' }));
    await user.type(text(), '# What I stand for{Enter}I show up.');
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    const preview = screen.getByRole('tabpanel', { name: 'Preview' });
    expect(
      within(preview).getByRole('heading', { level: 2, name: 'What I stand for' }),
    ).toBeVisible();
    expect(within(preview).getByText('I show up.')).toBeVisible();
  });

  it('deletes the Document only once the alert dialog is confirmed, in its words', async () => {
    await store.savePersonal(STATEMENT);
    await store.savePersonal({ ...STATEMENT, id: OTHER, title: 'Reading list' });
    const { user, onDeleted } = open();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByRole('heading', {
        name: 'Delete ‘My mission statement’ from this device?',
      }),
    ).toBeVisible();
    expect(within(dialog).getByText('A backup you saved earlier still has it.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await store.getPersonal(ID)).toEqual(STATEMENT);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );

    expect(onDeleted).toHaveBeenCalledOnce();
    expect(await store.getPersonal(ID)).toBeUndefined();
    expect((await store.listPersonal()).map((kept) => kept.id)).toEqual([OTHER]);
  });

  it('never brings a deleted Document back with a save that was still waiting', async () => {
    await store.savePersonal(STATEMENT);
    const { user, unmount } = open();
    await user.type(await screen.findByRole('textbox', { name: 'Text' }), ' Unsaved.');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));

    expect(await store.listPersonal()).toEqual([]);
  });

  it('says so when a delete fails, keeps the Document, and saves what was typed', async () => {
    await store.savePersonal(STATEMENT);
    const failing = Object.assign(Object.create(store) as Store, {
      deletePersonal: vi.fn(() => Promise.reject(new Error('IndexedDB refused.'))),
    });
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(
      <PersonalDocument
        id={ID}
        documents={failing}
        now={() => clock}
        onDeleted={onDeleted}
        sharing={sharing()}
      />,
    );
    await user.type(await screen.findByRole('textbox', { name: 'Text' }), ' Kept.');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );

    expect(
      await within(screen.getByRole('alertdialog')).findByText(
        'It couldn’t be deleted from this device. Try again.',
      ),
    ).toBeVisible();
    expect(onDeleted).not.toHaveBeenCalled();
    await saved();
    expect((await store.getPersonal(ID))?.text).toBe(`${STATEMENT.text} Kept.`);
  });

  it('says so when a save fails, and saves again on the next pause', async () => {
    await store.savePersonal(STATEMENT);
    const savePersonal = vi
      .fn<Store['savePersonal']>()
      .mockRejectedValueOnce(new Error('Quota exceeded.'))
      .mockImplementation((document) => store.savePersonal(document));
    const flaky = Object.assign(Object.create(store) as Store, { savePersonal });
    const user = userEvent.setup();
    render(
      <PersonalDocument
        id={ID}
        documents={flaky}
        now={() => clock}
        onDeleted={vi.fn()}
        sharing={sharing()}
      />,
    );
    const box = await screen.findByRole('textbox', { name: 'Text' });

    await user.type(box, ' One.');
    expect(
      await screen.findByText(
        'Your changes couldn’t be saved on this device. Keep typing to try again.',
        {},
        { timeout: 2_000 },
      ),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toBeVisible();

    await user.type(box, ' Two.');
    await saved();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect((await store.getPersonal(ID))?.text).toBe(`${STATEMENT.text} One. Two.`);
  });

  it('says so, with no editor, when the device’s Documents can’t be read, so nothing typed replaces one', async () => {
    const unreadable = Object.assign(Object.create(store) as Store, {
      listPersonalEntries: () => Promise.reject(new Error('IndexedDB refused.')),
    });
    render(
      <PersonalDocument
        id={ID}
        documents={unreadable}
        now={() => clock}
        onDeleted={vi.fn()}
        sharing={sharing()}
      />,
    );

    expect(
      await screen.findByText(
        'This Document couldn’t be read on this device. Reload Reconcile, then try again.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Personal/ })).toHaveAttribute('href', '#/me');
    expect(await axeViolations()).toEqual([]);
  });

  it('links back to Personal, and says what stays on this device', async () => {
    open();

    expect(await screen.findByRole('link', { name: /Personal/ })).toHaveAttribute('href', '#/me');
    expect(
      screen.getByText(
        'This stays on this device. Nothing here is sent to the relay or to your groups. A backup file you save includes it.',
      ),
    ).toBeVisible();
  });

  it('sends no request while a Document is created, edited, previewed or deleted', async () => {
    const { user, onDeleted } = open();
    await screen.findByRole('textbox', { name: 'Text' });

    await user.type(text(), 'Canary: I show up for my neighbors.');
    await saved();
    await user.type(title(), ' (draft)');
    await user.type(text(), ' Every week.');
    await saved();
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    await user.click(screen.getByRole('tab', { name: 'Write' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );

    expect(onDeleted).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** What anyone holding `link` reads now. */
async function linkShows(link: string) {
  const parsed = parseShareLink(link);
  if (parsed === null) throw new Error('Expected a share link.');
  return readShare({ relay: createRelay({ fetch: relay.fetch }), seal: xchachaSeal }, parsed);
}

/** The share section, once the Document's stored state is read. */
const shareSection = () => screen.findByRole('region', { name: messages.personal.share.heading });

/** The link field's value. */
const linkField = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: messages.personal.share.field });

describe('PersonalDocument, shared by link (#105)', () => {
  const { share } = messages.personal;

  it('offers Share link only once the Document is saved, off, with what the link and the relay show', async () => {
    await store.savePersonal(STATEMENT);
    open();

    const section = await shareSection();
    expect(within(section).getByText(share.about)).toBeVisible();
    expect(within(section).getByText(share.relay)).toBeVisible();
    const start = within(section).getByRole('button', { name: share.start });
    expect(start).toHaveAccessibleDescription(`${share.about} ${share.relay}`);
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(messages.personal.documentPrivacy)).toBeVisible();
    expect(relay.requests).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no share for a Document never saved', async () => {
    open();
    await screen.findByRole('textbox', { name: 'Text' });

    expect(screen.queryByRole('region', { name: share.heading })).not.toBeInTheDocument();
  });

  it('posts the first copy, then copies the link with fixed words only, and shows it beside its warning', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));

    expect(await screen.findByText(share.copied)).toBeVisible();
    const link = linkField().value;
    expect(link).toMatch(/^https:\/\/reconcile\.test\/#share\/[\w-]{43}\.[\w-]{43}$/);
    expect(copied).toEqual([`${share.message} ${link}`]);
    expect(copied[0]).not.toContain('mission');
    expect(linkField()).toHaveAccessibleDescription(share.warning);
    expect(screen.getByText(share.edits)).toBeVisible();
    expect(screen.getByRole('button', { name: share.stop })).toBeVisible();
    expect(screen.getByText(messages.personal.sharedPrivacy)).toBeVisible();
    expect(screen.queryByText(messages.personal.documentPrivacy)).not.toBeInTheDocument();
    expect(await linkShows(link)).toEqual({
      kind: 'shown',
      title: STATEMENT.title,
      text: STATEMENT.text,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: share.shareAgain }));
    await vi.waitFor(() => {
      expect(copied).toHaveLength(2);
    });
    expect(relay.requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  });

  it('saves what was just typed before it shares, so the link shows it', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    const section = await shareSection();
    await user.clear(text());
    await user.type(text(), 'Typed just now.');

    await user.click(within(section).getByRole('button', { name: share.start }));

    await screen.findByText(share.copied);
    expect(await linkShows(linkField().value)).toEqual({
      kind: 'shown',
      title: STATEMENT.title,
      text: 'Typed just now.\n',
    });
  });

  it('says so, shares nothing and copies nothing, when the relay can’t be reached', async () => {
    await store.savePersonal(STATEMENT);
    relay.offline = true;
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));

    expect(await screen.findByText(share.startFailed)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: share.field })).not.toBeInTheDocument();
    expect(copied).toEqual([]);
    expect((await store.getPersonal(ID))?.share).toBeUndefined();
  });

  it('refuses a Document too long to share, with the message tied to the button, and asks nothing of the relay', async () => {
    await store.savePersonal({ ...STATEMENT, text: 'x'.repeat(MAX_RECORD_BYTES) });
    const { user } = open();
    const start = within(await shareSection()).getByRole('button', { name: share.start });

    await user.click(start);

    expect(await screen.findByText(share.tooLarge)).toBeVisible();
    expect(start).toHaveAccessibleDescription(`${share.about} ${share.relay} ${share.tooLarge}`);
    expect(relay.requests).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('opens a shared Document with its link, and says when an edit hasn’t reached it yet', async () => {
    await store.savePersonal(STATEMENT);
    const services = {
      store,
      relay: createRelay({ fetch: relay.fetch }),
      seal: xchachaSeal,
      now: () => clock,
    };
    await startSharing(services, ID);
    await store.savePersonal({ ...STATEMENT, text: 'Edited, not posted.\n' });
    open();

    await shareSection();
    expect(linkField().value).toMatch(/^https:\/\/reconcile\.test\/#share\//);
    expect(screen.getByText(share.pending)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('posts an edit once the editor closes, and nothing when nothing changed', async () => {
    await store.savePersonal(STATEMENT);
    const { user, unmount } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const link = linkField().value;
    await user.clear(text());
    await user.type(text(), 'Edited for the link.');

    unmount();

    await vi.waitFor(async () => {
      expect(await linkShows(link)).toEqual({
        kind: 'shown',
        title: STATEMENT.title,
        text: 'Edited for the link.\n',
      });
    });
    expect((await store.getPersonal(ID))?.share?.pending).toBe(false);
    const posts = relay.requests.filter(({ method }) => method === 'PUT').length;
    open().unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relay.requests.filter(({ method }) => method === 'PUT')).toHaveLength(posts);
  });

  it('says when an edit has made it too long for its link', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);

    await user.click(text());
    await user.paste('x'.repeat(MAX_RECORD_BYTES));

    expect(await screen.findByText(share.tooLargeShared)).toBeVisible();
  });

  it('Stop sharing posts a tombstone, says what it can’t recall, and Share link then makes a new link', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const first = linkField().value;

    await user.click(screen.getByRole('button', { name: share.stop }));

    expect(await screen.findByText(share.stopped)).toBeVisible();
    expect(await linkShows(first)).toEqual({ kind: 'gone' });
    expect(screen.queryByRole('textbox', { name: share.field })).not.toBeInTheDocument();
    expect(screen.getByText(messages.personal.documentPrivacy)).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    expect(linkField().value).not.toBe(first);
  });

  it('changes nothing when Stop sharing can’t reach the relay, and says so', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const link = linkField().value;
    relay.offline = true;

    await user.click(screen.getByRole('button', { name: share.stop }));

    expect(await screen.findByText(share.stopFailed)).toBeVisible();
    expect(linkField()).toHaveValue(link);
    relay.offline = false;
    expect((await linkShows(link)).kind).toBe('shown');
  });

  it('stops sharing before it deletes a shared Document, and says so in the dialog', async () => {
    await store.savePersonal(STATEMENT);
    const { user, onDeleted } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const link = linkField().value;

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(messages.personal.deleteShared)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await vi.waitFor(() => {
      expect(onDeleted).toHaveBeenCalledOnce();
    });
    expect(await linkShows(link)).toEqual({ kind: 'gone' });
    expect(await store.listPersonal()).toEqual([]);
  });

  it('deletes nothing when sharing can’t be stopped first, and says why', async () => {
    await store.savePersonal(STATEMENT);
    const { user, onDeleted } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    relay.offline = true;

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByText(messages.personal.deleteSharedFailed)).toBeVisible();
    expect(onDeleted).not.toHaveBeenCalled();
    expect((await store.getPersonal(ID))?.share).toBeDefined();
  });

  it('names the share mailbox to the relay and nothing of the Document', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const parsed = parseShareLink(linkField().value);
    if (parsed === null) throw new Error('Expected a link.');
    const mailbox = shareChannelOf(parsed.seed).mailbox;

    expect(relay.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /v1/mailbox/${mailbox}?after=0&limit=100`,
      `PUT /v1/mailbox/${mailbox}?ttl_days=30`,
    ]);
  });

  it('selects the whole link when its field takes focus', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);

    await user.click(linkField());

    const field = linkField();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
  });

  it('offers Share link when the device can’t say whether the Document is shared', async () => {
    await store.savePersonal(STATEMENT);
    const unsure = { ...sharing(), read: () => Promise.reject(new Error('IndexedDB refused.')) };
    render(
      <PersonalDocument
        id={ID}
        documents={store}
        now={() => clock}
        onDeleted={vi.fn()}
        sharing={unsure}
      />,
    );

    expect(within(await shareSection()).getByRole('button', { name: share.start })).toBeVisible();
  });
});

describe('PersonalDocument, shared, while this device’s keys are locked (#255)', () => {
  const { share } = messages.personal;
  const SALT = new Uint8Array(32).fill(0x33);
  const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
  const LOCK = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

  /** Locks the device's keys from another tab, as Settings there would, leaving this one locked. */
  async function lockFromAnotherTab(): Promise<void> {
    const other = await openStore();
    await other.sealKeys(LOCK, KEY);
    other.close();
  }

  it('says the Document is shared and how to unlock, with no link, button or Delete', async () => {
    await store.savePersonal(STATEMENT);
    const services = {
      store,
      relay: createRelay({ fetch: relay.fetch }),
      seal: xchachaSeal,
      now: () => clock,
    };
    await startSharing(services, ID);
    await store.savePersonal({ ...STATEMENT, text: 'Edited, not posted.\n' });
    await store.sealKeys(LOCK, KEY);
    store.close();
    store = await openStore();
    const requests = relay.requests.length;

    open();

    const section = await shareSection();
    expect(within(section).getByText(share.locked)).toBeVisible();
    expect(within(section).getByText(share.pending)).toBeVisible();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByText(messages.personal.sharedPrivacy)).toBeVisible();
    expect(relay.requests).toHaveLength(requests);
    expect(await axeViolations()).toEqual([]);
  });

  it('still saves what’s typed while locked, and posts nothing as the editor closes', async () => {
    await store.savePersonal(STATEMENT);
    const services = {
      store,
      relay: createRelay({ fetch: relay.fetch }),
      seal: xchachaSeal,
      now: () => clock,
    };
    await startSharing(services, ID);
    await store.sealKeys(LOCK, KEY);
    store.close();
    store = await openStore();
    const requests = relay.requests.length;
    const { user, unmount } = open();
    await shareSection();

    await user.type(text(), ' Kept.');
    await saved();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [entry] = await store.listPersonalEntries();
    expect([entry?.text, entry?.share?.pending]).toEqual([`${STATEMENT.text} Kept.`, true]);
    expect(relay.requests).toHaveLength(requests);
  });

  it('says nothing changed when another tab locked the keys before Stop sharing, and sends nothing', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    const link = linkField().value;
    await lockFromAnotherTab();
    const requests = relay.requests.length;

    await user.click(screen.getByRole('button', { name: share.stop }));

    expect(await screen.findByText(share.lockedNow)).toBeVisible();
    expect(linkField()).toHaveValue(link);
    expect(screen.getByRole('button', { name: share.stop })).toBeEnabled();
    expect(relay.requests).toHaveLength(requests);
    expect((await linkShows(link)).kind).toBe('shown');
  });

  it('says nothing changed when another tab locked the keys before Share link, and sends nothing', async () => {
    await store.savePersonal(STATEMENT);
    const { user } = open();
    const start = within(await shareSection()).getByRole('button', { name: share.start });
    await lockFromAnotherTab();

    await user.click(start);

    expect(await screen.findByText(share.lockedNow)).toBeVisible();
    expect(start).toBeEnabled();
    expect(relay.requests).toEqual([]);
    expect(copied).toEqual([]);
    expect((await store.listPersonalEntries())[0]?.share).toBeUndefined();
  });

  it('deletes nothing when another tab locked the keys first, and says why', async () => {
    await store.savePersonal(STATEMENT);
    const { user, onDeleted } = open();
    await user.click(within(await shareSection()).getByRole('button', { name: share.start }));
    await screen.findByText(share.copied);
    await lockFromAnotherTab();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByText(messages.personal.deleteSharedFailed)).toBeVisible();
    expect(onDeleted).not.toHaveBeenCalled();
    expect((await store.listPersonalEntries())[0]?.share).toBeDefined();
  });
});
