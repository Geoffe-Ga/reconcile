import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { type Invite, invitePayload, newInvite } from '../app/invite';
import { axeViolations } from '../test/axe';
import { Join } from './Join';

const FOUND: FoundGroup = {
  groupId: 'group-1',
  name: 'Riverside Tenants',
  title: 'House rules',
  page: { records: [], cursor: 3, relayNow: 29_000_000, instance: 'relay' },
};

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

interface Options {
  readonly payload?: string | null;
  readonly heldInvite?: Invite | null;
  readonly lookup?: (invite: Invite) => Promise<InviteLookup>;
  readonly joined?: boolean;
}

function setup(options: Options = {}) {
  const invite = newInvite();
  const payload = options.payload === undefined ? invitePayload(invite) : options.payload;
  if (payload !== null) window.history.replaceState(null, '', `#/join/${payload}`);
  const found = (): Promise<InviteLookup> => Promise.resolve({ kind: 'found', group: FOUND });
  const lookup = vi.fn<(invite: Invite) => Promise<InviteLookup>>(options.lookup ?? found);
  const onJoin = vi.fn(() => Promise.resolve(options.joined ?? true));
  const { rerender } = render(
    <Join
      payload={payload}
      heldInvite={options.heldInvite ?? null}
      lookup={lookup}
      onJoin={onJoin}
    />,
  );
  return { user: userEvent.setup(), invite, payload, lookup, onJoin, rerender };
}

describe('Join', () => {
  it('takes the secret out of the address bar as soon as it has read it', () => {
    setup();
    expect(window.location.hash).toBe('#/join');
  });

  it('shows the group, then asks for a name, saying who will see it', async () => {
    const { invite, lookup } = setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Opening the invite…' })).toBeVisible();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]?.mailbox).toBe(invite.mailbox);
    expect(screen.getByText('House rules')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription(
      'This name is only shown in this group. It doesn’t have to be your real name.',
    );
    expect(
      screen.getByText('People in this group will see the name you choose and how you vote.'),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('joins under the name given, trimmed', async () => {
    const { user, invite, onJoin } = setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), '  Ben ');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({ mailbox: invite.mailbox }),
      FOUND,
      'Ben',
    );
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
    const invite = newInvite();
    window.history.replaceState(null, '', '#/join');
    render(
      <Join
        payload={null}
        heldInvite={invite}
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

  it('refuses a link whose mailbox holds no group', async () => {
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
      screen.getByText('This invite is for a group you joined on this device before.'),
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
    const next = newInvite();

    rerender(
      <Join payload={invitePayload(next)} heldInvite={null} lookup={lookup} onJoin={onJoin} />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]?.mailbox).toBe(next.mailbox);
  });

  it('reads the mailbox once per invite, even when handed a new lookup function', async () => {
    const { lookup, onJoin, rerender } = setup();
    await screen.findByRole('textbox', { name: 'Your name' });
    const next = vi.fn(() => Promise.resolve<InviteLookup>({ kind: 'missing' }));

    rerender(<Join payload={null} heldInvite={null} lookup={next} onJoin={onJoin} />);
    await screen.findByRole('textbox', { name: 'Your name' });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('opens an invite pasted on Start, which never touched the address bar', async () => {
    const held = newInvite();
    const { lookup } = setup({ payload: null, heldInvite: held });
    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup.mock.calls[0]?.[0]).toBe(held);
    expect(window.location.hash).toBe('#/');
  });
});
