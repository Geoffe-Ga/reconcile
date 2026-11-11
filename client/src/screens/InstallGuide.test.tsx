import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { inviteLink } from '../app/invite';
import { newGroupSecret } from '../crypto/groupKeys';
import { newInviteSeed } from '../crypto/invite';
import type { DoorView } from '../door/page';
import { axeViolations } from '../test/axe';
import { type Arrival, InstallGuide } from './InstallGuide';

const ORIGIN = 'https://reconcile.example';

/** A new invite's seed, as Copy invite link makes one. */
function newInvite(): Uint8Array {
  return newInviteSeed();
}
const FOUND: FoundGroup = {
  groupId: 'group-1',
  preview: {
    groupName: 'Riverside Tenants',
    inviterName: 'Ana',
    documentTitle: 'House rules',
    excerpt: 'Quiet hours start at ten.',
  },
  secret: newGroupSecret(),
  epoch: 0,
  token: { by: 'a'.repeat(43), sig: 'b'.repeat(86) },
  cleared: [],
  page: { records: [], cursor: 3, relayNow: 29_000_000, instance: 'relay' },
};

interface Options {
  readonly arrival?: Arrival;
  readonly lookup?: (seed: Uint8Array) => Promise<InviteLookup>;
  readonly copy?: (text: string) => Promise<void>;
  readonly readDoor?: (address: Uint8Array) => Promise<DoorView>;
}

/** A front door's address, as its link carries it (#121). */
const ADDRESS = 'A'.repeat(42) + 'E';

/** The door's page, as its group's devices post it. */
const OPEN: DoorView = {
  kind: 'open',
  page: {
    v: 1,
    open: true,
    name: 'Riverside Tenants',
    excerpt: 'We keep rents fair.',
    count: 12,
    box: 'A'.repeat(43),
  },
};

function setup(options: Options = {}) {
  const found = (): Promise<InviteLookup> => Promise.resolve({ kind: 'found', group: FOUND });
  const lookup = vi.fn(options.lookup ?? found);
  const copyText = vi.fn(options.copy ?? (() => Promise.resolve()));
  const readDoor = vi.fn(options.readDoor ?? (() => Promise.resolve(OPEN)));
  render(
    <InstallGuide
      arrival={options.arrival ?? { kind: 'plain' }}
      origin={ORIGIN}
      lookup={lookup}
      copyText={copyText}
      readDoor={readDoor}
    />,
  );
  return { user: userEvent.setup(), lookup, copyText, readDoor };
}

/** The first text under the guide’s heading. */
function firstLine(): string | null | undefined {
  return screen.getByRole('main').querySelector('header + *')?.textContent;
}

