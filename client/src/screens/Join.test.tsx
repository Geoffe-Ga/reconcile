import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { newGroupSecret } from '../crypto/groupKeys';
import { newInviteSeed } from '../crypto/invite';
import { DEFAULT_JOIN_LEVEL, LEVELS } from '../engine/capabilities';
import { base64url } from '../engine/event';
import { axeViolations } from '../test/axe';
import { Join } from './Join';

const PREVIEW = {
  groupName: 'Riverside Tenants',
  inviterName: 'Ana',
  documentTitle: 'House rules',
  excerpt: 'Quiet hours start at ten.',
};

const FOUND: FoundGroup = {
  groupId: 'group-1',
  preview: PREVIEW,
  secret: newGroupSecret(),
  token: { by: 'a'.repeat(43), sig: 'b'.repeat(86) },
  cleared: [],
  page: { records: [], cursor: 3, relayNow: 29_000_000, instance: 'relay' },
};

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

type Lookup = (seed: Uint8Array) => Promise<InviteLookup>;

interface Options {
  readonly payload?: string | null;
  readonly heldSeed?: Uint8Array | null;
  readonly lookup?: Lookup;
  readonly joined?: boolean;
}

function setup(options: Options = {}) {
  const seed = newInviteSeed();
  const payload = options.payload === undefined ? base64url(seed) : options.payload;
  if (payload !== null) window.history.replaceState(null, '', `#join/${payload}`);
  const found = (): Promise<InviteLookup> => Promise.resolve({ kind: 'found', group: FOUND });
  const lookup = vi.fn<Lookup>(options.lookup ?? found);
  const onJoin = vi.fn(() => Promise.resolve(options.joined ?? true));
  const { rerender } = render(
    <Join payload={payload} heldSeed={options.heldSeed ?? null} lookup={lookup} onJoin={onJoin} />,
  );
  return { user: userEvent.setup(), seed, payload, lookup, onJoin, rerender };
}

