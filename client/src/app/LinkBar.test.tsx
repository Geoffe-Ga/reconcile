/**
 * The link bar (#444; ADR-0077 §6, DESIGN.md "Link bar"): a pill that reads
 * any Reconcile link pasted or typed into it, says what it is in one row,
 * and opens it only on Enter or a tap; Cmd+L, Ctrl+L or `/` reach it from
 * anywhere; Escape empties it, then hands focus back; and on a touch device
 * an empty bar offers Paste, the only place the app reads the clipboard.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { cardLink } from '../coalition/card';
import { followLink } from '../coalition/follow';
import { newCardSeed } from '../crypto/card';
import { newInviteSeed } from '../crypto/invite';
import { linkCode, newLinkKeys, newLinkSeed } from '../crypto/link';
import { newRecoveryKeys, recoveryCode } from '../crypto/recovery';
import { doorLinkOf } from '../door/page';
import { shareLinkOf } from '../share/shareLink';
import { axeViolations } from '../test/axe';
import { inviteLink } from './invite';
import { LinkBar, type LinkBarProps } from './LinkBar';

const ORIGIN = 'https://reconcile.example';

/** The link bar under a page with a field of its own, as the app shows it. */
function setup(props: Partial<LinkBarProps> = {}) {
  document.title = 'A page · Reconcile';
  const onOpen = vi.fn();
  const onPanelChange = vi.fn();
  render(
    <>
      <LinkBar onOpen={onOpen} onPanelChange={onPanelChange} touch={false} {...props} />
      <main>
        <h1>A page</h1>
        <label>
          Your note
          <input type="text" />
        </label>
      </main>
    </>,
  );
  return { user: userEvent.setup(), onOpen, onPanelChange };
}

/** The bar's field. */
function bar(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search or paste a link' });
}

/** The page's own field. */
function note(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Your note' });
}

/** Pastes `text` into the bar. */
async function paste(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(bar());
  await user.paste(text);
}

/** What follows the fragment's prefix in `link`. */
function payloadOf(link: string): string {
  const fragment = new URL(link).hash;
  return fragment.slice(fragment.indexOf('/') + 1);
}