describe('InstallGuide', () => {
  it('starts with the in-app line, then the Add to Home Screen steps', async () => {
    setup();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Add Reconcile to your Home Screen' }),
    ).toBeVisible();
    expect(firstLine()).toBe('If you opened this inside another app, open it in Safari first.');
    const steps = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Tap Share, or tap ••• and then Share.',
      'Choose Add to Home Screen, then tap Add.',
      'Open Reconcile from your Home Screen.',
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers the app’s address to copy on a plain visit, for leaving an in-app browser', async () => {
    const { user, copyText, lookup } = setup();
    const field = screen.getByRole('textbox', { name: 'Reconcile’s address' });
    expect(field).toHaveValue(`${ORIGIN}/`);
    expect(field).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyText).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied.');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('shows an invite’s preview, with no name field, and the link to copy', async () => {
    const invite = newInvite();
    const link = inviteLink(ORIGIN, invite);
    const { user, copyText, lookup } = setup({ arrival: { kind: 'invite', seed: invite } });

    const preview = await screen.findByRole('region', { name: 'Riverside Tenants' });
    expect(within(preview).getByText('You’re invited')).toBeVisible();
    expect(within(preview).getByText('House rules')).toBeVisible();
    expect(within(preview).getByText(/^From/)).toHaveTextContent('From Ana’s invite');
    expect(within(preview).getByText('Quiet hours start at ten.')).toBeVisible();
    expect(lookup).toHaveBeenCalledWith(invite);
    expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join group' })).not.toBeInTheDocument();

    const steps = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(steps.at(-1)).toHaveTextContent(
      'Open Reconcile from your Home Screen and tap Join with an invite link.',
    );
    const field = within(preview).getByRole('textbox', { name: 'Your invite link' });
    expect(field).toHaveValue(link);
    expect(field).toHaveAccessibleDescription(
      'Copy it now, then paste it into Reconcile once it’s on your Home Screen.',
    );
    await user.click(within(preview).getByRole('button', { name: 'Copy invite link' }));
    expect(copyText).toHaveBeenCalledWith(link);
    expect(await axeViolations()).toEqual([]);
  });

  it('selects the whole link when the field takes focus', async () => {
    const { user } = setup();
    const field = screen.getByRole('textbox', { name: 'Reconcile’s address' });
    await user.click(field);
    expect(field).toHaveProperty('selectionStart', 0);
    expect(field).toHaveProperty('selectionEnd', `${ORIGIN}/`.length);
  });

  it('says how to copy by hand when the browser blocks copying', async () => {
    const { user } = setup({ copy: () => Promise.reject(new Error('blocked')) });
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Copying is blocked here. Select the link above and copy it yourself.',
    );
  });

  it('still offers the invite link when the relay can’t be reached', async () => {
    const invite = newInvite();
    setup({
      arrival: { kind: 'invite', seed: invite },
      lookup: () => Promise.reject(new Error('down')),
    });
    const section = await screen.findByRole('region', { name: 'Your invite' });
    expect(within(section).getByRole('textbox', { name: 'Your invite link' })).toHaveValue(
      inviteLink(ORIGIN, invite),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    ['an expired link', { kind: 'invite', seed: newInvite() } as const, 'missing' as const],
    ['a damaged link', { kind: 'damaged' } as const, 'missing' as const],
  ])(
    'says %s has expired or is damaged, and offers only the app’s address',
    async (_name, arrival, kind) => {
      const { lookup } = setup({ arrival, lookup: () => Promise.resolve({ kind }) });
      expect(
        await screen.findByText(
          'This invite link has expired or is damaged. Ask someone in your group for a new one.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Your invite link' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Reconcile’s address' })).toHaveValue(
        `${ORIGIN}/`,
      );
      // With no working link, the steps end at opening the app.
      const steps = within(screen.getByRole('list')).getAllByRole('listitem');
      expect(steps.at(-1)).toHaveTextContent(/^Open Reconcile from your Home Screen\.$/);
      expect(lookup).toHaveBeenCalledTimes(arrival.kind === 'damaged' ? 0 : 1);
      expect(await axeViolations()).toEqual([]);
    },
  );

  it('says it is opening the invite while it looks', () => {
    setup({
      arrival: { kind: 'invite', seed: newInvite() },
      lookup: () => new Promise(() => undefined),
    });
    expect(screen.getByText('Opening the invite…')).toBeVisible();
  });
});

describe('InstallGuide with a front door’s link (#121)', () => {
  it('shows the page, then the link to copy into the installed app in place of the form', async () => {
    const { user, copyText, readDoor, lookup } = setup({
      arrival: { kind: 'door', payload: ADDRESS },
    });
    expect(await screen.findByRole('heading', { name: 'Riverside Tenants' })).toBeVisible();
    expect(screen.getByText('We keep rents fair.')).toBeVisible();
    expect(screen.getByText('12 people are in this group.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Name you’d like to use' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(
      screen.getByText('Open Reconcile from your Home Screen and tap Open the front door.'),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'This front door’s link' })).toHaveValue(
      `${ORIGIN}/#door/${ADDRESS}`,
    );
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyText).toHaveBeenCalledWith(`${ORIGIN}/#door/${ADDRESS}`);
    expect(readDoor).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a closed door is closed, with no link to it', async () => {
    setup({
      arrival: { kind: 'door', payload: ADDRESS },
      readDoor: () => Promise.resolve({ kind: 'closed' }),
    });
    expect(await screen.findByText('This front door is closed.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'This front door’s link' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Reconcile’s address' })).toBeVisible();
  });

  it('reads nothing for a damaged link', () => {
    const damaged = setup({ arrival: { kind: 'door', payload: 'abc' } });
    expect(
      screen.getByText('This front door link is damaged. Check you copied all of it.'),
    ).toBeVisible();
    expect(damaged.readDoor).not.toHaveBeenCalled();
  });

  it('offers the link with no page while the relay can’t be reached', async () => {
    setup({
      arrival: { kind: 'door', payload: ADDRESS },
      readDoor: () => Promise.reject(new Error('offline')),
    });
    expect(await screen.findByRole('textbox', { name: 'This front door’s link' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Riverside Tenants' })).toBeNull();
  });
});