describe('Join', () => {
  it('takes the seed out of the address bar as soon as it has read it', () => {
    setup();
    expect(window.location.hash).toBe('#/join');
  });

  it('shows the preview from the inviter, then asks for a name, saying who will see it', async () => {
    const { seed, lookup } = setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Opening the invite…' })).toBeVisible();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(Array.from(lookup.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(seed));
    expect(screen.getByText(/^From/)).toHaveTextContent('From Ana’s invite');
    expect(screen.getByText('House rules')).toBeVisible();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription(
      'This name is only shown in this group. It doesn’t have to be your real name.',
    );
    expect(
      screen.getByText(
        'People in this group will see the name you choose and how you vote, until 30 days after each decision.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('joins under the name given, trimmed, as a Collaborator unless they choose otherwise', async () => {
    const { user, onJoin } = setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), '  Ben ');
    expect(screen.getByRole('radio', { name: 'Collaborator' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).toHaveBeenCalledWith(FOUND, 'Ben', DEFAULT_JOIN_LEVEL);
  });

  it.each([
    ['Member', 0],
    ['Co-Creator', 2],
  ] as const)('joins as a %s when they choose it', async (name, index) => {
    const { user, onJoin } = setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('radio', { name }));
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).toHaveBeenCalledExactlyOnceWith(FOUND, 'Ben', LEVELS[index]);
  });

  it('asks how involved they want to be, after their name and before who sees it', async () => {
    setup();
    const name = await screen.findByRole('textbox', { name: 'Your name' });
    const picker = screen.getByRole('radiogroup', { name: 'Your involvement' });
    const visibility = screen.getByText(
      'People in this group will see the name you choose and how you vote, until 30 days after each decision.',
    );
    expect(name.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      picker.compareDocumentPosition(visibility) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(await axeViolations()).toEqual([]);
  });

  it('joins once, however often the button is pressed while it works', async () => {
    const user = userEvent.setup();
    let finish: (joined: boolean) => void = () => undefined;
    const onJoin = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    window.history.replaceState(null, '', '#/join');
    render(
      <Join
        payload={null}
        heldSeed={newInviteSeed()}
        lookup={() => Promise.resolve({ kind: 'found', group: FOUND })}
        onJoin={onJoin}
      />,
    );
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    finish(false);
    await screen.findByRole('alert');
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('asks for a name before joining', async () => {
    const { user, onJoin } = setup();
    const name = await screen.findByRole('textbox', { name: 'Your name' });
    await user.type(name, '   ');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when joining doesn’t finish', async () => {
    const { user } = setup({ joined: false });
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Joining didn’t finish. Try again.');
  });

  it.each([
    ['a damaged link', 'not-an-invite.payload'],
    ['a seed cut short', 'not-an-invite'.padEnd(42, 'A')],
    ['a seed with stray bits', `not-an-invite${'A'.repeat(29)}B`],
    ['no link at all', null],
  ])('refuses %s plainly, without fetching or repeating it', async (_label, payload) => {
    const { lookup } = setup({ payload });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This invite link doesn’t work' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This invite link has expired or is damaged. Ask someone in your group for a new one.',
      ),
    ).toBeVisible();
    expect(lookup).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('not-an-invite');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses an expired or damaged envelope with the same line, and no name field', async () => {
    setup({ lookup: () => Promise.resolve({ kind: 'missing' }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This invite link doesn’t work' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers to try again when the relay is out of reach', async () => {
    let calls = 0;
    const { user, lookup } = setup({
      lookup: () =>
        Promise.resolve(calls++ === 0 ? { kind: 'offline' } : { kind: 'found', group: FOUND }),
    });
    expect(
      await screen.findByText(
        'Can’t reach the relay right now. Check your connection, then try again.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('treats a failed lookup as out of reach', async () => {
    setup({ lookup: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('points a member to their group instead of joining twice', async () => {
    setup({ lookup: () => Promise.resolve({ kind: 'joined', groupId: 'group-1' }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You’re already in this group' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This invite is for a group you’re already in on this device. Anything this device was missing from its history is here now.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open your group' })).toHaveAttribute(
      'href',
      '#/g/group-1',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens a new invite that arrives while Join is showing', async () => {
    const { lookup, onJoin, rerender } = setup({ payload: 'damaged' });
    expect(screen.getByRole('heading', { name: 'This invite link doesn’t work' })).toBeVisible();
    const next = newInviteSeed();

    rerender(<Join payload={base64url(next)} heldSeed={null} lookup={lookup} onJoin={onJoin} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(Array.from(lookup.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(next));
  });

  it('reads the mailbox once per invite, even when handed a new lookup function', async () => {
    const { lookup, onJoin, rerender } = setup();
    await screen.findByRole('textbox', { name: 'Your name' });
    const next = vi.fn(() => Promise.resolve<InviteLookup>({ kind: 'missing' }));

    rerender(<Join payload={null} heldSeed={null} lookup={next} onJoin={onJoin} />);
    await screen.findByRole('textbox', { name: 'Your name' });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('shows a preview’s markup and script-like text as the plain text it is', async () => {
    const preview = {
      groupName: '<img src=x onerror="alert(1)">',
      inviterName: '**Ana**',
      documentTitle: '<script>alert(1)</script>',
      excerpt: '[x](javascript:alert(1)) <b>bold</b>',
    };
    const group = { ...FOUND, preview };
    setup({ lookup: () => Promise.resolve({ kind: 'found', group }) });

    expect(await screen.findByRole('heading', { level: 1, name: preview.groupName })).toBeVisible();
    expect(screen.getByText(/^From/)).toHaveTextContent(`From **Ana**’s invite`);
    expect(screen.getByText(preview.documentTitle)).toBeVisible();
    expect(screen.getByText(preview.excerpt)).toBeVisible();
    expect(document.querySelector('main img, main script, main b, main strong')).toBeNull();
    expect(document.querySelector('main a[href^="javascript"]')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens an invite pasted on Start, which never touched the address bar', async () => {
    const held = newInviteSeed();
    const { lookup } = setup({ payload: null, heldSeed: held });
    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup.mock.calls[0]?.[0]).toBe(held);
    expect(window.location.hash).toBe('#/');
  });
});
