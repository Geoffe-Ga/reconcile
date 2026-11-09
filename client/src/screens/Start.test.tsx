import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { inviteLink, newInvite } from '../app/invite';
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

  it('opens a pasted invite link', async () => {
    const user = userEvent.setup();
    const onOpenInvite = vi.fn();
    const invite = newInvite();
    render(<Start groups={[]} onOpenInvite={onOpenInvite} />);

    await user.click(screen.getByRole('textbox', { name: 'Invite link' }));
    await user.paste(inviteLink('https://reconcile.example', invite));
    await user.click(screen.getByRole('button', { name: 'Open invite' }));

    expect(onOpenInvite).toHaveBeenCalledTimes(1);
    expect(onOpenInvite.mock.calls[0]?.[0]).toMatchObject({ mailbox: invite.mailbox });
  });

  it('refuses text that isn’t an invite link, without repeating it back', async () => {
    const user = userEvent.setup();
    const onOpenInvite = vi.fn();
    render(<Start groups={GROUPS} onOpenInvite={onOpenInvite} />);

    const field = screen.getByRole('textbox', { name: 'Invite link' });
    await user.type(field, 'https://example.org/#/join/not-a-real-payload');
    await user.click(screen.getByRole('button', { name: 'Open invite' }));

    expect(onOpenInvite).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(
      'Paste the link someone in your group sent you. This isn’t a whole invite link. Copy all of it and paste it again.',
    );
    expect(document.body).not.toHaveTextContent('not-a-real-payload');
    expect(await axeViolations()).toEqual([]);
  });
});
