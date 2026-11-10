import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { inviteLink } from '../app/invite';
import { newInviteSeed } from '../crypto/invite';
import { axeViolations } from '../test/axe';
import { Start, type StartGroup } from './Start';

const GROUPS: StartGroup[] = [
  { groupId: 'group-one', name: 'Riverside Tenants', title: 'House rules' },
  { groupId: 'group-two', name: 'Book club', title: 'What we read' },
];

describe('Start', () => {
  it('lists the groups on this device, each linking to its Group home', async () => {
    render(<Start groups={GROUPS} onOpenInvite={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Your groups' })).toBeInTheDocument();
    const items = within(screen.getByRole('list')).getAllByRole('link');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('href', '#/g/group-one');
    expect(items[0]).toHaveTextContent('Riverside Tenants');
    expect(items[0]).toHaveTextContent('Document: House rules');
    expect(items[1]).toHaveAttribute('href', '#/g/group-two');
    expect(await axeViolations()).toEqual([]);
  });

  it('says so in one sentence when there are no groups yet, and offers Create group', async () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('You aren’t in any groups on this device yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create group' })).toHaveAttribute('href', '#/create');
    expect(await axeViolations()).toEqual([]);
  });

  it('names a group whose founding event hasn’t reached the relay yet', () => {
    render(<Start groups={[{ groupId: 'g', name: null, title: null }]} onOpenInvite={vi.fn()} />);
    expect(screen.getByRole('link', { name: /Waiting for the relay/ })).toHaveAttribute(
      'href',
      '#/g/g',
    );
  });

  it('opens a pasted invite link, trimmed, from Join with an invite link', async () => {
    const user = userEvent.setup();
    const onOpenInvite = vi.fn();
    const seed = newInviteSeed();
    render(<Start groups={[]} onOpenInvite={onOpenInvite} />);

    await user.click(screen.getByRole('textbox', { name: 'Invite link' }));
    await user.paste(`  ${inviteLink('https://reconcile.example', seed)}\n`);
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));

    expect(onOpenInvite).toHaveBeenCalledTimes(1);
    expect(Array.from(onOpenInvite.mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(seed));
  });

  it('never reads the clipboard on its own', async () => {
    const user = userEvent.setup();
    const readText = vi.spyOn(navigator.clipboard, 'readText');
    const read = vi.spyOn(navigator.clipboard, 'read');
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);
    await user.click(screen.getByRole('textbox', { name: 'Invite link' }));
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));
    expect(readText).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('says a malformed link has expired or is damaged, without repeating it back', async () => {
    const user = userEvent.setup();
    const onOpenInvite = vi.fn();
    render(<Start groups={GROUPS} onOpenInvite={onOpenInvite} />);

    const field = screen.getByRole('textbox', { name: 'Invite link' });
    await user.type(field, 'https://example.org/#/join/not-a-real-payload');
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));

    expect(onOpenInvite).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(
      'Paste the link someone in your group sent you. This invite link has expired or is damaged. Ask someone in your group for a new one.',
    );
    expect(document.body).not.toHaveTextContent('not-a-real-payload');
    expect(await axeViolations()).toEqual([]);
  });

  it.each(['denied', 'unavailable'] as const)(
    'says quietly that the browser may clear its data when persistence is %s',
    async (persistence) => {
      render(<Start groups={[]} onOpenInvite={vi.fn()} persistence={persistence} />);
      expect(
        screen.getByText(
          'This browser may clear Reconcile’s data if the device runs low on space.',
        ),
      ).toBeVisible();
      expect(await axeViolations()).toEqual([]);
    },
  );

  it.each(['granted', null] as const)(
    'says nothing about storage when persistence is %s',
    (persistence) => {
      render(<Start groups={[]} onOpenInvite={vi.fn()} persistence={persistence} />);
      expect(screen.queryByText(/may clear Reconcile’s data/)).not.toBeInTheDocument();
    },
  );
});
