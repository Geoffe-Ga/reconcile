import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { inviteLink } from '../app/invite';
import { newInviteSeed } from '../crypto/invite';
import { axeViolations } from '../test/axe';
import { Start, type StartGroup } from './Start';

const GROUPS: StartGroup[] = [
  { groupId: 'group-one', name: 'Riverside Tenants', title: 'House rules', leaving: false },
  { groupId: 'group-two', name: 'Book club', title: 'What we read', leaving: false },
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

  it('offers Link to my other device, for a device that joins by another one’s code (#96)', async () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);

    const section = screen.getByRole('region', { name: 'Have Reconcile on another device?' });
    expect(within(section).getByRole('link', { name: 'Link to my other device' })).toHaveAttribute(
      'href',
      '#/link-this',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Recover with my contacts, for someone who has lost every device (#118)', async () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);

    const section = screen.getByRole('region', { name: 'Lost every device?' });
    expect(within(section).getByRole('link', { name: 'Recover with my contacts' })).toHaveAttribute(
      'href',
      '#/recover',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a recovery alert first, above the groups (#118)', () => {
    render(
      <Start
        groups={GROUPS}
        onOpenInvite={vi.fn()}
        alert={<p data-testid="alert">A recovery is waiting.</p>}
      />,
    );
    const alert = screen.getByTestId('alert');
    const list = screen.getByRole('list');
    expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists every group on the device by name, however many there are', () => {
    const names = ['Riverside Tenants', 'Book club', 'Allotment society', 'Choir'];
    const groups = names.map((name, i) => ({
      groupId: `group-${String(i)}`,
      name,
      title: 'Our rules',
      leaving: false,
    }));
    render(<Start groups={groups} onOpenInvite={vi.fn()} />);
    const titles = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.querySelector('bdi')?.textContent);
    expect(titles).toEqual(names);
  });

  it('marks a group whose leave waits for the relay as leaving', async () => {
    const [first, second] = GROUPS as [StartGroup, StartGroup];
    render(<Start groups={[{ ...first, leaving: true }, second]} onOpenInvite={vi.fn()} />);
    const [leaving, staying] = within(screen.getByRole('list')).getAllByRole('link');
    expect(within(leaving as HTMLElement).getByText('Leaving…')).toBeVisible();
    expect(leaving).toHaveTextContent('Riverside Tenants');
    expect(staying).not.toHaveTextContent('Leaving…');
    expect(await axeViolations()).toEqual([]);
  });

  it('says so in one sentence when there are no groups yet, and offers Create group', async () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('You aren’t in any groups on this device yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create group' })).toHaveAttribute('href', '#/create');
    expect(await axeViolations()).toEqual([]);
  });

  it('opens Personal (#93) from one card after the groups, whether or not there are any', async () => {
    for (const groups of [[], GROUPS]) {
      const { unmount } = render(<Start groups={groups} onOpenInvite={vi.fn()} />);
      const personal = screen.getByRole('link', { name: /^Personal/ });
      expect(personal).toHaveAttribute('href', '#/me');
      expect(personal).toHaveTextContent(
        'Your mission statement and other Documents of your own, on this device only.',
      );
      const create = screen.getByRole('link', { name: 'Create group' });
      expect(create.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(
        screen
          .queryAllByRole('list')
          .flatMap((list) => within(list).queryAllByRole('link', { name: /^Personal/ })),
      ).toEqual([]);
      expect(await axeViolations()).toEqual([]);
      unmount();
    }
  });

  it('names a group whose founding event hasn’t reached the relay yet', () => {
    render(
      <Start
        groups={[{ groupId: 'g', name: null, title: null, leaving: false }]}
        onOpenInvite={vi.fn()}
      />,
    );
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

describe('Start: front doors (#121)', () => {
  const SENT_AT = Date.UTC(2026, 10, 11, 12);
  const INVITE = new Uint8Array(32).fill(7);
  const ADDRESS = `${'A'.repeat(42)}E`;

  it('lists each request this device sent, then “<group> invited you” and the way into Join', async () => {
    const user = userEvent.setup();
    const onOpenInvite = vi.fn();
    render(
      <Start
        groups={[]}
        requests={[
          { id: 'a', groupName: 'Riverside Tenants', sentAt: SENT_AT, invite: null },
          { id: 'b', groupName: 'Book club', sentAt: SENT_AT, invite: INVITE },
        ]}
        onOpenInvite={onOpenInvite}
        onOpenDoor={vi.fn()}
      />,
    );
    const asked = screen.getByRole('region', { name: 'Asked to join' });
    const [waiting, invited] = within(asked).getAllByRole('listitem');
    expect(waiting).toHaveTextContent(/^Riverside TenantsAsked \w{3} 11 Nov\. No invite yet\.$/);
    expect(invited?.querySelector('.request-invited')?.textContent).toBe('Book club invited you');
    expect(within(waiting ?? asked).queryByRole('button')).toBeNull();
    await user.click(within(asked).getByRole('button', { name: 'Open your invite' }));
    expect(onOpenInvite).toHaveBeenCalledWith(INVITE);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no requests section until this device has asked somewhere', () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Asked to join' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Have a front door link?' })).toBeNull();
  });

  it('opens a pasted front door link, from any origin, and refuses anything else', async () => {
    const user = userEvent.setup();
    const onOpenDoor = vi.fn();
    render(<Start groups={[]} onOpenInvite={vi.fn()} onOpenDoor={onOpenDoor} />);
    const section = screen.getByRole('region', { name: 'Have a front door link?' });
    const field = within(section).getByRole('textbox', { name: 'Front door link' });
    await user.click(field);
    await user.paste(inviteLink('https://elsewhere.example', newInviteSeed()));
    await user.click(within(section).getByRole('button', { name: 'Open the front door' }));
    expect(
      within(section).getByText('This isn’t a front door link. Check you copied all of it.'),
    ).toBeVisible();
    expect(onOpenDoor).not.toHaveBeenCalled();
    await user.clear(field);
    await user.paste(`https://elsewhere.example/#door/${ADDRESS}`);
    await user.click(within(section).getByRole('button', { name: 'Open the front door' }));
    expect(onOpenDoor).toHaveBeenCalledWith(ADDRESS);
    expect(await axeViolations()).toEqual([]);
  });
});
