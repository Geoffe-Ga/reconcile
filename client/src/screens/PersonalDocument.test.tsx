/**
 * One personal Document (#93, `#/me/{id}`): a title over the composer's Write
 * and Preview tabs, saved on this device about half a second after typing
 * stops, with no vote, and Delete behind an alert dialog. Nothing here ever
 * reaches the network.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
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
const fetchSpy = vi.fn(() => Promise.reject(new Error('No network for personal Documents.')));

beforeEach(async () => {
  store = await openStore();
  clock = NOW;
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  store.close();
  fetchSpy.mockClear();
});

/** Renders the editor for `id` on the test's store, as `#/me/{id}` does. */
function open(id = ID, onDeleted = vi.fn()) {
  const view = render(
    <PersonalDocument id={id} documents={store} now={() => clock} onDeleted={onDeleted} />,
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

    expect(await saved()).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device.');
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
      <PersonalDocument id={ID} documents={failing} now={() => clock} onDeleted={onDeleted} />,
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
    render(<PersonalDocument id={ID} documents={flaky} now={() => clock} onDeleted={vi.fn()} />);
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
      listPersonal: () => Promise.reject(new Error('IndexedDB refused.')),
    });
    render(
      <PersonalDocument id={ID} documents={unreadable} now={() => clock} onDeleted={vi.fn()} />,
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