describe('LinkBar', () => {
  it('is a search landmark holding one field, "Search or paste a link", and nothing under it while empty', async () => {
    setup();

    const search = screen.getByRole('search');
    expect(within(search).getByRole('searchbox')).toBe(bar());
    expect(bar()).toHaveAttribute('placeholder', 'Search or paste a link');
    expect(bar()).toHaveAttribute('autocomplete', 'off');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says what a pasted invite is in one row, and opens nothing until Enter', async () => {
    const { user, onOpen, onPanelChange } = setup();
    const link = inviteLink(ORIGIN, newInviteSeed());

    await paste(user, `hey, join us ${link} `);

    const rows = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('An invite');
    expect(rows[0]).toHaveTextContent('Open');
    expect(screen.getByRole('status')).toHaveTextContent('1 result');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onPanelChange).toHaveBeenLastCalledWith(true);
    expect(await axeViolations()).toEqual([]);

    await user.keyboard('{Enter}');

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'invite', payload: payloadOf(link) });
    expect(bar()).toHaveValue('');
    expect(bar()).not.toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onPanelChange).toHaveBeenLastCalledWith(false);
  });

  it('opens a link from a tap on its row, as from Enter', async () => {
    const { user, onOpen } = setup();
    const link = cardLink(ORIGIN, newCardSeed());

    await paste(user, link);
    await user.click(screen.getByRole('option', { name: /A reconcile card/u }));

    expect(onOpen).toHaveBeenCalledWith({ kind: 'card', payload: payloadOf(link) });
    expect(bar()).toHaveValue('');
    await waitFor(() => {
      expect(bar()).not.toHaveFocus();
    });
  });

  it.each([
    ['A reconcile card', () => cardLink(ORIGIN, newCardSeed())],
    ['A coalition to follow', () => followLink(ORIGIN, newInviteSeed())],
    ['A front door', () => doorLinkOf(ORIGIN, newInviteSeed())],
    [
      'A shared Document',
      () => shareLinkOf(ORIGIN, { seed: newInviteSeed(), publicKey: newInviteSeed() }),
    ],
  ])('names %s in plain words', async (words, make) => {
    const { user } = setup();

    await paste(user, make());

    expect(screen.getByRole('option')).toHaveTextContent(words);
  });

  it.each([
    [
      'a damaged or cut-off link',
      `${ORIGIN}/#join/not-a-real-payload`,
      'This link is damaged or cut off. Copy all of it and paste it again.',
    ],
    ['a link to any other site', 'https://example.com/whatever', 'That isn’t a Reconcile link.'],
  ])('says so in one line for %s, and offers nothing to open', async (_name, text, line) => {
    const { user, onOpen } = setup();

    await paste(user, text);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(within(screen.getByRole('search')).getByText(line, { selector: 'p' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(line);
    await user.keyboard('{Enter}');
    expect(onOpen).not.toHaveBeenCalled();
    expect(bar()).toHaveValue(text);
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    [
      'a linking code',
      () => linkCode(newLinkSeed(), newLinkKeys().publicKey),
      'That’s a linking code. Open Link to my other device and paste it there.',
      'Link to my other device',
      '#/link-this',
    ],
    [
      'a recovery code',
      () => recoveryCode(newRecoveryKeys()),
      'That’s a recovery code. Open Help someone recover and paste it there.',
      'Help someone recover',
      '#/help-recover',
    ],
  ])(
    'points %s to where it goes, empties the field and keeps none of it',
    async (_name, make, line, screenName, href) => {
      const { user, onOpen } = setup();
      const code = make();
      const hash = window.location.hash;
      const entries = window.history.length;

      await paste(user, `here’s my code: ${code}`);

      expect(bar()).toHaveValue('');
      const search = screen.getByRole('search');
      expect(within(search).getByText(line, { selector: 'p' })).toBeVisible();
      expect(within(search).getByRole('link', { name: screenName })).toHaveAttribute('href', href);
      expect(screen.getByRole('status')).toHaveTextContent(line);
      expect(screen.queryByRole('listbox')).toBeNull();
      // The code reaches nothing: not the page, not a field, not the address bar or history.
      expect(document.body.innerHTML).not.toContain(code.slice(4));
      for (const field of document.querySelectorAll('input')) {
        expect(field.value).not.toContain(code.slice(4));
      }
      expect(window.location.hash).toBe(hash);
      expect(window.history.length).toBe(entries);
      expect(onOpen).not.toHaveBeenCalled();
      expect(await axeViolations()).toEqual([]);
    },
  );

  it('dismisses a code’s pointer on Escape, then hands focus back on a second', async () => {
    const { user } = setup();
    await user.click(note());
    await user.keyboard('{Control>}l{/Control}');
    await user.paste(recoveryCode(newRecoveryKeys()));
    expect(screen.getByRole('link', { name: 'Help someone recover' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('link', { name: 'Help someone recover' })).toBeNull();
    expect(bar()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(note()).toHaveFocus();
  });

  it('empties from Clear, which shows only once there is text', async () => {
    const { user } = setup();

    await paste(user, 'quiet hours');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(bar()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it.each([
    ['Cmd+L', '{Meta>}l{/Meta}'],
    ['Ctrl+L', '{Control>}l{/Control}'],
  ])(
    'takes the cursor on %s from inside another field, with its text selected',
    async (_name, keys) => {
      const { user } = setup();
      await paste(user, 'quiet hours');
      await user.click(note());

      await user.keyboard(keys);

      expect(bar()).toHaveFocus();
      expect([bar().selectionStart, bar().selectionEnd]).toEqual([0, 'quiet hours'.length]);
      expect(note()).toHaveValue('');
    },
  );

  it('takes the cursor on "/" outside a field, but leaves "/" to a field that has focus', async () => {
    const { user } = setup();

    await user.click(note());
    await user.keyboard('/');
    expect(note()).toHaveValue('/');
    expect(note()).toHaveFocus();

    await user.click(screen.getByRole('heading', { name: 'A page' }));
    await user.keyboard('/');
    expect(bar()).toHaveFocus();
    expect(bar()).toHaveValue('');
  });

  it('empties on Escape, and hands focus back to where it was on a second Escape', async () => {
    const { user, onPanelChange } = setup();
    await user.click(note());
    await user.keyboard('{Control>}l{/Control}');
    await user.paste('https://example.com/whatever');

    await user.keyboard('{Escape}');
    expect(bar()).toHaveValue('');
    expect(bar()).toHaveFocus();
    expect(onPanelChange).toHaveBeenLastCalledWith(false);

    await user.keyboard('{Escape}');
    expect(note()).toHaveFocus();
  });

  it('closes on a tap outside it, on the scrim, emptied', async () => {
    const { user, onOpen, onPanelChange } = setup();
    await paste(user, inviteLink(ORIGIN, newInviteSeed()));

    await user.click(screen.getByTestId('link-bar-scrim'));

    expect(bar()).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onPanelChange).toHaveBeenLastCalledWith(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('leaves the keys alone while a modal dialog is open', async () => {
    const user = userEvent.setup();
    render(
      <>
        <LinkBar onOpen={vi.fn()} touch={false} />
        <div role="dialog" aria-modal="true" aria-label="Leave the group?">
          <button type="button">Stay</button>
        </div>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Stay' }));

    await user.keyboard('{Control>}l{/Control}');

    expect(screen.getByRole('button', { name: 'Stay' })).toHaveFocus();
  });

  describe('Paste, on a touch device', () => {
    it('shows on an empty, focused bar and reads the clipboard once, inside the tap', async () => {
      const link = followLink(ORIGIN, newInviteSeed());
      const readClipboard = vi.fn(() => Promise.resolve(link));
      const { user, onOpen } = setup({ touch: true, readClipboard });
      expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();

      await user.click(bar());
      expect(readClipboard).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Paste' }));

      expect(readClipboard).toHaveBeenCalledTimes(1);
      expect(bar()).toHaveValue(link);
      expect(bar()).toHaveFocus();
      expect(screen.getByRole('option')).toHaveTextContent('A coalition to follow');
      expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
      expect(await axeViolations()).toEqual([]);
    });

    it('points a pasted code to where it goes, keeping none of it', async () => {
      const code = linkCode(newLinkSeed(), newLinkKeys().publicKey);
      const { user } = setup({ touch: true, readClipboard: () => Promise.resolve(code) });

      await user.click(bar());
      await user.click(screen.getByRole('button', { name: 'Paste' }));

      expect(bar()).toHaveValue('');
      expect(screen.getByRole('link', { name: 'Link to my other device' })).toBeVisible();
      expect(document.body.innerHTML).not.toContain(code.slice(4));
    });

    it('stops offering Paste once the browser refuses', async () => {
      const readClipboard = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
      const { user } = setup({ touch: true, readClipboard });

      await user.click(bar());
      await user.click(screen.getByRole('button', { name: 'Paste' }));

      expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
      expect(bar()).toHaveValue('');
    });

    it.each([
      ['without a touch screen', { touch: false, readClipboard: vi.fn() }],
      ['where the browser can’t read the clipboard', { touch: true, readClipboard: null }],
    ])('isn’t offered %s', async (_name, props) => {
      const { user } = setup(props);

      await user.click(bar());

      expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
    });
  });
});
