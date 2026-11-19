import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

  it('shows the shelf’s removal lines after the alert, above the groups (#491)', () => {
    render(
      <Start
        groups={GROUPS}
        onOpenInvite={vi.fn()}
        alert={<p data-testid="alert">A recovery is waiting.</p>}
        removals={<p data-testid="removals">A group you asked to join was removed.</p>}
      />,
    );
    const alert = screen.getByTestId('alert');
    const removals = screen.getByTestId('removals');
    const list = screen.getByRole('list');
    expect(alert.compareDocumentPosition(removals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(removals.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('points to the link bar for an invite or any other link, with no field of its own (#444)', async () => {
    render(<Start groups={GROUPS} onOpenInvite={vi.fn()} />);

    const section = screen.getByRole('region', { name: 'Have an invite link?' });
    expect(section).toHaveTextContent('Paste it, or any Reconcile link, into the bar at the top.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join with an invite link' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Have a front door link?' })).toBeNull();
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
  });
});

describe('Start: following (#124)', () => {
  const FOLLOWING = [
    {
      coalitionId: 'coalition-1',
      name: '<b>Eastside</b> Housing',
      groups: ['Riverside Tenants', 'Oak St Co-op'],
    },
  ];

  it('lists each coalition this device follows, with its member groups, opening its home', async () => {
    render(<Start groups={GROUPS} following={FOLLOWING} onOpenInvite={vi.fn()} />);

    const section = screen.getByRole('region', { name: 'Following' });
    const link = within(section).getByRole('link');
    expect(link).toHaveAttribute('href', '#/c/coalition-1');
    expect(link).toHaveTextContent('<b>Eastside</b> Housing');
    expect(link.querySelector('b')).toBeNull();
    const groups = Array.from(
      link.querySelectorAll('.following-groups bdi'),
      (bdi) => bdi.textContent,
    );
    expect(groups).toEqual(['Riverside Tenants', 'Oak St Co-op']);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no Following until this device follows a coalition', () => {
    render(<Start groups={GROUPS} following={[]} onOpenInvite={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Following' })).not.toBeInTheDocument();
  });
});

describe('Start: a new version (#513)', () => {
  const READY = 'A new version is ready. Close and reopen Reconcile.';

  it('says a new version is ready in one quiet line just above Settings, and passes axe', async () => {
    render(<Start groups={GROUPS} onOpenInvite={vi.fn()} newVersionReady />);
    const line = screen.getByText(READY);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveClass('caption');
    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(line.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing of versions while none waits', () => {
    render(<Start groups={GROUPS} onOpenInvite={vi.fn()} />);
    expect(screen.queryByText(READY)).toBeNull();
  });
});
